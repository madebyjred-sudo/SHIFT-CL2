// voto-inusual-backfill.ts — extrae votos nominales de transcripts con LLM.
//
// Pipeline:
//   1. Para cada `session` indexed con transcript_segments:
//      a. Construye una concatenación cronológica de los segments en bloques
//         de ~80 segments cada uno (≈ 4-6k tokens por bloque, manejable).
//      b. Llama Haiku 3.5 con instrucción tight: "¿este texto contiene
//         una votación nominal? Si sí, devolvé la(s) ranges". Output JSON.
//      c. Para cada range detectado, llama Sonnet 4.6 con instrucción
//         más rigurosa: "extraé pregunta, expediente, lista de
//         diputado→voto, conteos, resultado". Output JSON.
//      d. INSERT en votos_extraidos.
//   2. Idempotente: skip si la sesión ya tiene rows en votos_extraidos.
//
// Uso:
//   set -a && source .env.local && set +a
//   npx tsx scripts/voto-inusual-backfill.ts --limit=50      # primeras 50 sesiones (ordenadas por fecha desc)
//   npx tsx scripts/voto-inusual-backfill.ts --session=<uuid> # una sesión específica
//   npx tsx scripts/voto-inusual-backfill.ts --dry-run        # no inserta
//   npx tsx scripts/voto-inusual-backfill.ts --resume         # skip las que ya tienen votos extraídos
//
// Costo: ~$5 backfill total para las 28k segments actuales (159 sessions).
// Throttle conservador (1.5s entre llamadas) para no toparte con rate limits
// de OpenRouter. ETA: ~30-60 min para todo.

import { createClient } from '@supabase/supabase-js';

const OR_BASE = 'https://openrouter.ai/api/v1';
const HAIKU_MODEL = 'anthropic/claude-haiku-4.5';
const SONNET_MODEL = 'anthropic/claude-sonnet-4.5';

// ── Config ─────────────────────────────────────────────────────────────
const SEGMENTS_PER_BLOCK = 80;       // ~4-6k tokens por block
const THROTTLE_MS = 1500;             // entre llamadas LLM
const MAX_RETRIES = 3;

// ── CLI args ───────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const LIMIT = ((): number | null => {
  const a = args.find((x) => x.startsWith('--limit='));
  return a ? Number(a.split('=')[1]) : null;
})();
const SESSION_ID = ((): string | null => {
  const a = args.find((x) => x.startsWith('--session='));
  return a ? a.split('=')[1]! : null;
})();
const DRY_RUN = args.includes('--dry-run');
const RESUME = args.includes('--resume');

// ── Env ────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE env. Run: set -a && source .env.local && set +a');
  process.exit(1);
}
if (!OPENROUTER_KEY) {
  console.error('Missing OPENROUTER_API_KEY');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

// ── Helpers ────────────────────────────────────────────────────────────

interface Segment {
  id: string;
  start_seconds: number;
  text: string;
}

interface Session {
  id: string;
  fecha: string | null;
  metadata: Record<string, unknown> | null;
}

async function callOpenRouter(opts: {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  label: string;
}): Promise<string> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const r = await fetch(`${OR_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OPENROUTER_KEY}`,
          'HTTP-Referer': 'https://cl2.shift.ai',
          'X-Title': `CL2 - ${opts.label}`,
        },
        body: JSON.stringify({
          model: opts.model,
          messages: [
            { role: 'system', content: opts.system },
            { role: 'user', content: opts.user },
          ],
          max_tokens: opts.maxTokens,
          temperature: 0.1,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) {
        const txt = await r.text();
        if (r.status === 429 || r.status >= 500) {
          await sleep(2000 * Math.pow(2, attempt));
          continue;
        }
        throw new Error(`${opts.label} ${r.status}: ${txt.slice(0, 200)}`);
      }
      const body = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const raw = body.choices?.[0]?.message?.content ?? '';
      // Strip code fences if Sonnet sneaks them in.
      return raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    } catch (err) {
      if (attempt === MAX_RETRIES - 1) throw err;
      await sleep(2000 * Math.pow(2, attempt));
    }
  }
  throw new Error('unreachable');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Detector (Haiku) ───────────────────────────────────────────────────

