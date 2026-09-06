-- ============================================================
-- Personal OS v1 - consolidated schema
-- Postgres + pgvector + provenance + hybrid retrieval
-- ============================================================

create extension if not exists vector;
create extension if not exists pgcrypto;

-- -------------------------
-- Utility functions
-- -------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- -------------------------
-- Users / assistant profiles
-- -------------------------
create table public.users (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id text unique,
  telegram_username text,
  display_name text,
  locale text,
  timezone text not null default 'Europe/Athens',
  profile jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger users_touch_updated_at
before update on public.users
for each row execute function public.touch_updated_at();

create table public.coaches (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  system_prompt text,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger coaches_touch_updated_at
before update on public.coaches
for each row execute function public.touch_updated_at();

insert into public.coaches (key, name, system_prompt)
values ('default', 'Personal OS', 'Stateful personal operating system assistant.')
on conflict (key) do nothing;

-- -------------------------
-- Conversations / ingress
-- -------------------------
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  channel text not null default 'telegram',
  external_chat_id text not null,
  coach_key text not null default 'default',
  title text,
  state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, channel, external_chat_id, coach_key)
);

create trigger conversations_touch_updated_at
before update on public.conversations
for each row execute function public.touch_updated_at();

create table public.ingress_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  external_event_id text not null,
  external_message_id text,
  user_id uuid references public.users(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete cascade,
  input_type text not null default 'text',
  content_hash text,
  status text not null default 'queued'
    check (status in ('queued','processing','completed','failed','blocked')),
  error text,
  processing_started_at timestamptz,
  processing_completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique(provider, external_event_id)
);

create index ingress_events_status_idx
on public.ingress_events(status, created_at desc);

-- -------------------------
-- Messages
-- Raw content can intentionally be NULL for no-store/private inputs.
-- -------------------------
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  role text not null check (role in ('user','assistant','system','tool')),
  input_type text not null default 'text'
    check (input_type in ('text','voice','image','file','system')),
  content text,
  transcript text,
  content_hash text,
  external_message_id text,
  sensitivity text not null default 'unclassified'
    check (sensitivity in (
      'unclassified','personal_safe','personal_sensitive','work_safe',
      'work_confidential','restricted'
    )),
  store_raw boolean not null default true,
  processing_status text not null default 'completed'
    check (processing_status in ('processing','completed','failed','blocked')),
  routing jsonb not null default '{}'::jsonb,
  analysis jsonb not null default '{}'::jsonb,
  provider text,
  model text,
  latency_ms integer,
  created_at timestamptz not null default now()
);

create unique index messages_external_unique_idx
on public.messages(conversation_id, external_message_id)
where external_message_id is not null and role = 'user';

create index messages_conversation_created_idx
on public.messages(conversation_id, created_at desc);

-- -------------------------
-- Source documents / chunks
-- -------------------------
create table public.source_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  source_type text not null,
  title text,
  original_filename text,
  external_ref text,
  version text,
  authority_level smallint not null default 60
    check (authority_level between 0 and 100),
  sensitivity text not null default 'personal_safe'
    check (sensitivity in (
      'personal_safe','personal_sensitive','work_safe','work_confidential','restricted'
    )),
  content_hash text,
  raw_storage_path text,
  metadata jsonb not null default '{}'::jsonb,
  captured_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger source_documents_touch_updated_at
before update on public.source_documents
for each row execute function public.touch_updated_at();

create unique index source_documents_user_hash_idx
on public.source_documents(user_id, content_hash)
where content_hash is not null;

create index source_documents_user_type_idx
on public.source_documents(user_id, source_type);

create table public.source_chunks (
  id uuid primary key default gen_random_uuid(),
  source_document_id uuid not null references public.source_documents(id) on delete cascade,
  chunk_index integer not null,
  heading text,
  content text not null,
  content_hash text,
  metadata jsonb not null default '{}'::jsonb,
  embedding vector(768),
  embedding_model text,
  embedding_updated_at timestamptz,
  search_tsv tsvector generated always as (
    to_tsvector('simple'::regconfig,
      coalesce(heading,'') || ' ' || coalesce(content,''))
  ) stored,
  created_at timestamptz not null default now(),
  unique(source_document_id, chunk_index)
);

create index source_chunks_embedding_idx
on public.source_chunks using hnsw (embedding vector_cosine_ops);

create index source_chunks_search_idx
on public.source_chunks using gin(search_tsv);

