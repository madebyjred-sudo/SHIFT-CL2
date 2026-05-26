/**
 * backfill-vote-expediente.ts — Wave 4 #4: enrich `legislative_chunks` con
 * `metadata.votando_expediente` para chunks de votación históricos.
 *
 * Contexto (lawyer audit L9):
 *   El plenario CR menciona "expediente 24.567" en un chunk, debate por varios
 *   chunks, y eventualmente anuncia "concluida la votación: 56 votos a favor".
 *   Por longitud (3000 chars / ~50s audio), la mención y el resultado de la
 *   votación caen en chunks distintos. Lexa retrieva el vote chunk vía semantic
 *   search pero no encuentra el N° de expediente, y termina respondiendo "no
 *   encontré votación específica".
 *
 *   Este backfill camina cada sesión en orden cronológico, mantiene un puntero
 *   al "último expediente mencionado", y cuando detecta un vote chunk, UPDATE
 *   `metadata->>votando_expediente` con ese N°. Solo metadata — no re-embed.
 *
 * Idempotencia:
 *   El script lee + recalcula desde cero por sesión. Si un chunk ya tiene
 *   `votando_expediente`, se sobrescribe con el resultado actual (puede
 *   diferir si el algoritmo cambió). Ejecuciones repetidas son seguras.
 *
 * Ejecutar:
 *   set -a && source .env.local && set +a
 *   tsx apps/api/scripts/backfill-vote-expediente.ts
 *
 *   Opcional --dry-run (no UPDATE, solo reporta):
 *   tsx apps/api/scripts/backfill-vote-expediente.ts --dry-run
 *
 *   Opcional --session <uuid> (solo una sesión):
 *   tsx apps/api/scripts/backfill-vote-expediente.ts --session <uuid>
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { linkVotesToExpedientes } from '../src/services/voteExtractor.js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Set NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supa = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SINGLE_SESSION = (() => {
  const idx = args.indexOf('--session');
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
})();

interface ChunkRow {
  id: string;
  chunk_index: number;
  content: string;
  metadata: Record<string, unknown> | null;
}

async function getSessions(): Promise<string[]> {
  if (SINGLE_SESSION) return [SINGLE_SESSION];

  // Distinct session_ids con source_type='transcript'. Paginamos por seguridad
  // aunque PostgREST debería devolver todo en una sola query con DISTINCT.
  const out = new Set<string>();
  for (let off = 0; off < 100_000; off += 1000) {
    const { data, error } = await supa
      .from('legislative_chunks')
      .select('session_id')
      .eq('source_type', 'transcript')
      .range(off, off + 999);
    if (error) throw new Error(`getSessions: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) if (r.session_id) out.add(r.session_id as string);
    if (data.length < 1000) break;
  }
  return Array.from(out);
}

async function getChunksForSession(sessionId: string): Promise<ChunkRow[]> {
  const out: ChunkRow[] = [];
  for (let off = 0; off < 50_000; off += 1000) {
    const { data, error } = await supa
      .from('legislative_chunks')
      .select('id, chunk_index, content, metadata')
      .eq('session_id', sessionId)
      .eq('source_type', 'transcript')
      .order('chunk_index', { ascending: true })
      .range(off, off + 999);
    if (error) throw new Error(`getChunks ${sessionId}: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...(data as ChunkRow[]));
    if (data.length < 1000) break;
  }
  return out;
}

async function applyLinkage(chunkId: string, votandoExpediente: string, prevMeta: Record<string, unknown> | null): Promise<void> {
  const nextMeta = { ...(prevMeta ?? {}), votando_expediente: votandoExpediente };
  const { error } = await supa
    .from('legislative_chunks')
    .update({ metadata: nextMeta })
    .eq('id', chunkId);
  if (error) throw new Error(`update ${chunkId}: ${error.message}`);
}

async function main() {
  console.log(`[backfill-vote-expediente] start ${DRY_RUN ? '(DRY-RUN)' : ''}${SINGLE_SESSION ? ` session=${SINGLE_SESSION}` : ''}`);

  const sessions = await getSessions();
  console.log(`[backfill-vote-expediente] ${sessions.length} sesiones con transcript chunks`);

  let totalChunks = 0;
  let totalLinkages = 0;
  let totalUpdates = 0;
  let totalSkipsAlreadySet = 0;
  let totalErrors = 0;

  for (let i = 0; i < sessions.length; i++) {
    const sid = sessions[i];
    try {
      const chunks = await getChunksForSession(sid);
      totalChunks += chunks.length;

      const linkages = linkVotesToExpedientes(
        chunks.map((c) => ({
          id: c.id,
          chunk_index: c.chunk_index,
          content: c.content,
        })),
      );
      totalLinkages += linkages.length;

      // Build lookup chunkId → existing metadata para UPDATE eficiente.
      const metaById = new Map<string, Record<string, unknown> | null>();
      for (const c of chunks) metaById.set(c.id, c.metadata);

      for (const lk of linkages) {
        const prevMeta = metaById.get(lk.chunk_id) ?? null;
        const existing = (prevMeta as { votando_expediente?: string } | null)?.votando_expediente;
        if (existing === lk.votando_expediente) {
          totalSkipsAlreadySet++;
          continue;
        }
        if (DRY_RUN) {
          totalUpdates++;
          continue;
        }
        try {
          await applyLinkage(lk.chunk_id, lk.votando_expediente, prevMeta);
          totalUpdates++;
        } catch (e) {
          console.error(`  update chunk ${lk.chunk_id} failed: ${(e as Error).message}`);
          totalErrors++;
        }
      }

      if ((i + 1) % 10 === 0 || i === sessions.length - 1) {
        console.log(`  [${i + 1}/${sessions.length}] sid=${sid.slice(0, 8)} chunks=${chunks.length} linkages=${linkages.length} updates_acumulados=${totalUpdates}`);
      }
    } catch (e) {
      console.error(`  session ${sid} failed: ${(e as Error).message}`);
      totalErrors++;
    }
  }

  console.log('');
  console.log(`[backfill-vote-expediente] done`);
  console.log(`  sesiones: ${sessions.length}`);
  console.log(`  chunks totales: ${totalChunks}`);
  console.log(`  linkages calculados: ${totalLinkages}`);
  console.log(`  UPDATEs aplicados: ${totalUpdates} ${DRY_RUN ? '(DRY-RUN)' : ''}`);
  console.log(`  skipped (ya tenían misma asignación): ${totalSkipsAlreadySet}`);
  console.log(`  errores: ${totalErrors}`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
