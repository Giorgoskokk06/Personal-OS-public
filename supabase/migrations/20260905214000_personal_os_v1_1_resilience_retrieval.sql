-- Personal OS v1.1
-- Routing resilience + retrieval quality + current-state auditability.
-- Forward-only migration. DO NOT reset the linked database.

-- =========================================================
-- 1. Persisted model circuit state
-- =========================================================
create table if not exists public.model_route_state (
  provider text not null,
  model text not null,
  circuit_state text not null default 'closed'
    check (circuit_state in ('closed','open')),
  blocked_until timestamptz,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  last_error_code text,
  last_error_kind text,
  last_error_at timestamptz,
  last_success_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider, model)
);

create index if not exists model_route_state_blocked_idx
on public.model_route_state(provider, blocked_until);

alter table public.model_route_state enable row level security;

-- =========================================================
-- 2. Current-state history
-- Current state is hot context and must be auditable because a stale
-- or inferred value can otherwise contaminate many unrelated answers.
-- =========================================================
create table if not exists public.current_state_history (
  id uuid primary key default gen_random_uuid(),
  current_state_id uuid not null references public.current_state(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  snapshot jsonb not null,
  changed_at timestamptz not null default now()
);

create index if not exists current_state_history_state_idx
on public.current_state_history(current_state_id, changed_at desc);

alter table public.current_state_history enable row level security;

create or replace function public.capture_current_state_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.current_state_history(current_state_id, user_id, snapshot)
  values (old.id, old.user_id, to_jsonb(old));
  return new;
end;
$$;

drop trigger if exists current_state_capture_history on public.current_state;
create trigger current_state_capture_history
before update on public.current_state
for each row execute function public.capture_current_state_history();

-- =========================================================
-- 3. Canonical record retrieval v3
-- RCA addressed here:
-- - v1 lexical retrieval used websearch_to_tsquery, which effectively
--   over-constrained natural-language queries.
-- - sensitive --no-embed records then had no semantic fallback.
-- - semantic/recency weighting could surface high-importance but
--   out-of-context records.
-- v3 makes actual relevance dominate ranking.
-- =========================================================
create or replace function public.match_records_hybrid_v3(
  p_user_id uuid,
  p_query_text text,
  p_query_embedding vector(768),
  p_domain_hints text[] default '{}'::text[],
  p_match_count integer default 16,
  p_min_similarity real default 0.20
)
returns table (
  id uuid,
  record_type text,
  domains text[],
  title text,
  body text,
  status text,
  fact_state text,
  knowledge_status text,
  confidence real,
  importance real,
  authority_level smallint,
  occurred_at timestamptz,
  due_at timestamptz,
  data jsonb,
  similarity real,
  lexical_score real,
  entity_score real,
  domain_score real,
  score real
)
language sql
stable
as $$
with q as (
  select coalesce(
    array(
      select distinct term
      from unnest(tsvector_to_array(to_tsvector('simple'::regconfig, coalesce(p_query_text,'')))) as term
      where char_length(term) >= 3
        and term <> all(array[
          'the','and','for','with','what','who','how','about','from','this','that','you','your','know','remember','tell','me',
          'και','για','μου','σου','του','της','των','στο','στη','στην','απο','από','πως','πώς','τι','ποιο','ποια','ποιες',
          'ξερεις','ξέρεις','θυμασαι','θυμάσαι','ειναι','είναι','εχω','έχω','πες','μενα','μένα'
        ]::text[])
    ),
    '{}'::text[]
  ) as terms
),
record_text as (
  select
    r.*,
    to_tsvector(
      'simple'::regconfig,
      coalesce(r.title,'') || ' ' ||
      coalesce(r.body,'') || ' ' ||
      coalesce(array_to_string(r.domains, ' '),'') || ' ' ||
      coalesce(r.data::text,'')
    ) as expanded_tsv
  from public.records r
  where r.user_id = p_user_id
    and r.status not in ('deleted','superseded')
    and r.knowledge_status <> 'superseded'
),
semantic as (
  select r.id, (1 - (r.embedding <=> p_query_embedding))::real as sim
  from record_text r
  where p_query_embedding is not null
    and r.embedding is not null
  order by r.embedding <=> p_query_embedding
  limit greatest(p_match_count * 4, 32)
),
lexical as (
  select
    r.id,
    least(
      (
        select count(*)::real
        from unnest(q.terms) as term
        where r.expanded_tsv @@ plainto_tsquery('simple'::regconfig, term)
      ) / greatest(least(cardinality(q.terms), 6), 1)::real,
      1.0
    )::real as lex,
    greatest(
      coalesce((
        select max(case
          when lower(coalesce(r.title,'')) like '%' || lower(term) || '%' then 1.0
          when lower(coalesce(r.body,'')) like '%' || lower(term) || '%' then 0.65
          else 0.0 end)
        from unnest(q.terms) as term
      ), 0.0),
      0.0
    )::real as ent
  from record_text r
  cross join q
  where cardinality(q.terms) > 0
    and exists (
      select 1
      from unnest(q.terms) as term
      where r.expanded_tsv @@ plainto_tsquery('simple'::regconfig, term)
         or lower(coalesce(r.title,'')) like '%' || lower(term) || '%'
    )
),
candidate_ids as (
  select id from semantic
  union
  select id from lexical
),
scored as (
  select
    r.*,
    coalesce(s.sim, 0)::real as sim,
    coalesce(l.lex, 0)::real as lex,
    coalesce(l.ent, 0)::real as ent,
    case
      when cardinality(coalesce(p_domain_hints, '{}'::text[])) = 0 then 0.0
      when r.domains && p_domain_hints then 1.0
      else 0.0
    end::real as dom,
    case r.knowledge_status
      when 'verified_official' then 1.05
      when 'confirmed' then 1.00
      when 'reported' then 0.96
      when 'observed' then 0.92
      when 'disputed' then 0.72
      when 'hypothesis' then 0.60
      else 0.85
    end::real as knowledge_factor
  from candidate_ids c
  join record_text r on r.id = c.id
  left join semantic s on s.id = r.id
  left join lexical l on l.id = r.id
)
select
  s.id,
  s.record_type,
  s.domains,
  s.title,
  s.body,
  s.status,
  s.fact_state,
  s.knowledge_status,
  s.confidence,
  s.importance,
  s.authority_level,
  s.occurred_at,
  s.due_at,
  s.data,
  s.sim as similarity,
  s.lex as lexical_score,
  s.ent as entity_score,
  s.dom as domain_score,
  (
    (
      greatest(s.sim, 0) * 0.48
      + s.lex * 0.25
      + s.ent * 0.13
      + s.dom * 0.07
      + s.importance * 0.025
      + s.confidence * 0.015
      + (s.authority_level::real / 100.0) * 0.02
      + exp(-extract(epoch from (now() - s.updated_at)) / 15552000.0)::real * 0.01
    ) * s.knowledge_factor
    * case
        when cardinality(coalesce(p_domain_hints, '{}'::text[])) > 0
          and not (s.domains && p_domain_hints)
          and s.lex < 0.34
          and s.ent = 0
        then 0.65
        else 1.0
      end
  )::real as score
from scored s
where s.sim >= p_min_similarity
   or s.lex > 0
   or s.ent > 0
order by score desc
limit p_match_count;
$$;

-- =========================================================
-- 4. Source-chunk retrieval v3
-- No-embed sensitive sources remain lexically retrievable.
-- =========================================================
create or replace function public.match_source_chunks_hybrid_v3(
  p_user_id uuid,
  p_query_text text,
  p_query_embedding vector(768),
  p_match_count integer default 6,
  p_min_similarity real default 0.20
)
returns table (
  id uuid,
  source_document_id uuid,
  document_title text,
  source_type text,
  authority_level smallint,
  heading text,
  content text,
  similarity real,
  lexical_score real,
  entity_score real,
  score real
)
language sql
stable
as $$
with q as (
  select coalesce(
    array(
      select distinct term
      from unnest(tsvector_to_array(to_tsvector('simple'::regconfig, coalesce(p_query_text,'')))) as term
      where char_length(term) >= 3
        and term <> all(array[
          'the','and','for','with','what','who','how','about','from','this','that','you','your','know','remember','tell','me',
          'και','για','μου','σου','του','της','των','στο','στη','στην','απο','από','πως','πώς','τι','ποιο','ποια','ποιες',
          'ξερεις','ξέρεις','θυμασαι','θυμάσαι','ειναι','είναι','εχω','έχω','πες','μενα','μένα'
        ]::text[])
    ), '{}'::text[]
  ) as terms
),
chunk_text as (
  select
    c.*,
    d.user_id,
    d.title as document_title,
    d.source_type,
    d.authority_level,
    d.sensitivity,
    to_tsvector(
      'simple'::regconfig,
      coalesce(d.title,'') || ' ' || coalesce(c.heading,'') || ' ' || coalesce(c.content,'')
    ) as expanded_tsv
  from public.source_chunks c
  join public.source_documents d on d.id = c.source_document_id
  where d.user_id = p_user_id
    and d.sensitivity not in ('work_confidential','restricted')
),
semantic as (
  select c.id, (1 - (c.embedding <=> p_query_embedding))::real as sim
  from chunk_text c
  where p_query_embedding is not null and c.embedding is not null
  order by c.embedding <=> p_query_embedding
  limit greatest(p_match_count * 5, 30)
),
lexical as (
  select
    c.id,
    least((
      select count(*)::real
      from unnest(q.terms) as term
      where c.expanded_tsv @@ plainto_tsquery('simple'::regconfig, term)
    ) / greatest(least(cardinality(q.terms), 6), 1)::real, 1.0)::real as lex,
    greatest(coalesce((
      select max(case
        when lower(coalesce(c.document_title,'')) like '%' || lower(term) || '%' then 1.0
        when lower(coalesce(c.heading,'')) like '%' || lower(term) || '%' then 0.9
        when lower(coalesce(c.content,'')) like '%' || lower(term) || '%' then 0.55
        else 0.0 end)
      from unnest(q.terms) as term
    ), 0.0), 0.0)::real as ent
  from chunk_text c
  cross join q
  where cardinality(q.terms) > 0
    and exists (
      select 1 from unnest(q.terms) as term
      where c.expanded_tsv @@ plainto_tsquery('simple'::regconfig, term)
         or lower(coalesce(c.document_title,'')) like '%' || lower(term) || '%'
         or lower(coalesce(c.heading,'')) like '%' || lower(term) || '%'
    )
),
candidate_ids as (
  select id from semantic
  union
  select id from lexical
)
select
  c.id,
  c.source_document_id,
  c.document_title,
  c.source_type,
  c.authority_level,
  c.heading,
  c.content,
  coalesce(s.sim, 0)::real as similarity,
  coalesce(l.lex, 0)::real as lexical_score,
  coalesce(l.ent, 0)::real as entity_score,
  (
    greatest(coalesce(s.sim, 0), 0) * 0.53
    + coalesce(l.lex, 0) * 0.25
    + coalesce(l.ent, 0) * 0.12
    + (c.authority_level::real / 100.0) * 0.10
  )::real as score
from candidate_ids x
join chunk_text c on c.id = x.id
left join semantic s on s.id = c.id
left join lexical l on l.id = c.id
where coalesce(s.sim, 0) >= p_min_similarity
   or coalesce(l.lex, 0) > 0
   or coalesce(l.ent, 0) > 0
order by score desc
limit p_match_count;
$$;

-- =========================================================
-- 5. Diversified profile retrieval
-- Generic queries such as "what do you know about me?" should not rely
-- on a vague embedding. They need intentional coverage across domains.
-- =========================================================
create or replace function public.profile_records_v1(
  p_user_id uuid,
  p_match_count integer default 28,
  p_per_domain integer default 3
)
returns table (
  id uuid,
  record_type text,
  domains text[],
  title text,
  body text,
  status text,
  fact_state text,
  knowledge_status text,
  confidence real,
  importance real,
  authority_level smallint,
  occurred_at timestamptz,
  due_at timestamptz,
  data jsonb,
  similarity real,
  lexical_score real,
  entity_score real,
  domain_score real,
  score real
)
language sql
stable
as $$
with base as (
  select
    r.*,
    coalesce(r.domains[1], r.record_type, 'other') as primary_domain,
    (
      r.importance * 0.34
      + r.confidence * 0.20
      + (r.authority_level::real / 100.0) * 0.28
      + case r.knowledge_status
          when 'verified_official' then 0.12
          when 'confirmed' then 0.11
          when 'reported' then 0.08
          when 'observed' then 0.06
          when 'disputed' then 0.02
          when 'hypothesis' then 0.00
          else 0.04
        end
      + exp(-extract(epoch from (now() - r.updated_at)) / 31536000.0)::real * 0.06
    )::real as profile_score
  from public.records r
  where r.user_id = p_user_id
    and r.status not in ('deleted','superseded')
    and r.knowledge_status <> 'superseded'
),
ranked as (
  select b.*, row_number() over (
    partition by b.primary_domain
    order by b.profile_score desc, b.updated_at desc
  ) as domain_rank
  from base b
)
select
  r.id,
  r.record_type,
  r.domains,
  r.title,
  r.body,
  r.status,
  r.fact_state,
  r.knowledge_status,
  r.confidence,
  r.importance,
  r.authority_level,
  r.occurred_at,
  r.due_at,
  r.data,
  0::real as similarity,
  0::real as lexical_score,
  0::real as entity_score,
  0::real as domain_score,
  r.profile_score as score
from ranked r
where r.domain_rank <= greatest(p_per_domain, 1)
order by r.profile_score desc
limit p_match_count;
$$;