-- -------------------------
-- Canonical record store
-- Flexible enough for future modules without schema churn.
-- Common fields stay relational; domain-specific fields go in data JSONB.
-- -------------------------
create table public.records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  coach_key text not null default 'default',
  record_type text not null,
  domains text[] not null default '{}'::text[],
  title text not null,
  body text,
  status text not null default 'active',
  fact_state text not null default 'unknown'
    check (fact_state in (
      'fact','user_confirmed_evidence','verified_work_evidence','goal','plan',
      'assumption','candidate_design','unknown'
    )),
  knowledge_status text not null default 'observed'
    check (knowledge_status in (
      'verified_official','confirmed','observed','reported','hypothesis',
      'disputed','superseded'
    )),
  confidence real not null default 0.5 check (confidence between 0 and 1),
  importance real not null default 0.5 check (importance between 0 and 1),
  authority_level smallint not null default 60 check (authority_level between 0 and 100),
  priority smallint check (priority between 1 and 5),
  occurred_at timestamptz,
  due_at timestamptz,
  valid_from timestamptz,
  valid_to timestamptz,
  canonical_key text not null,
  data jsonb not null default '{}'::jsonb,
  embedding vector(768),
  embedding_model text,
  embedding_updated_at timestamptz,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search_tsv tsvector generated always as (
    to_tsvector('simple'::regconfig,
      coalesce(title,'') || ' ' || coalesce(body,'') || ' ' || coalesce(data::text,''))
  ) stored,
  unique(user_id, coach_key, record_type, canonical_key)
);

create trigger records_touch_updated_at
before update on public.records
for each row execute function public.touch_updated_at();

create index records_user_type_status_idx
on public.records(user_id, record_type, status);

create index records_domains_idx
on public.records using gin(domains);

create index records_data_idx
on public.records using gin(data jsonb_path_ops);

create index records_search_idx
on public.records using gin(search_tsv);

create index records_embedding_idx
on public.records using hnsw (embedding vector_cosine_ops);

-- Audit history: updates are not silent.
create table public.record_history (
  id uuid primary key default gen_random_uuid(),
  record_id uuid not null references public.records(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  snapshot jsonb not null,
  changed_at timestamptz not null default now()
);

create index record_history_record_idx
on public.record_history(record_id, changed_at desc);

create or replace function public.capture_record_history()
returns trigger
language plpgsql
as $$
declare
  old_semantic jsonb;
  new_semantic jsonb;
begin
  -- Do not create noisy history rows for vector refreshes, timestamps or last_seen only.
  old_semantic := to_jsonb(old) - array[
    'embedding','embedding_model','embedding_updated_at','search_tsv','last_seen_at','updated_at'
  ];
  new_semantic := to_jsonb(new) - array[
    'embedding','embedding_model','embedding_updated_at','search_tsv','last_seen_at','updated_at'
  ];

  if old_semantic is distinct from new_semantic then
    insert into public.record_history(record_id, user_id, snapshot)
    values (old.id, old.user_id, old_semantic);
  end if;

  return new;
end;
$$;

create trigger records_capture_history
before update on public.records
for each row execute function public.capture_record_history();

-- Provenance links records back to Telegram messages or imported sources.
create table public.record_sources (
  id uuid primary key default gen_random_uuid(),
  record_id uuid not null references public.records(id) on delete cascade,
  message_id uuid references public.messages(id) on delete cascade,
  source_document_id uuid references public.source_documents(id) on delete cascade,
  source_chunk_id uuid references public.source_chunks(id) on delete cascade,
  source_role text not null default 'supports',
  confidence real not null default 1.0 check (confidence between 0 and 1),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (num_nonnulls(message_id, source_document_id, source_chunk_id) = 1),
  unique(record_id, message_id),
  unique(record_id, source_document_id),
  unique(record_id, source_chunk_id)
);

create table public.record_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  from_record_id uuid not null references public.records(id) on delete cascade,
  to_record_id uuid not null references public.records(id) on delete cascade,
  relation_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(from_record_id, to_record_id, relation_type),
  check (from_record_id <> to_record_id)
);

-- -------------------------
-- Hot state
-- -------------------------
create table public.current_state (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  coach_key text not null default 'default',
  season text,
  primary_growth_arena text,
  secondary_growth_arena text,
  main_risk text,
  technical_bottleneck text,
  career_bottleneck text,
  top_priorities jsonb not null default '[]'::jsonb,
  defer_list jsonb not null default '[]'::jsonb,
  fixed_obligations jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, coach_key)
);

create trigger current_state_touch_updated_at
before update on public.current_state
for each row execute function public.touch_updated_at();

-- -------------------------
-- Ingestion / model observability
-- -------------------------
create table public.ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  source_document_id uuid references public.source_documents(id) on delete set null,
  mode text not null default 'import',
  status text not null default 'pending'
    check (status in ('pending','processing','completed','failed')),
  stats jsonb not null default '{}'::jsonb,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.model_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete cascade,
  message_id uuid references public.messages(id) on delete set null,
  task text not null,
  provider text not null,
  model text not null,
  status text not null default 'completed'
    check (status in ('completed','failed')),
  latency_ms integer,
  input_chars integer,
  output_chars integer,
  input_tokens integer,
  output_tokens integer,
  thinking_tokens integer,
  total_tokens integer,
  metadata jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now()
);

create index model_runs_task_created_idx
on public.model_runs(task, created_at desc);

