-- Personal OS v1.1 hardening
-- Entity-centric memory graph + historical evidence scopes + retrieval v4 + provider circuits.
-- Forward-only. Never use db reset on production data.

-- =========================================================
-- 1. First-class memory entities
-- A person/project/org is one entity; events, decisions, preferences and
-- relationship status records are facts linked to that entity.
-- =========================================================
create table if not exists public.memory_entities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  entity_type text not null default 'other'
    check (entity_type in ('person','organization','project','place','other')),
  canonical_name text not null,
  normalized_key text not null,
  aliases text[] not null default '{}'::text[],
  domains text[] not null default '{}'::text[],
  status text not null default 'active',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, entity_type, normalized_key)
);

create index if not exists memory_entities_user_name_idx
on public.memory_entities(user_id, normalized_key);

create index if not exists memory_entities_aliases_idx
on public.memory_entities using gin(aliases);

create index if not exists memory_entities_domains_idx
on public.memory_entities using gin(domains);

alter table public.memory_entities enable row level security;

create table if not exists public.record_entities (
  record_id uuid not null references public.records(id) on delete cascade,
  entity_id uuid not null references public.memory_entities(id) on delete cascade,
  relation_type text not null default 'related',
  confidence real not null default 1.0 check (confidence between 0 and 1),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key(record_id, entity_id, relation_type)
);

create index if not exists record_entities_entity_idx
on public.record_entities(entity_id, relation_type);

alter table public.record_entities enable row level security;

create table if not exists public.source_chunk_entities (
  source_chunk_id uuid not null references public.source_chunks(id) on delete cascade,
  entity_id uuid not null references public.memory_entities(id) on delete cascade,
  relation_type text not null default 'mentioned',
  confidence real not null default 1.0 check (confidence between 0 and 1),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key(source_chunk_id, entity_id, relation_type)
);

create index if not exists source_chunk_entities_entity_idx
on public.source_chunk_entities(entity_id, relation_type);

alter table public.source_chunk_entities enable row level security;

-- =========================================================
-- 2. Retrieval roles/scopes for source evidence
-- canonical       = curated source / strategic master
-- user_evidence   = raw user-authored historical evidence
-- quarantine      = assistant/generated/noisy material, never auto-retrieve
-- standard        = normal retrieval eligible
-- deep            = only used for deep/entity/broad evidence expansion
-- quarantine      = excluded from automatic retrieval
-- =========================================================
alter table public.source_documents
  add column if not exists source_role text not null default 'canonical',
  add column if not exists retrieval_scope text not null default 'standard',
  add column if not exists domains text[] not null default '{}'::text[];

alter table public.source_chunks
  add column if not exists domains text[] not null default '{}'::text[],
  add column if not exists occurred_at timestamptz;

create index if not exists source_documents_scope_idx
on public.source_documents(user_id, retrieval_scope, source_role);

create index if not exists source_documents_domains_idx
on public.source_documents using gin(domains);

create index if not exists source_chunks_domains_idx
on public.source_chunks using gin(domains);

create index if not exists source_chunks_occurred_idx
on public.source_chunks(occurred_at desc);

-- Existing sources are curated unless a backfill explicitly marks them otherwise.
update public.source_documents
set source_role = coalesce(nullif(source_role,''), 'canonical'),
    retrieval_scope = coalesce(nullif(retrieval_scope,''), 'standard')
where source_role is null or source_role = '' or retrieval_scope is null or retrieval_scope = '';


-- Backfill domains for the existing curated corpus from record provenance, so
-- strict domain retrieval works on sources imported before v1.1 hardening.
with doc_domains as (
  select rs.source_document_id as id, array_agg(distinct domain_name) as domains
  from public.record_sources rs
  join public.records r on r.id = rs.record_id
  cross join lateral unnest(r.domains) as domain_name
  where rs.source_document_id is not null
  group by rs.source_document_id
)
update public.source_documents d
set domains = doc_domains.domains
from doc_domains
where d.id = doc_domains.id and cardinality(d.domains) = 0;

with chunk_domains as (
  select rs.source_chunk_id as id, array_agg(distinct domain_name) as domains
  from public.record_sources rs
  join public.records r on r.id = rs.record_id
  cross join lateral unnest(r.domains) as domain_name
  where rs.source_chunk_id is not null
  group by rs.source_chunk_id
)
update public.source_chunks c
set domains = chunk_domains.domains
from chunk_domains
where c.id = chunk_domains.id and cardinality(c.domains) = 0;

