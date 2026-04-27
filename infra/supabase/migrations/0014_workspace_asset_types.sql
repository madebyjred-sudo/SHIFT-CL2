-- 0014_workspace_asset_types.sql
--
-- Extends workspace_nodes.type to allow imported asset types (image,
-- document, audio). Used by POST /api/workspace/:id/nodes/import.
--
-- For these types, content shape is:
--   { url: string, filename: string, size: number, mime: string,
--     thumbnail_url?: string, duration_seconds?: number, pages?: number }
--
-- Idempotent: re-running drops + recreates the constraint.

alter table workspace_nodes drop constraint if exists workspace_nodes_type_check;

alter table workspace_nodes
  add constraint workspace_nodes_type_check
  check (type in ('hoja', 'note', 'cite', 'expediente_ref', 'image', 'document', 'audio'));

-- ─── Storage bucket for imported assets ──────────────────────────────
-- Auto-created on first use by the import endpoint via the service-role
-- client (storage.createBucket). This block is here for ops visibility
-- and to make a re-deploy reproducible — running it twice is safe.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'workspace-assets',
  'workspace-assets',
  true,                      -- public read; writes still gated by RLS
  104857600,                 -- 100MB cap per file
  array[
    'image/png','image/jpeg','image/gif','image/webp','image/svg+xml',
    'audio/mpeg','audio/mp4','audio/wav','audio/ogg','audio/webm',
    'application/pdf','application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain','text/markdown'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- RLS on storage.objects: a user can read anything in workspace-assets
-- (bucket is public for browser <img>/<audio> tags), but can only INSERT
-- under their own user_id prefix path.
do $$
begin
  -- Read policy (everyone, since bucket is public)
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'wsa_public_read'
  ) then
    create policy "wsa_public_read" on storage.objects
      for select using (bucket_id = 'workspace-assets');
  end if;

  -- Write policy: authenticated users only, path must start with their uid
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'wsa_owner_write'
  ) then
    create policy "wsa_owner_write" on storage.objects
      for insert with check (
        bucket_id = 'workspace-assets'
        and auth.uid()::text = split_part(name, '/', 1)
      );
  end if;

  -- Delete policy: same path-prefix gate
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'wsa_owner_delete'
  ) then
    create policy "wsa_owner_delete" on storage.objects
      for delete using (
        bucket_id = 'workspace-assets'
        and auth.uid()::text = split_part(name, '/', 1)
      );
  end if;
end $$;