interface DetectorBlock {
  block_index: number;
  is_voting: boolean;
  start_segment_idx?: number;
  end_segment_idx?: number;
  reason?: string;
}

const DETECTOR_SYSTEM = `Sos un detector de bloques de votación en transcripts de la Asamblea Legislativa de Costa Rica.

Tu input es UN BLOQUE de transcript: una concatenación cronológica de segments. Cada segment está marcado [N] donde N es su índice local dentro del bloque (0, 1, 2, ...).

Tu trabajo: identificar si en este bloque ocurre una **votación nominal**. Una votación nominal tiene marcadores claros como:
  - "se procede a la votación nominal"
  - "votación nominal: aprobar el dictamen…"
  - "los señores diputados votan: a favor X, en contra Y"
  - el secretario nombra diputados uno por uno con su voto

NO es votación nominal:
  - votos a mano alzada sin nombrar diputados
  - menciones casuales ("yo voté contra eso")
  - referencias históricas

DEVOLVÉ JSON ESTRICTO:
{
  "blocks": [
    { "block_index": 0, "is_voting": false },
    { "block_index": 1, "is_voting": true, "start_segment_idx": 23, "end_segment_idx": 67, "reason": "secretario lee votación nominal sobre dictamen 24.429" }
  ]
}

Si no hay votaciones, devolvé un solo block con is_voting:false.`;

async function runDetector(blocksToScan: Array<{ blockText: string; blockIndex: number }>): Promise<DetectorBlock[]> {
  // Process all blocks in one Haiku call — cheaper than N calls.
  const userMsg = blocksToScan
    .map((b) => `=== BLOCK ${b.blockIndex} ===\n${b.blockText}`)
    .join('\n\n');
  const raw = await callOpenRouter({
    model: HAIKU_MODEL,
    system: DETECTOR_SYSTEM,
    user: userMsg,
    maxTokens: 2000,
    label: 'voto-detector',
  });
  try {
    const parsed = JSON.parse(raw) as { blocks?: DetectorBlock[] };
    return parsed.blocks ?? [];
  } catch {
    return [];
  }
}

// ── Extractor (Sonnet) ─────────────────────────────────────────────────

interface ExtractedVote {
  diputado: string;
  voto: 'a_favor' | 'en_contra' | 'abstencion' | 'ausente' | 'no_consta';
}

interface ExtractedVotacion {
  pregunta: string;
  expediente_numero: string | null;
  votes: ExtractedVote[];
  total_a_favor: number;
  total_en_contra: number;
  total_abstenidos: number;
  total_ausentes: number;
  resultado: 'aprobada' | 'rechazada' | 'sin_quorum' | 'desconocido';
  confidence: number;
}

const EXTRACTOR_SYSTEM = `Sos un extractor de votaciones nominales de transcripts de la Asamblea de Costa Rica.

Tu input es un fragmento de transcript que contiene UNA O MÁS votaciones nominales.

Tu output: JSON estricto con la lista de votaciones detectadas. Para cada una:

{
  "votaciones": [
    {
      "pregunta": "aprobar el dictamen de mayoría del expediente 24.429",
      "expediente_numero": "24.429",
      "votes": [
        {"diputado": "PEREZ MARIN", "voto": "a_favor"},
        {"diputado": "RODRIGUEZ STELLER", "voto": "en_contra"},
        ...
      ],
      "total_a_favor": 28,
      "total_en_contra": 14,
      "total_abstenidos": 2,
      "total_ausentes": 13,
      "resultado": "aprobada",
      "confidence": 0.92
    }
  ]
}

Reglas:
  - 'voto' ∈ {a_favor, en_contra, abstencion, ausente, no_consta}
  - 'expediente_numero' = formato "NN.NNN" cuando aparezca; null si la votación es procedimental (moción de orden, alteración de agenda)
  - 'resultado': 'aprobada' si total_a_favor > total_en_contra; 'rechazada' caso contrario; 'sin_quorum' si suman < 38; 'desconocido' si no se puede determinar
  - 'confidence': 0.0-1.0 — bajalo a <0.7 si no estás seguro de algún voto individual (errores de transcripción, nombres ambiguos)
  - NO inventes diputados ni votos. Si no se nombra a alguien, NO lo incluyas.
  - Apellidos en mayúsculas, sin acentos si no aparecen.

Si el fragmento NO tiene votaciones reales, devolvé { "votaciones": [] }.`;