update public.source_chunks c
set domains = d.domains
from public.source_documents d
where c.source_document_id = d.id
  and cardinality(c.domains) = 0
  and cardinality(d.domains) > 0;

-- =========================================================
-- 3. Provider-level circuit state
-- Model-level 429/5xx belongs in model_route_state.
-- Provider auth/billing/systemic failures belong here so we do not burn
-- attempts across every model on the same broken provider.
-- =========================================================
create table if not exists public.provider_route_state (
  provider text primary key,
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
  updated_at timestamptz not null default now()
);

create index if not exists provider_route_state_blocked_idx
on public.provider_route_state(blocked_until);

alter table public.provider_route_state enable row level security;

-- =========================================================
-- 4. Record retrieval v4
-- Adds entity-neighborhood expansion and strict domain gating.
-- Relevance dominates recency/importance. Exact entity links survive
-- no-embedding privacy modes.
-- =========================================================
create or replace function public.match_records_hybrid_v4(
  p_user_id uuid,
  p_query_text text,
  p_query_embedding vector(768),
  p_domain_hints text[] default '{}'::text[],
  p_required_domains text[] default '{}'::text[],
  p_entity_ids uuid[] default '{}'::uuid[],
  p_strict_domain boolean default false,
  p_match_count integer default 20,
  p_min_similarity real default 0.18
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
  entity_link_score real,
  score real
)
language sql
stable
as $$
with q as (
  select coalesce(array(
    select distinct term
    from unnest(tsvector_to_array(to_tsvector('simple'::regconfig, coalesce(p_query_text,'')))) term
    where char_length(term) >= 3
      and term <> all(array[
        'the','and','for','with','what','who','how','about','from','this','that','you','your','know','remember','tell','me',
        'και','για','μου','σου','του','της','των','στο','στη','στην','απο','από','πως','πώς','τι','ποιο','ποια','ποιες',
        'ξερεις','ξέρεις','θυμασαι','θυμάσαι','ειναι','είναι','εχω','έχω','πες','μενα','μένα'
      ]::text[])
  ), '{}'::text[]) terms
),
base as (
  select r.*,
    to_tsvector('simple'::regconfig,
      coalesce(r.title,'') || ' ' || coalesce(r.body,'') || ' ' ||
      coalesce(array_to_string(r.domains,' '),'') || ' ' || coalesce(r.data::text,'')) expanded_tsv
  from public.records r
  where r.user_id = p_user_id
    and r.status not in ('deleted','superseded')
    and r.knowledge_status <> 'superseded'
),
semantic as (
  select r.id, (1 - (r.embedding <=> p_query_embedding))::real sim
  from base r
  where p_query_embedding is not null and r.embedding is not null
  order by r.embedding <=> p_query_embedding
  limit greatest(p_match_count * 5, 40)
),
lexical as (
  select r.id,
    least((select count(*)::real from unnest(q.terms) term
      where r.expanded_tsv @@ plainto_tsquery('simple'::regconfig, term)) /
      greatest(least(cardinality(q.terms), 7),1)::real, 1.0)::real lex,
    greatest(coalesce((select max(case
      when lower(coalesce(r.title,'')) like '%' || lower(term) || '%' then 1.0
      when lower(coalesce(r.body,'')) like '%' || lower(term) || '%' then 0.62
      else 0.0 end) from unnest(q.terms) term),0),0)::real ent
  from base r cross join q
  where cardinality(q.terms) > 0 and exists (
    select 1 from unnest(q.terms) term
    where r.expanded_tsv @@ plainto_tsquery('simple'::regconfig, term)
       or lower(coalesce(r.title,'')) like '%' || lower(term) || '%'
  )
),
entity_hits as (
  select distinct re.record_id id, 1.0::real entity_link
  from public.record_entities re
  join public.memory_entities e on e.id = re.entity_id
  where e.user_id = p_user_id
    and cardinality(coalesce(p_entity_ids,'{}'::uuid[])) > 0
    and re.entity_id = any(p_entity_ids)
),
candidate_ids as (
  select id from semantic
  union select id from lexical
  union select id from entity_hits
),
scored as (
  select b.*,
    coalesce(s.sim,0)::real sim,
    coalesce(l.lex,0)::real lex,
    coalesce(l.ent,0)::real ent,
    coalesce(eh.entity_link,0)::real entity_link,
    case when cardinality(coalesce(p_domain_hints,'{}'::text[])) > 0
              and b.domains && p_domain_hints then 1.0 else 0.0 end::real dom,
    case b.knowledge_status
      when 'verified_official' then 1.05
      when 'confirmed' then 1.00
      when 'reported' then 0.96
      when 'observed' then 0.92
      when 'disputed' then 0.72
      when 'hypothesis' then 0.60
      else 0.84 end::real knowledge_factor
  from candidate_ids c
  join base b on b.id = c.id
  left join semantic s on s.id=b.id
  left join lexical l on l.id=b.id
  left join entity_hits eh on eh.id=b.id
)
select
  x.id,x.record_type,x.domains,x.title,x.body,x.status,x.fact_state,x.knowledge_status,
  x.confidence,x.importance,x.authority_level,x.occurred_at,x.due_at,x.data,
  x.sim,x.lex,x.ent,x.dom,x.entity_link,
  ((greatest(x.sim,0)*0.38 + x.lex*0.24 + x.ent*0.12 + x.entity_link*0.18 + x.dom*0.05
    + x.importance*0.012 + x.confidence*0.008 + (x.authority_level::real/100.0)*0.012
    + exp(-extract(epoch from (now()-x.updated_at))/31536000.0)::real*0.008)
    * x.knowledge_factor)::real score
