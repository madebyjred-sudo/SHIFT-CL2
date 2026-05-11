-- shift-cl2 — Bug reports / feedback inbox.
--
-- Pequeño y honesto: los users de CL2 envían bugs / preguntas / pedidos
-- desde un botón flotante en la SPA. Cada report queda con autor (user_id),
-- contexto (URL donde estaba al reportar), severidad declarada, una
-- imagen opcional (screenshot pegado o subido) y status que el operador
-- (Jred) cambia desde /admin/feedback.
--
-- Screenshot lives en GCS (CL2_ASSETS_BUCKET, prefix bug-reports/<user>/).
-- La DB solo guarda el path gs:// para no inflar rows.
--
-- IDEMPOTENT.

create table if not exists bug_reports (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
                  -- El reporte se queda anclado al user que lo creó. Si el
                  -- user es borrado, sus reportes se van con él (privacy).
  user_email      text,
                  -- Snapshot del email al momento de crear, por si el user
                  -- cambia su email después o el auth.users.email es null.
                  -- Útil para que /admin/feedback no tenga que joinear.
  kind            text not null default 'bug'
                  check (kind in ('bug', 'pregunta', 'idea', 'otro')),
                  -- 'bug'      → algo no funciona como se espera
                  -- 'pregunta' → confusión sobre cómo usar algo
                  -- 'idea'     → feature request
                  -- 'otro'     → catch-all
  title           text not null,
                  -- 1 línea, max ~140 chars (no constraint estricto — la
                  -- UI lo limita; mejor permitir long-tail al backend).
  description     text not null default '',
                  -- Markdown. Max ~10KB en la UI.
  context_url     text,
                  -- URL relativa (ej "/sesiones/123") donde el user estaba
                  -- al reportar. Lo captura el frontend desde window.location.
  context_meta    jsonb default '{}'::jsonb,
                  -- User agent, viewport, theme (light/dark), etc. Útil
                  -- para repro. No es PII sensible.
  screenshot_path text,
                  -- gs://CL2_ASSETS_BUCKET/bug-reports/<user_id>/<uuid>.<ext>
                  -- Signed URL se genera on-demand cuando admin abre.
  severity        text not null default 'media'
                  check (severity in ('baja', 'media', 'alta', 'critica')),
  status          text not null default 'abierto'
                  check (status in ('abierto', 'en_revision', 'resuelto', 'descartado')),
                  -- Workflow simple: abierto → en_revision → resuelto/descartado.
                  -- Cambia desde /admin/feedback.
  admin_notes     text default '',
                  -- Comentarios del operador. Visibles solo en admin (no
                  -- vuelven al user que reportó).
  resolved_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists bug_reports_status_idx
  on bug_reports (status, created_at desc)
  where status in ('abierto', 'en_revision');
  -- Patrón principal: "dame la bandeja de entrada" — solo los items
  -- que requieren atención. Resueltos/descartados quedan archivados.

create index if not exists bug_reports_user_idx
  on bug_reports (user_id, created_at desc);
  -- Patrón secundario: "qué reporté yo" (futuro: ver historial en la SPA).

-- ─── RLS ──────────────────────────────────────────────────────────────
alter table bug_reports enable row level security;

-- Users pueden ver sólo SUS reportes (no los de otros).
drop policy if exists "bug_reports users read own rows" on bug_reports;
create policy "bug_reports users read own rows"
  on bug_reports for select
  using (auth.uid() = user_id);

-- Users pueden crear sus propios reportes.
drop policy if exists "bug_reports users insert own rows" on bug_reports;
create policy "bug_reports users insert own rows"
  on bug_reports for insert
  with check (auth.uid() = user_id);

-- Updates SOLO desde service_role (admin operations).
-- Los users no pueden cambiar status/admin_notes de sus reportes
-- después de crearlos. Si quieren agregar info, crean otro reporte.
drop policy if exists "bug_reports service role updates" on bug_reports;
create policy "bug_reports service role updates"
  on bug_reports for update
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- Solo service_role borra.
drop policy if exists "bug_reports service role deletes" on bug_reports;
create policy "bug_reports service role deletes"
  on bug_reports for delete
  using (auth.role() = 'service_role');

-- ─── updated_at trigger ───────────────────────────────────────────────
create or replace function set_bug_reports_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if new.status in ('resuelto', 'descartado') and old.status not in ('resuelto', 'descartado') then
    new.resolved_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists bug_reports_updated_at on bug_reports;
create trigger bug_reports_updated_at
  before update on bug_reports
  for each row execute function set_bug_reports_updated_at();

-- ─── Comments ─────────────────────────────────────────────────────────
comment on table bug_reports is
  'Bug reports / feedback de usuarios CL2. Submitido vía botón flotante '
  'en la SPA. Screenshots viven en GCS (CL2_ASSETS_BUCKET, prefix '
  'bug-reports/<user_id>/). Admin gestiona desde /admin/feedback.';

comment on column bug_reports.context_url is
  'URL relativa donde el user estaba al reportar. Frontend lo captura '
  'desde window.location.pathname + search. Crítico para repro.';

comment on column bug_reports.screenshot_path is
  'gs:// path al screenshot en GCS. NULL si el user no adjuntó imagen. '
  'Signed URL se genera on-demand cuando admin abre el reporte.';