-- -------------------------
-- Hybrid retrieval RPC: canonical records
-- Embedding may be NULL: lexical retrieval still works if embedding API is unavailable.
-- -------------------------
create or replace function public.match_records_hybrid(
  p_user_id uuid,
  p_query_text text,
  p_query_embedding vector(768),
  p_match_count integer default 12,
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
  score real
)
language sql
stable
as $$
with q as (
  select websearch_to_tsquery('simple'::regconfig, coalesce(p_query_text,'')) as tsq
),
semantic as (
  select r.id,
         (1 - (r.embedding <=> p_query_embedding))::real as sim
  from public.records r
  where r.user_id = p_user_id
    and p_query_embedding is not null
    and r.embedding is not null
    and r.status not in ('deleted','superseded')
  order by r.embedding <=> p_query_embedding
  limit greatest(p_match_count * 4, 24)
),
lexical as (
  select r.id,
         least(ts_rank_cd(r.search_tsv, q.tsq), 1.0)::real as lex
  from public.records r, q
  where r.user_id = p_user_id
    and r.status not in ('deleted','superseded')
    and numnode(q.tsq) > 0
    and r.search_tsv @@ q.tsq
  order by ts_rank_cd(r.search_tsv, q.tsq) desc
  limit greatest(p_match_count * 4, 24)
),
candidate_ids as (
  select id from semantic
  union
  select id from lexical
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
  coalesce(s.sim, 0)::real as similarity,
  (
    coalesce(greatest(s.sim, 0), 0) * 0.68
    + coalesce(l.lex, 0) * 0.12
    + r.importance * 0.08
    + r.confidence * 0.05
    + (r.authority_level::real / 100.0) * 0.04
    + exp(-extract(epoch from (now() - r.updated_at)) / 7776000.0)::real * 0.03
  )::real as score
from candidate_ids c
join public.records r on r.id = c.id
left join semantic s on s.id = r.id
left join lexical l on l.id = r.id
where coalesce(s.sim, 0) >= p_min_similarity
   or coalesce(l.lex, 0) > 0
order by score desc
limit p_match_count;
$$;

-- -------------------------
-- Hybrid retrieval RPC: safe source chunks
-- -------------------------
create or replace function public.match_source_chunks_hybrid(
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
  score real
)
language sql
stable
as $$
with q as (
  select websearch_to_tsquery('simple'::regconfig, coalesce(p_query_text,'')) as tsq
),
semantic as (
  select c.id, (1 - (c.embedding <=> p_query_embedding))::real as sim
  from public.source_chunks c
  join public.source_documents d on d.id = c.source_document_id
  where d.user_id = p_user_id
    and d.sensitivity not in ('work_confidential','restricted')
    and p_query_embedding is not null
    and c.embedding is not null
  order by c.embedding <=> p_query_embedding
  limit greatest(p_match_count * 5, 30)
),
lexical as (
  select c.id, least(ts_rank_cd(c.search_tsv, q.tsq), 1.0)::real as lex
  from public.source_chunks c
  join public.source_documents d on d.id = c.source_document_id
  cross join q
  where d.user_id = p_user_id
    and d.sensitivity not in ('work_confidential','restricted')
    and numnode(q.tsq) > 0
    and c.search_tsv @@ q.tsq
  order by ts_rank_cd(c.search_tsv, q.tsq) desc
  limit greatest(p_match_count * 5, 30)
),
candidate_ids as (
  select id from semantic
  union
  select id from lexical
)
select
  c.id,
  c.source_document_id,
  d.title as document_title,
  d.source_type,
  d.authority_level,
  c.heading,
  c.content,
  coalesce(s.sim, 0)::real as similarity,
  (
    coalesce(greatest(s.sim, 0), 0) * 0.72
    + coalesce(l.lex, 0) * 0.14
    + (d.authority_level::real / 100.0) * 0.14
  )::real as score
from candidate_ids x
join public.source_chunks c on c.id = x.id
join public.source_documents d on d.id = c.source_document_id
left join semantic s on s.id = c.id
left join lexical l on l.id = c.id
where coalesce(s.sim, 0) >= p_min_similarity
   or coalesce(l.lex, 0) > 0
order by score desc
limit p_match_count;
$$;

-- -------------------------
-- Security: service-role only by default.
-- No anon/authenticated policies are created.
-- -------------------------
alter table public.users enable row level security;
alter table public.coaches enable row level security;
alter table public.conversations enable row level security;
alter table public.ingress_events enable row level security;
alter table public.messages enable row level security;
alter table public.source_documents enable row level security;
alter table public.source_chunks enable row level security;
alter table public.records enable row level security;
alter table public.record_history enable row level security;
alter table public.record_sources enable row level security;
alter table public.record_links enable row level security;
alter table public.current_state enable row level security;
alter table public.ingestion_runs enable row level security;
alter table public.model_runs enable row level security;