from scored x
where (x.sim >= p_min_similarity or x.lex > 0 or x.ent > 0 or x.entity_link > 0)
  and (
    not p_strict_domain
    or cardinality(coalesce(p_required_domains,'{}'::text[])) = 0
    or x.domains && p_required_domains
    or x.entity_link > 0
  )
order by score desc
limit p_match_count;
$$;

-- =========================================================
-- 5. Source evidence retrieval v4
-- Quarantine is never automatic. Deep user evidence is eligible only when
-- the planner explicitly allows it (deep/entity/broad-context requests).
-- Domain-only deep candidates guarantee that a request like "my dating
-- history" can retrieve user-authored history even when the literal word
-- "dating" did not appear in old prompts.
-- =========================================================
create or replace function public.match_source_chunks_hybrid_v4(
  p_user_id uuid,
  p_query_text text,
  p_query_embedding vector(768),
  p_domain_hints text[] default '{}'::text[],
  p_required_domains text[] default '{}'::text[],
  p_entity_ids uuid[] default '{}'::uuid[],
  p_strict_domain boolean default false,
  p_include_deep_scope boolean default false,
  p_match_count integer default 8,
  p_min_similarity real default 0.18
)
returns table (
  id uuid,
  source_document_id uuid,
  document_title text,
  source_type text,
  source_role text,
  retrieval_scope text,
  sensitivity text,
  domains text[],
  occurred_at timestamptz,
  authority_level smallint,
  heading text,
  content text,
  similarity real,
  lexical_score real,
  entity_score real,
  domain_score real,
  entity_link_score real,
  score real
)
language sql
stable
as $$
with q as (
  select coalesce(array(
    select distinct term
    from unnest(tsvector_to_array(to_tsvector('simple'::regconfig, coalesce(p_query_text,'')))) term
    where char_length(term) >= 3
      and term <> all(array[
        'the','and','for','with','what','who','how','about','from','this','that','you','your','know','remember','tell','me',
        'και','για','μου','σου','του','της','των','στο','στη','στην','απο','από','πως','πώς','τι','ποιο','ποια','ποιες',
        'ξερεις','ξέρεις','θυμασαι','θυμάσαι','ειναι','είναι','εχω','έχω','πες','μενα','μένα'
      ]::text[])
  ), '{}'::text[]) terms
),
base as (
  select c.*, d.user_id, d.title document_title, d.source_type, d.source_role,
    d.retrieval_scope, d.authority_level, d.sensitivity,
    case when cardinality(c.domains)>0 then c.domains else d.domains end effective_domains,
    to_tsvector('simple'::regconfig,
      coalesce(d.title,'') || ' ' || coalesce(c.heading,'') || ' ' || coalesce(c.content,'') || ' ' ||
      coalesce(array_to_string(case when cardinality(c.domains)>0 then c.domains else d.domains end,' '),'')) expanded_tsv
  from public.source_chunks c
  join public.source_documents d on d.id=c.source_document_id
  where d.user_id=p_user_id
    and d.sensitivity not in ('work_confidential','restricted')
    and d.source_role <> 'quarantine'
    and d.retrieval_scope <> 'quarantine'
    and (d.retrieval_scope='standard' or p_include_deep_scope)
),
semantic as (
  select b.id,(1-(b.embedding <=> p_query_embedding))::real sim
  from base b
  where p_query_embedding is not null and b.embedding is not null
  order by b.embedding <=> p_query_embedding
  limit greatest(p_match_count*6,48)
),
lexical as (
  select b.id,
    least((select count(*)::real from unnest(q.terms) term
      where b.expanded_tsv @@ plainto_tsquery('simple'::regconfig,term)) /
      greatest(least(cardinality(q.terms),7),1)::real,1.0)::real lex,
    greatest(coalesce((select max(case
      when lower(coalesce(b.document_title,'')) like '%'||lower(term)||'%' then 1.0
      when lower(coalesce(b.heading,'')) like '%'||lower(term)||'%' then 0.9
      when lower(coalesce(b.content,'')) like '%'||lower(term)||'%' then 0.55
      else 0 end) from unnest(q.terms) term),0),0)::real ent
  from base b cross join q
  where cardinality(q.terms)>0 and exists (
    select 1 from unnest(q.terms) term
    where b.expanded_tsv @@ plainto_tsquery('simple'::regconfig,term)
       or lower(coalesce(b.document_title,'')) like '%'||lower(term)||'%'
       or lower(coalesce(b.heading,'')) like '%'||lower(term)||'%'
  )
),
entity_hits as (
  select distinct sce.source_chunk_id id,1.0::real entity_link
  from public.source_chunk_entities sce
  join public.memory_entities e on e.id=sce.entity_id
  where e.user_id=p_user_id
    and cardinality(coalesce(p_entity_ids,'{}'::uuid[]))>0
    and sce.entity_id=any(p_entity_ids)
),
domain_recent as (
  select id
  from base
  where p_include_deep_scope
    and cardinality(coalesce(p_required_domains,'{}'::text[]))>0
    and effective_domains && p_required_domains
  order by coalesce(occurred_at,created_at) desc
  limit greatest(p_match_count*6,36)
),
candidate_ids as (
  select id from semantic
  union select id from lexical
  union select id from entity_hits
  union select id from domain_recent
),
scored as (
  select b.*,
    coalesce(s.sim,0)::real sim,coalesce(l.lex,0)::real lex,coalesce(l.ent,0)::real ent,
    coalesce(eh.entity_link,0)::real entity_link,
    case when cardinality(coalesce(p_domain_hints,'{}'::text[]))>0 and b.effective_domains && p_domain_hints
      then 1.0 else 0.0 end::real dom
  from candidate_ids c
  join base b on b.id=c.id
  left join semantic s on s.id=b.id
  left join lexical l on l.id=b.id
  left join entity_hits eh on eh.id=b.id
)
select
  x.id,x.source_document_id,x.document_title,x.source_type,x.source_role,x.retrieval_scope,
  x.sensitivity,x.effective_domains,x.occurred_at,x.authority_level,x.heading,x.content,
  x.sim,x.lex,x.ent,x.dom,x.entity_link,
  (greatest(x.sim,0)*0.34 + x.lex*0.22 + x.ent*0.10 + x.entity_link*0.22 + x.dom*0.07
    + (x.authority_level::real/100.0)*0.03
    + case when x.source_role='user_evidence' then 0.02 else 0 end)::real score
