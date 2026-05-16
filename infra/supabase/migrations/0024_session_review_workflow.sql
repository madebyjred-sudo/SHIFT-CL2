-- Migration 0024 — sessions.status + workflow review humano
-- (idempotente, robusta frente a tabla legacy preexistente)

-- ─────────────────────────────────────────────────────────────────────
-- 1) sessions.status: nuevos estados
-- ─────────────────────────────────────────────────────────────────────
alter table public.sessions drop constraint if exists sessions_status_check;
alter table public.sessions
  add constraint sessions_status_check
  check (status in (
    'pending','processing','pending_review','indexed','rejected',
    'transcript_not_ready','permanent_failure','error'
  ));

-- ─────────────────────────────────────────────────────────────────────
-- 2) Tabla transcripciones_review: garantizar columnas (no forzar tipo)
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.transcripciones_review (
  session_id  text primary key,
  status      text not null default 'pending',
  created_at  timestamptz not null default now()
);

alter table public.transcripciones_review add column if not exists session_id text;
alter table public.transcripciones_review add column if not exists status text not null default 'pending';
alter table public.transcripciones_review add column if not exists reviewer_id uuid;
alter table public.transcripciones_review add column if not exists reviewer_note text;
alter table public.transcripciones_review add column if not exists reviewed_at timestamptz;
alter table public.transcripciones_review add column if not exists payload jsonb default '{}'::jsonb;
alter table public.transcripciones_review add column if not exists created_at timestamptz not null default now();
alter table public.transcripciones_review add column if not exists updated_at timestamptz not null default now();

alter table public.transcripciones_review
  drop constraint if exists transcripciones_review_status_check;
alter table public.transcripciones_review
  add constraint transcripciones_review_status_check
  check (status in ('pending','approved','rejected'));

-- 2-bis) Garantizar UNIQUE INDEX en session_id para que ON CONFLICT funcione.
-- En el legacy schema esta columna existía sin unique constraint.
-- Limpiamos duplicados antes de crear el índice (mantenemos la fila más
-- reciente por session_id usando ctid como tie-breaker).
delete from public.transcripciones_review a
  using public.transcripciones_review b
  where a.session_id = b.session_id
    and a.ctid < b.ctid;

create unique index if not exists transcripciones_review_session_id_uniq
  on public.transcripciones_review(session_id);

-- ─────────────────────────────────────────────────────────────────────
-- 3) Trigger updated_at
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.tg_update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists transcripciones_review_updated_at on public.transcripciones_review;
create trigger transcripciones_review_updated_at
  before update on public.transcripciones_review
  for each row execute function public.tg_update_updated_at();

-- ─────────────────────────────────────────────────────────────────────
-- 4) Index secundario por status + RLS
-- ─────────────────────────────────────────────────────────────────────
create index if not exists transcripciones_review_status_idx
  on public.transcripciones_review(status, updated_at desc);

alter table public.transcripciones_review enable row level security;
drop policy if exists "service role full access" on public.transcripciones_review;
create policy "service role full access" on public.transcripciones_review
  for all using (true) with check (true);

-- ─────────────────────────────────────────────────────────────────────
-- 5) Vista admin (join text↔text con cast)
-- ─────────────────────────────────────────────────────────────────────
create or replace view public.admin_transcripciones_queue as
select
  s.id              as session_id,
  s.youtube_video_id,
  s.fecha,
  s.tipo,
  s.comision,
  s.status          as session_status,
  s.metadata,
  s.created_at,
  s.updated_at,
  coalesce(r.status, 'pending') as review_status,
  r.reviewer_note,
  r.reviewed_at,
  (select count(*) from public.transcript_segments ts where ts.session_id = s.id) as segment_count
from public.sessions s
  left join public.transcripciones_review r on r.session_id = s.id::text;

grant select on public.admin_transcripciones_queue to anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────
-- 6) Backfill: los 4 plenarios manuales del 2026-05-09 → approved
-- ─────────────────────────────────────────────────────────────────────
insert into public.transcripciones_review
  (session_id, status, reviewer_note, reviewed_at, payload)
select
  s.id::text,
  'approved'::text,
  'Backfill manual via yt-dlp (2026-05-09 pre-demo) — auto-aprobado'::text,
  now(),
  jsonb_build_object('backfilled', true, 'source', 'yt-dlp-manual')
from public.sessions s
where s.metadata->>'backfilled_via' = 'yt-dlp-manual'
on conflict (session_id) do nothing;
