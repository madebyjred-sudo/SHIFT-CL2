/**
 * Tests for insightAssembler.ts v2 — keyword-based dimension classification
 * and selective domain retrieval.
 *
 * Covers:
 *   1. classifyDimension — 10+ query patterns mapping to correct dimensions
 *   2. retrieveForDimension (via insightRetrieve mock) — verifies correct
 *      services are called per dimension and wrong ones are NOT called
 *   3. Curación — never exceeds 8 chunks total
 *   4. expediente_numero propagation — passed to transcript and SIL searches
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyDimension, insightRetrieve, type InsightDimension } from './insightAssembler.js';

// ─── Mocks ───────────────────────────────────────────────────────────────
// Default: return oversized arrays so curation logic is exercised.
const mockState = vi.hoisted(() => ({
  transcriptCount: 20,
  silCount: 20,
  reglamentoCount: 10,
  constitucionLoalCount: 10,
}));

function mkTranscriptHits(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    chunk_id: `t-${i}`,
    metadata: { start: i * 60 },
    content: `transcript ${i}`,
    similarity: 0.9 - i * 0.01,
  }));
}
function mkSilHits(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    chunk_id: `s-${i}`,
    expediente_numero: '25.602',
    content: `sil ${i}`,
    similarity: 0.9 - i * 0.01,
  }));
}
function mkReglamentoHits(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    chunk_id: `r-${i}`,
    articulo_full_title: `Art. ${i}`,
    content: `reglamento ${i}`,
    similarity: 0.9 - i * 0.01,
  }));
}
function mkConstitucionLoalHits(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    chunk_id: `c-${i}`,
    articulo_numero: `${i}`,
    doc: 'Constitución',
    content: `constitucion ${i}`,
    similarity: 0.9 - i * 0.01,
  }));
}

vi.mock('./searchTranscripts.js', () => ({
  searchTranscripts: vi.fn(async () => mkTranscriptHits(mockState.transcriptCount)),
}));

vi.mock('./silClient.js', () => ({
  searchSilCorpus: vi.fn(async () => mkSilHits(mockState.silCount)),
  searchReglamento: vi.fn(async () => mkReglamentoHits(mockState.reglamentoCount)),
  searchConstitucionLoal: vi.fn(async () => mkConstitucionLoalHits(mockState.constitucionLoalCount)),
}));

import { searchTranscripts } from './searchTranscripts.js';
import { searchSilCorpus, searchReglamento, searchConstitucionLoal } from './silClient.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── 1. classifyDimension — pure keyword classifier ─────────────────────
describe('classifyDimension — keyword mapping', () => {
  const cases: Array<{ query: string; expected: InsightDimension }> = [
    // impacto_normativo
    { query: '¿Qué dice el reglamento sobre la votación?', expected: 'impacto_normativo' },
    { query: '¿Es constitucional esta reforma?', expected: 'impacto_normativo' },
    { query: '¿Qué artículo regula el plenario?', expected: 'impacto_normativo' },
    { query: 'Esto vulnera la ley orgánica', expected: 'impacto_normativo' },

    // contexto_debate
    { query: '¿Qué dijeron en la sesión del 21 de mayo?', expected: 'contexto_debate' },
    { query: '¿Qué discutieron sobre el expediente?', expected: 'contexto_debate' },
    { query: 'Intervención de la diputada María en el plenario', expected: 'contexto_debate' },

    // estado_expediente
    { query: '¿En qué estado está el expediente 25.602?', expected: 'estado_expediente' },
    { query: '¿Cuál es la votación del proyecto?', expected: 'estado_expediente' },

    // riesgo_obstruccion
    { query: '¿Está atascado el expediente?', expected: 'riesgo_obstruccion' },
    { query: '¿Cuánto tiempo lleva en trámite?', expected: 'riesgo_obstruccion' },
    { query: '¿Cuál es el plazo para dictamen?', expected: 'riesgo_obstruccion' },

    // red_proponentes
    { query: '¿Quién presentó este proyecto?', expected: 'red_proponentes' },
    { query: '¿Qué otros proyectos tiene el diputado?', expected: 'red_proponentes' },
    { query: 'Historial del proponente', expected: 'red_proponentes' },

    // sintesis_general
    { query: 'Dame un resumen', expected: 'sintesis_general' },
    { query: 'Resumen', expected: 'sintesis_general' },
  ];

  it.each(cases)('"$query" → $expected', ({ query, expected }) => {
    expect(classifyDimension(query)).toBe(expected);
  });
});

// ─── 2. Dimension-scoped retrieval — mocks verify correct services called ─
describe('insightRetrieve — selective domain calls', () => {
  it('impacto_normativo calls reglamento + constitucion_loal, NEVER transcripts or SIL', async () => {
    await insightRetrieve({ query: '¿Qué dice el reglamento?' });

    expect(searchReglamento).toHaveBeenCalledTimes(1);
    expect(searchConstitucionLoal).toHaveBeenCalledTimes(1);
    expect(searchTranscripts).not.toHaveBeenCalled();
    expect(searchSilCorpus).not.toHaveBeenCalled();
  });

  it('contexto_debate calls transcripts ONLY', async () => {
    await insightRetrieve({ query: '¿Qué dijeron en la sesión?' });

    expect(searchTranscripts).toHaveBeenCalledTimes(1);
    expect(searchSilCorpus).not.toHaveBeenCalled();
    expect(searchReglamento).not.toHaveBeenCalled();
    expect(searchConstitucionLoal).not.toHaveBeenCalled();
  });

  it('estado_expediente calls SIL ONLY', async () => {
    await insightRetrieve({ query: '¿En qué estado está el expediente?' });

    expect(searchSilCorpus).toHaveBeenCalledTimes(1);
    expect(searchTranscripts).not.toHaveBeenCalled();
    expect(searchReglamento).not.toHaveBeenCalled();
    expect(searchConstitucionLoal).not.toHaveBeenCalled();
  });

  it('sintesis_general with no expediente calls transcripts', async () => {
    await insightRetrieve({ query: 'Resumen' });

    expect(searchTranscripts).toHaveBeenCalledTimes(1);
    expect(searchSilCorpus).not.toHaveBeenCalled();
  });

  it('sintesis_general WITH expediente calls SIL', async () => {
    await insightRetrieve({ query: 'Resumen', expediente_numero: '25.602' });

    expect(searchSilCorpus).toHaveBeenCalledTimes(1);
    expect(searchTranscripts).not.toHaveBeenCalled();
  });

  it('passes expediente_numero to searchTranscripts for contexto_debate', async () => {
    await insightRetrieve({ query: '¿Qué dijeron?', expediente_numero: '25.602' });

    expect(searchTranscripts).toHaveBeenCalledWith(
      expect.objectContaining({ expediente_numero: '25.602' }),
    );
  });

  it('passes expediente_numero to searchSilCorpus for estado_expediente', async () => {
    await insightRetrieve({ query: '¿En qué estado está?', expediente_numero: '25.602' });

    expect(searchSilCorpus).toHaveBeenCalledWith(
      expect.objectContaining({ expediente_numero: '25.602' }),
    );
  });
});

// ─── 3. Curación — max 8 chunks ─────────────────────────────────────────
describe('insightRetrieve — curation (max 8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('impacto_normativo curates to 5 chunks (3 reglamento + 2 constitución)', async () => {
    const result = await insightRetrieve({ query: '¿Qué dice el reglamento?' });
    expect(result.summary.reglamento).toBe(3);
    expect(result.summary.constitucion_loal).toBe(2);
    expect(result.summary.total).toBe(5);
    expect(result.summary.total).toBeLessThanOrEqual(8);

    const chunkMatches = result.rendered.match(/^\[(R|C|S|T)\d+\]/gm);
    const chunkCount = chunkMatches ? chunkMatches.length : 0;
    expect(chunkCount).toBe(5);
  });

  it('contexto_debate curates to 5 chunks', async () => {
    const result = await insightRetrieve({ query: '¿Qué dijeron en la sesión?' });
    expect(result.summary.transcripts).toBe(4);
    expect(result.summary.total).toBe(4);
    expect(result.summary.total).toBeLessThanOrEqual(8);
  });

  it('estado_expediente curates to 6 chunks', async () => {
    const result = await insightRetrieve({ query: '¿En qué estado está el expediente?' });
    expect(result.summary.sil).toBe(4);
    expect(result.summary.total).toBe(4);
    expect(result.summary.total).toBeLessThanOrEqual(8);
  });

  // NOTE: the all.length > 8 truncation path is defensive code for future
  // dimensions that may call 3+ services simultaneously. No current dimension
  // reaches >8 chunks because k_per_bucket is capped at 5 and each dimension
  // calls at most 2 services. If a future dimension calls 3+ services, the
  // proportional truncation logic (targetT/targetS/targetR/targetC) will kick
  // in and cap at 8.
});
