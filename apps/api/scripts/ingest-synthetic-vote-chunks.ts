/**
 * ingest-synthetic-vote-chunks.ts — Wave 4 #7: crea chunks sintéticos
 * de votación desde `metadata.resumen.acuerdos`.
 *
 * Por qué (Tier 2 hallazgo del audit):
 *   La transcripción Gemini a veces pierde el momento exacto de una
 *   votación. Ej: la sesión 21-may-2026 tiene aprobado en segundo debate
 *   el expediente 24.998 con 52 votos a favor, pero ese resultado NO
 *   quedó en ningún chunk transcript — solo en el `resumen.acuerdos`
 *   generado por Gemini sobre el audio completo.
 *
 *   Este script convierte esos acuerdos LLM-extracted en chunks
 *   sintéticos embebidos con source_type='transcript' y
 *   metadata.subtype='synthetic_vote_summary', para que `match_chunks_v3`
 *   los retrieve junto con los reales cuando Lexa busca "qué se votó".
 *
 * Idempotencia:
 *   Antes de INSERT, DELETE chunks con (session_id, source_type='transcript',
 *   metadata->>subtype='synthetic_vote_summary'). Re-run seguro.
 *
 * Uso:
 *   set -a && source .env.local && set +a
 *   npx tsx apps/api/scripts/ingest-synthetic-vote-chunks.ts
 *   npx tsx apps/api/scripts/ingest-synthetic-vote-chunks.ts --dry-run
 *   npx tsx apps/api/scripts/ingest-synthetic-vote-chunks.ts --session <uuid>
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { embedDocuments } from '../src/services/embeddings.js';
import { parseVotesFromAcuerdos, renderVoteAsChunkContent } from '../src/services/voteSummaryParser.js';

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SINGLE_SESSION = (() => {
  const i = args.indexOf('--session');
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
})();

// chunk_index alto para no colisionar con chunks reales (sesiones tienen
// típicamente <500 chunks). Esto deja "espacio" semántico claro.
const SYNTHETIC_CHUNK_INDEX_BASE = 9000;

interface SessionRow {
  id: string;
  fecha: string | null;
  tipo: string | null;
  comision: string | null;
  youtube_video_id: string | null;
  metadata: Record<string, unknown> | null;
}

async function getCandidateSessions(): Promise<SessionRow[]> {
  if (SINGLE_SESSION) {
    const { data } = await supa
      .from('sessions')
      .select('id, fecha, tipo, comision, youtube_video_id, metadata')
      .eq('id', SINGLE_SESSION)
      .limit(1);
    return (data as SessionRow[]) ?? [];
  }
  // Sesiones que tienen resumen.acuerdos (no-null). Paginadas.
  const out: SessionRow[] = [];
  for (let off = 0; off < 50_000; off += 500) {
    const { data, error } = await supa
      .from('sessions')
      .select('id, fecha, tipo, comision, youtube_video_id, metadata')
      .not('metadata->resumen->acuerdos', 'is', null)
      .order('fecha', { ascending: false })
      .range(off, off + 499);
    if (error) throw new Error(`getCandidateSessions: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...(data as SessionRow[]));
    if (data.length < 500) break;
  }
  return out;
}

async function main() {
  console.log(
    `[ingest-synthetic-vote-chunks] start ${DRY_RUN ? '(DRY-RUN)' : ''}${SINGLE_SESSION ? ` session=${SINGLE_SESSION}` : ''}`,
  );

  const sessions = await getCandidateSessions();
  console.log(`[ingest-synthetic-vote-chunks] ${sessions.length} sesiones con resumen.acuerdos`);

  let sessionsWithVotes = 0;
  let totalVotes = 0;
  let totalDeleted = 0;
  let totalInserted = 0;
  let errors = 0;

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    try {
      const acuerdos = (s.metadata as { resumen?: { acuerdos?: string | string[] } } | null)?.resumen?.acuerdos;
      const acuerdosText = Array.isArray(acuerdos) ? acuerdos.join(' ') : (acuerdos ?? '');
      if (!acuerdosText || acuerdosText.length < 30) continue;

      const votes = parseVotesFromAcuerdos(acuerdosText);
      if (votes.length === 0) continue;

      sessionsWithVotes++;
      totalVotes += votes.length;

      if (DRY_RUN) {
        console.log(
          `  [${i + 1}/${sessions.length}] ${s.fecha} (${s.id.slice(0, 8)}): ${votes.length} votos detectados — ${votes.map((v) => v.expediente).join(', ')}`,
        );
        continue;
      }

      // 1. Delete sintéticos previos (idempotencia)
      const { count: delCount, error: delErr } = await supa
        .from('legislative_chunks')
        .delete({ count: 'exact' })
        .eq('session_id', s.id)
        .eq('source_type', 'transcript')
        .eq('metadata->>subtype', 'synthetic_vote_summary');
      if (delErr) throw new Error(`delete sintéticos: ${delErr.message}`);
      totalDeleted += delCount ?? 0;

      // 2. Render content + embed
      const ctx = { fecha: s.fecha, tipo_sesion: s.tipo };
      const contents = votes.map((v) => renderVoteAsChunkContent(v, ctx));
      const embeddings = await embedDocuments(contents);

      // 3. Build rows
      const rows = votes.map((v, idx) => ({
        session_id: s.id,
        source_type: 'transcript' as const,
        source_ref: s.youtube_video_id ?? s.id,
        chunk_index: SYNTHETIC_CHUNK_INDEX_BASE + idx,
        content: contents[idx],
        embedding: embeddings[idx],
        metadata: {
          subtype: 'synthetic_vote_summary',
          session_id: s.id,
          fecha: s.fecha,
          comision: s.comision,
          tipo: s.tipo,
          votando_expediente: v.expediente,
          votos_a_favor: v.votos_a_favor,
          votos_en_contra: v.votos_en_contra,
          decision: v.decision,
          source: 'metadata.resumen.acuerdos LLM-extracted',
          start_seconds: null,
          end_seconds: null,
        },
      }));

      const { error: insErr } = await supa.from('legislative_chunks').insert(rows);
      if (insErr) throw new Error(`insert sintéticos: ${insErr.message}`);
      totalInserted += rows.length;

      console.log(
        `  [${i + 1}/${sessions.length}] ${s.fecha} (${s.id.slice(0, 8)}): inserted=${rows.length} deleted_prev=${delCount ?? 0} · ${votes.map((v) => v.expediente).join(', ')}`,
      );
    } catch (e) {
      console.error(`  session ${s.id} failed: ${(e as Error).message}`);
      errors++;
    }
  }

  console.log('');
  console.log(`[ingest-synthetic-vote-chunks] done`);
  console.log(`  sesiones procesadas: ${sessions.length}`);
  console.log(`  sesiones con votos detectados: ${sessionsWithVotes}`);
  console.log(`  votos totales: ${totalVotes}`);
  console.log(`  chunks sintéticos INSERTED: ${totalInserted} ${DRY_RUN ? '(DRY-RUN)' : ''}`);
  console.log(`  chunks sintéticos DELETED (re-run idempotente): ${totalDeleted}`);
  console.log(`  errores: ${errors}`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
