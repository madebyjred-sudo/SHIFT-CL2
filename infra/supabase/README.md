# Supabase — Apply migrations

## Aplicar 0001_init.sql (manual, una vez)

1. Abrir https://supabase.com/dashboard/project/romccykiucfltfdfatrx/sql/new
2. Pegar contenido de `migrations/0001_init.sql`
3. Run
4. Verificar tablas:
   ```
   conversations, messages, sessions, legislative_chunks, ingest_jobs
   ```

## Auth — Google OAuth

1. Auth → Providers → Google → enable
2. Client ID/Secret desde GCP project (mismo que CL2 GCP si querés single sign-on, o nuevo si separación dura)
3. Redirect URLs:
   - `http://localhost:5173/auth/callback`
   - `https://alpha.agentescl2.com/auth/callback` (cuando esté el dominio)
4. Site URL: `http://localhost:5173` (dev), `https://alpha.agentescl2.com` (prod)

## Vector dimensions

`legislative_chunks.embedding` está en `vector(3072)` para `text-embedding-3-large`.
Si cambiamos a `text-embedding-3-small` (1536) en Sprint 3, drop+recreate la columna.

## HNSW index (Sprint 3)

Se añade después de cargar dataset inicial:
```sql
create index chunks_embedding_idx on legislative_chunks
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);
```