async function runExtractor(text: string, hint: string): Promise<ExtractedVotacion[]> {
  const userMsg = `Hint del detector: "${hint}"\n\n=== TEXTO ===\n${text}`;
  const raw = await callOpenRouter({
    model: SONNET_MODEL,
    system: EXTRACTOR_SYSTEM,
    user: userMsg,
    maxTokens: 4000,
    label: 'voto-extractor',
  });
  try {
    const parsed = JSON.parse(raw) as { votaciones?: ExtractedVotacion[] };
    return parsed.votaciones ?? [];
  } catch (err) {
    console.warn('[extractor] JSON parse failed:', (err as Error).message, 'raw:', raw.slice(0, 200));
    return [];
  }
}

// ── Per-session pipeline ───────────────────────────────────────────────

async function processSession(session: Session): Promise<{
  votaciones_extracted: number;
  cost_estimate: number;
}> {
  console.log(`[${session.id.slice(0,8)}] start  fecha=${session.fecha ?? '?'}`);

  // Skip if already has extractions and --resume
  if (RESUME) {
    const { count } = await sb
      .from('votos_extraidos')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', session.id);
    if ((count ?? 0) > 0) {
      console.log(`[${session.id.slice(0,8)}] skip   ${count} votos already extracted`);
      return { votaciones_extracted: 0, cost_estimate: 0 };
    }
  }

  const { data: segments, error } = await sb
    .from('transcript_segments')
    .select('id, start_seconds, text')
    .eq('session_id', session.id)
    .order('start_seconds', { ascending: true });
  if (error) throw new Error(`load segments: ${error.message}`);
  const segs = (segments ?? []) as Segment[];
  if (segs.length === 0) {
    console.log(`[${session.id.slice(0,8)}] empty  (no segments)`);
    return { votaciones_extracted: 0, cost_estimate: 0 };
  }

  // Bloquear en chunks de SEGMENTS_PER_BLOCK
  const blocks: Array<{ blockText: string; blockIndex: number; segs: Segment[] }> = [];
  for (let i = 0; i < segs.length; i += SEGMENTS_PER_BLOCK) {
    const blockSegs = segs.slice(i, i + SEGMENTS_PER_BLOCK);
    const blockText = blockSegs.map((s, idx) => `[${idx}] ${s.text}`).join('\n');
    blocks.push({ blockText, blockIndex: blocks.length, segs: blockSegs });
  }

  // Detector — process all blocks at once (Haiku is cheap)
  console.log(`[${session.id.slice(0,8)}] detect ${blocks.length} blocks (${segs.length} segs)`);
  const detected = await runDetector(blocks.map((b) => ({ blockText: b.blockText, blockIndex: b.blockIndex })));
  await sleep(THROTTLE_MS);

  const votingBlocks = detected.filter((d) => d.is_voting);
  console.log(`[${session.id.slice(0,8)}] voting ${votingBlocks.length} blocks detected`);

  if (votingBlocks.length === 0) {
    return { votaciones_extracted: 0, cost_estimate: 0.001 };
  }

  // Extractor pass per voting block
  let totalVotaciones = 0;
  let votacionLocalIndex = 0;
  let costEstimate = 0.001; // detector pass cost
  for (const det of votingBlocks) {
    const block = blocks[det.block_index];
    if (!block) continue;
    const startIdx = det.start_segment_idx ?? 0;
    const endIdx = Math.min(det.end_segment_idx ?? block.segs.length - 1, block.segs.length - 1);
    const slice = block.segs.slice(startIdx, endIdx + 1);
    const sliceText = slice.map((s) => s.text).join('\n');

    const votaciones = await runExtractor(sliceText, det.reason ?? '');
    costEstimate += 0.02 + 0.005; // input + output approx for Sonnet on ~5k tokens
    await sleep(THROTTLE_MS);

    for (const v of votaciones) {
      votacionLocalIndex++;
      totalVotaciones++;
      const row = {
        session_id: session.id,
        segment_id_start: slice[0]?.id ?? null,
        segment_id_end: slice[slice.length - 1]?.id ?? null,
        votacion_local_index: votacionLocalIndex,
        expediente_numero: v.expediente_numero ?? null,
        pregunta: v.pregunta ?? '(sin pregunta)',
        fecha: session.fecha,
        votes: v.votes ?? [],
        total_a_favor: v.total_a_favor ?? v.votes.filter((x) => x.voto === 'a_favor').length,
        total_en_contra: v.total_en_contra ?? v.votes.filter((x) => x.voto === 'en_contra').length,
        total_abstenidos: v.total_abstenidos ?? v.votes.filter((x) => x.voto === 'abstencion').length,
        total_ausentes: v.total_ausentes ?? v.votes.filter((x) => x.voto === 'ausente').length,
        resultado: v.resultado ?? 'desconocido',
        llm_confidence: v.confidence ?? 0,
      };
      console.log(`[${session.id.slice(0,8)}] vote   #${votacionLocalIndex} ${v.expediente_numero ?? '(proc)'} a_favor=${row.total_a_favor} en_contra=${row.total_en_contra} conf=${v.confidence}`);
      if (!DRY_RUN) {
        const { error: insErr } = await sb
          .from('votos_extraidos')
          .upsert(row, { onConflict: 'session_id,votacion_local_index' });
        if (insErr) console.warn(`[${session.id.slice(0,8)}] insert fail:`, insErr.message);
      }
    }
  }

  return { votaciones_extracted: totalVotaciones, cost_estimate: costEstimate };
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[backfill] start  limit=${LIMIT ?? 'all'} session=${SESSION_ID ?? 'all'} dryRun=${DRY_RUN} resume=${RESUME}`);
  let q = sb
    .from('sessions')
    .select('id, fecha, metadata')
    .eq('status', 'indexed')
    .eq('source', 'youtube')
    .order('fecha', { ascending: false, nullsFirst: false });
  if (SESSION_ID) q = q.eq('id', SESSION_ID);
  if (LIMIT) q = q.limit(LIMIT);

  const { data, error } = await q;
  if (error) throw new Error(`load sessions: ${error.message}`);
  const sessions = (data ?? []) as Session[];
  console.log(`[backfill] ${sessions.length} sessions to process`);

  let totalVotaciones = 0;
  let totalCost = 0;
  const t0 = Date.now();

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i]!;
    try {
      const { votaciones_extracted, cost_estimate } = await processSession(s);
      totalVotaciones += votaciones_extracted;
      totalCost += cost_estimate;
    } catch (err) {
      console.warn(`[${s.id.slice(0,8)}] FAILED:`, (err as Error).message);
    }
    if ((i + 1) % 5 === 0) {
      const elapsed = Math.round((Date.now() - t0) / 1000);
      console.log(`[backfill] progress ${i + 1}/${sessions.length} · ${totalVotaciones} votaciones · ~$${totalCost.toFixed(2)} · ${elapsed}s`);
    }
  }

  console.log(`\n[backfill] DONE in ${Math.round((Date.now() - t0) / 60000)} min`);
  console.log(`           sessions: ${sessions.length}`);
  console.log(`           votaciones extraídas: ${totalVotaciones}`);
  console.log(`           costo estimado: ~$${totalCost.toFixed(2)}`);
}

main().catch((e) => {
  console.error('[backfill] FATAL:', e);
  process.exit(1);
});
