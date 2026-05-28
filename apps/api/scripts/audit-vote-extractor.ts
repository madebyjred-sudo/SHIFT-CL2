/**
 * audit-vote-extractor.ts — ground-truth audit del voteExtractor (Wave 4 #4).
 *
 * Tier 2 #4 del audit Wave 4. Mide precision/recall reales contra los chunks
 * de transcript de una sesión específica (default: 21-may-2026), donde el
 * resumen LLM ya tiene la lista de votaciones que esperamos detectar.
 *
 * Para cada chunk:
 *   - Aplica `isVoteChunk()` + `extractExpedienteMentions()`
 *   - Imprime chunk_idx, vote-like? (heurística), expediente extraído, linkage en DB
 *   - Texto recortado para inspección manual
 *
 * Al final imprime tabla de cobertura por expediente esperado (24.642, 24.998,
 * 25.258, 24.009).
 *
 * Uso:
 *   set -a && source .env.local && set +a
 *   npx tsx apps/api/scripts/audit-vote-extractor.ts
 *   npx tsx apps/api/scripts/audit-vote-extractor.ts --session <uuid>
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { extractExpedienteMentions, isVoteChunk, linkVotesToExpedientes } from '../src/services/voteExtractor.js';

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const args = process.argv.slice(2);
const SESSION_UUID = (() => {
  const i = args.indexOf('--session');
  return i >= 0 ? args[i + 1] : null;
})();
const FECHA_TARGET = '2026-05-21';

// Expected votos según resumen ejecutivo de la sesión 21-may-2026:
const EXPECTED_VOTES: Array<{ exp: string; votos: number; verbo: string }> = [
  { exp: '24.642', votos: 53, verbo: 'aprobado en segundo debate (PANI)' },
  { exp: '24.998', votos: 52, verbo: 'aprobado en segundo debate (transporte aéreo)' },
  { exp: '25.258', votos: 56, verbo: 'aprobado moción convocatoria extraordinaria (magistrados Sala IV)' },
  { exp: '24.009', votos: 0, verbo: 'suspendido (consulta constitucional)' },
];

interface ChunkRow {
  id: string;
  chunk_index: number;
  content: string;
  metadata: Record<string, unknown> | null;
}

async function main() {
  // 1. Resolver session_id
  let sessionId = SESSION_UUID;
  if (!sessionId) {
    const { data } = await supa.from('sessions').select('id').eq('fecha', FECHA_TARGET).limit(1);
    sessionId = data?.[0]?.id ?? null;
  }
  if (!sessionId) throw new Error(`No session found for ${FECHA_TARGET}`);
  console.log(`Session: ${sessionId}`);

  // 2. Pull todos los chunks transcript
  const chunks: ChunkRow[] = [];
  for (let off = 0; off < 5000; off += 1000) {
    const { data, error } = await supa
      .from('legislative_chunks')
      .select('id, chunk_index, content, metadata')
      .eq('session_id', sessionId)
      .eq('source_type', 'transcript')
      .order('chunk_index', { ascending: true })
      .range(off, off + 999);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    chunks.push(...(data as ChunkRow[]));
    if (data.length < 1000) break;
  }
  console.log(`Chunks: ${chunks.length}\n`);

  // 3. Aplicar voteExtractor sobre todos
  const linkages = linkVotesToExpedientes(
    chunks.map((c) => ({ id: c.id, chunk_index: c.chunk_index, content: c.content })),
  );
  const linkageMap = new Map<string, string>();
  for (const l of linkages) linkageMap.set(l.chunk_id, l.votando_expediente);

  // 4. Walk chunks: detect vote-like, expediente in-chunk, comparison vs ground truth
  console.log('CHUNK-BY-CHUNK ANALYSIS:');
  console.log('idx | isVote | exp_in_chunk     | linkage      | preview');
  console.log('----+--------+------------------+--------------+--------------------------------');

  const voteChunks: ChunkRow[] = [];
  for (const c of chunks) {
    const isVote = isVoteChunk(c.content);
    const expIn = extractExpedienteMentions(c.content);
    const linkage = linkageMap.get(c.id);
    const interesting = isVote || expIn.length > 0 || c.content.match(/\b(votos?|aprueb|rechaz|aprobad|rechazad|votaci[oó]n)\b/i);
    if (!interesting) continue;
    const preview = c.content.slice(0, 100).replace(/\s+/g, ' ');
    console.log(
      `${String(c.chunk_index).padStart(3)} | ${isVote ? '✓' : ' '}      | ${(expIn.join(',') || '-').padEnd(16)} | ${(linkage || '-').padEnd(12)} | ${preview}`,
    );
    if (isVote) voteChunks.push(c);
  }

  // 5. Coverage por expected vote
  console.log('\n\nCOVERAGE POR EXPECTED VOTE:');
  for (const ev of EXPECTED_VOTES) {
    const linked = linkages.filter((l) => l.votando_expediente === ev.exp);
    const status = linked.length > 0 ? '✅' : '❌';
    console.log(`  ${status} ${ev.exp} (${ev.verbo}): ${linked.length} chunk(s) recibieron linkage`);
    if (linked.length === 0) {
      // Buscar manualmente chunks que mencionen este expediente
      const mentioned = chunks.filter((c) => extractExpedienteMentions(c.content).includes(ev.exp));
      if (mentioned.length > 0) {
        console.log(`     PERO ${mentioned.length} chunk(s) mencionan ${ev.exp}:`);
        for (const m of mentioned.slice(0, 3)) {
          const isV = isVoteChunk(m.content);
          console.log(`       chunk_idx ${m.chunk_index}: isVote=${isV} | "${m.content.slice(0, 120).replace(/\s+/g, ' ')}..."`);
        }
      } else {
        console.log(`     y NINGÚN chunk menciona ${ev.exp} (gap del scraping o del split de chunks).`);
      }
    }
  }

  // 6. Summary stats
  console.log('\n\nSUMMARY:');
  console.log(`  Chunks totales: ${chunks.length}`);
  console.log(`  Chunks isVote=true: ${voteChunks.length}`);
  console.log(`  Linkages emitidos: ${linkages.length}`);
  console.log(`  Expected votes en sesión: ${EXPECTED_VOTES.length}`);
  const detected = EXPECTED_VOTES.filter((ev) => linkages.some((l) => l.votando_expediente === ev.exp));
  console.log(`  Expected votes DETECTADOS: ${detected.length}/${EXPECTED_VOTES.length}`);
  console.log(`  Recall (expected): ${((detected.length / EXPECTED_VOTES.length) * 100).toFixed(0)}%`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