from scored x
where (x.sim>=p_min_similarity or x.lex>0 or x.ent>0 or x.entity_link>0 or x.dom>0)
  and (
    not p_strict_domain
    or cardinality(coalesce(p_required_domains,'{}'::text[]))=0
    or x.effective_domains && p_required_domains
    or x.entity_link>0
  )
order by score desc, coalesce(x.occurred_at,x.created_at) desc
limit p_match_count;
$$;

-- =========================================================
-- 6. Profile retrieval v2: deliberate facet balancing.
-- =========================================================
create or replace function public.profile_records_v2(
  p_user_id uuid,
  p_match_count integer default 32,
  p_per_facet integer default 3
)
returns table (
  id uuid, record_type text, domains text[], title text, body text, status text,
  fact_state text, knowledge_status text, confidence real, importance real,
  authority_level smallint, occurred_at timestamptz, due_at timestamptz, data jsonb,
  similarity real, lexical_score real, entity_score real, domain_score real,
  entity_link_score real, score real
)
language sql
stable
as $$
with facets as (
  select * from unnest(array[
    'personal','relationships','dating','health','fitness','finance','university',
    'career','work','learning','technical','system','productivity'
  ]::text[]) with ordinality as f(domain, ord)
),
base as (
  select r.*,
    (r.importance*0.34 + r.confidence*0.20 + (r.authority_level::real/100.0)*0.28
      + case r.knowledge_status when 'verified_official' then 0.12 when 'confirmed' then 0.11
        when 'reported' then 0.08 when 'observed' then 0.06 when 'disputed' then 0.02 else 0.03 end
      + exp(-extract(epoch from (now()-r.updated_at))/31536000.0)::real*0.06)::real profile_score
  from public.records r
  where r.user_id=p_user_id and r.status not in ('deleted','superseded') and r.knowledge_status<>'superseded'
),
ranked as (
  select f.domain facet,b.*,
    row_number() over(partition by f.domain order by b.profile_score desc,b.updated_at desc) facet_rank
  from facets f join base b on f.domain=any(b.domains)
),
chosen as (
  select distinct on(id) * from ranked where facet_rank<=greatest(p_per_facet,1)
  order by id, facet_rank, profile_score desc
)
select
  c.id,c.record_type,c.domains,c.title,c.body,c.status,c.fact_state,c.knowledge_status,
  c.confidence,c.importance,c.authority_level,c.occurred_at,c.due_at,c.data,
  0::real,0::real,0::real,1::real,0::real,c.profile_score
