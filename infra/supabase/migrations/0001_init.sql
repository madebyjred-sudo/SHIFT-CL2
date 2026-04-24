-- shift-cl2 — initial schema
-- Sprint 1 baseline. Extends in Sprint 3 (chunks, embeddings).

create extension if not exists "vector";
create extension if not exists "pgcrypto";

-- =====================================================
-- conversations
-- =====================================================
create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id text not null check (agent_id in ('lexa','atlas','centinela')),
  title text not null default 'Nueva conversación',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists conversations_user_idx on conversations(user_id, updated_at desc);

-- =====================================================
-- messages
-- =====================================================
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  role text not null check (role in ('user','assistant','system')),
  content text not null,
  agent_id text,
  model text,
  deep_insight boolean not null default false,
  citations jsonb,
  confidence numeric,
  created_at timestamptz not null default now()
);

create index if not exists messages_conv_idx on messages(conversation_id, created_at);

-- =====================================================
-- sessions (legislative sessions, video/transcript metadata)
-- =====================================================
create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  legacy_video_id text unique,
  fecha date,
  comision text,
  tipo text check (tipo in ('plenario','comision','extraordinaria')),
  video_url text,
  transcript_url text,
  status text not null default 'pending' check (status in ('pending','processing','indexed','error')),
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sessions_fecha_idx on sessions(fecha desc);
create index if not exists sessions_status_idx on sessions(status);

-- =====================================================
-- legislative_chunks (RAG corpus, pgvector)
-- =====================================================
create table if not exists legislative_chunks (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references sessions(id) on delete cascade,
  source_type text not null check (source_type in ('transcript','pdf','web','metadata')),
  source_ref text not null,
  chunk_index integer not null,
  content text not null,
  embedding vector(3072),
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index if not exists chunks_session_idx on legislative_chunks(session_id);
-- HNSW index added in Sprint 3 once we know dataset size

-- =====================================================
-- ingest_jobs (worker queue)
-- =====================================================
create table if not exists ingest_jobs (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('pdf','youtube','manual_audio','web_scrape')),
  source_url text,
  status text not null default 'queued' check (status in ('queued','running','done','error')),
  result jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ingest_status_idx on ingest_jobs(status, created_at);

-- =====================================================
-- RLS: simple policies for MVP
-- =====================================================
alter table conversations enable row level security;
alter table messages enable row level security;
alter table ingest_jobs enable row level security;

create policy "users see own conversations"
  on conversations for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "users see own messages"
  on messages for all
  using (
    exists (
      select 1 from conversations c
      where c.id = messages.conversation_id and c.user_id = auth.uid()
    )
  );

create policy "users see own ingest jobs"
  on ingest_jobs for all
  using (created_by = auth.uid())
  with check (created_by = auth.uid());

-- sessions and legislative_chunks are read-shared across all authed users
alter table sessions enable row level security;
alter table legislative_chunks enable row level security;

create policy "authed users read sessions"
  on sessions for select
  using (auth.role() = 'authenticated');

create policy "authed users read chunks"
  on legislative_chunks for select
  using (auth.role() = 'authenticated');