from chosen c
order by c.profile_score desc
limit p_match_count;
$$;

-- =========================================================
-- 7. Broad-profile historical evidence: balanced private user-authored excerpts.
-- This is deliberately separate from similarity search because private historical
-- evidence is normally stored without embeddings.
-- =========================================================
create or replace function public.profile_source_chunks_v1(
  p_user_id uuid,
  p_match_count integer default 16,
  p_per_facet integer default 2
)
returns table (
  id uuid,
  source_document_id uuid,
  document_title text,
  source_type text,
  source_role text,
  retrieval_scope text,
  sensitivity text,
  domains text[],
  occurred_at timestamptz,
  authority_level smallint,
  heading text,
  content text,
  score real
)
language sql
stable
as $$
with facets as (
  select * from unnest(array[
    'personal','relationships','dating','health','fitness','finance','university',
    'career','work','learning','technical','system','productivity'
  ]::text[]) with ordinality as f(domain, ord)
),
base as (
  select c.id,c.source_document_id,d.title document_title,d.source_type,d.source_role,
    d.retrieval_scope,d.sensitivity,
    case when cardinality(c.domains)>0 then c.domains else d.domains end effective_domains,
    c.occurred_at,d.authority_level,c.heading,c.content,c.created_at,
    ((d.authority_level::real/100.0)*0.60
      + exp(-extract(epoch from (now()-coalesce(c.occurred_at,c.created_at)))/31536000.0)::real*0.40)::real profile_score
  from public.source_chunks c
  join public.source_documents d on d.id=c.source_document_id
  where d.user_id=p_user_id
    and d.source_role='user_evidence'
    and d.retrieval_scope='deep'
    and d.sensitivity not in ('work_confidential','restricted')
),
ranked as (
  select f.domain facet,b.*,
    row_number() over(partition by f.domain order by b.profile_score desc,coalesce(b.occurred_at,b.created_at) desc) facet_rank
  from facets f
  join base b on f.domain=any(b.effective_domains)
),
chosen as (
  select distinct on(id) *
  from ranked
  where facet_rank<=greatest(p_per_facet,1)
  order by id,facet_rank,profile_score desc
)
select c.id,c.source_document_id,c.document_title,c.source_type,c.source_role,c.retrieval_scope,
  c.sensitivity,c.effective_domains,c.occurred_at,c.authority_level,c.heading,c.content,c.profile_score
from chosen c
order by c.profile_score desc
limit p_match_count;
$$;
