/**
 * Tests para searchConstitucionLoal — Wave 4 #2.
 *
 * Verifica que la función:
 *   1. Llama match_chunks_hybrid con los args correctos (incluye query_text,
 *      query_embedding, match_count, rrf_k=60, filtros null).
 *   2. Filtra los hits a source_type ∈ {constitucion, loal} en memoria.
 *   3. Mapea metadata jsonb → campos top-level del hit (articulo_numero,
 *      titulo_seccion, etc.).
 *   4. Cae a match_chunks_v2 cuando hybrid no existe (error 42883).
 *   5. Cuando una query típica como "tratados internacionales" devuelve
 *      Art. 121 Const. en el mock, el hit conserva su número y url.
 *
 * Mock strategy: stub embeddings + supabase.rpc() returning canned data.
 * El módulo silClient.ts crea su propio cliente vía createClient(); el
 * mock global de '@supabase/supabase-js' intercepta esa creación.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Embeddings mock — devolvemos un vector dummy de la dim correcta ────────
// embedQuery se llama una vez por search; el RPC no usa el vector internamente
// en el mock, solo lo recibe como argumento que validamos.
vi.mock('./embeddings.js', () => ({
  embedQuery: vi.fn(async (_text: string) => {
    return new Array(3072).fill(0.001);
  }),
  embedDocuments: vi.fn(async (texts: string[]) =>
    texts.map(() => new Array(3072).fill(0.001)),
  ),
}));

// ─── Reranker mock — identity (no Voyage key) ────────────────────────────────
// rerankItems normalmente reordena con cross-encoder. En tests devolvemos
// el slice top-k tal cual para que las aserciones de orden sean determinísticas.
vi.mock('./rerankClient.js', () => ({
  rerankItems: vi.fn(async <T>(_q: string, items: T[], k: number) => items.slice(0, k)),
}));

// ─── yearExtractor mock — usa la implementación real (passthrough) ──────────
// silClient importa extractDateRangeFromQuery pero searchConstitucionLoal NO
// lo usa. No hace falta mockearlo — vitest carga el módulo real.

// ─── Supabase mock ──────────────────────────────────────────────────────────

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

const _rpcCalls: RpcCall[] = [];
let _hybridResponse: { data: unknown[] | null; error: { code?: string; message: string } | null } = {
  data: [],
  error: null,
};
let _v2Response: { data: unknown[] | null; error: { code?: string; message: string } | null } = {
  data: [],
  error: null,
};

vi.mock('@supabase/supabase-js', () => {
  function buildRpc(fn: string, args: Record<string, unknown>) {
    _rpcCalls.push({ fn, args });
    const c: Record<string, unknown> = {
      abortSignal: () => c,
      then: (
        resolve: (v: unknown) => unknown,
        reject?: (e: unknown) => unknown,
      ) => {
        const resp = fn === 'match_chunks_hybrid' ? _hybridResponse : _v2Response;
        return Promise.resolve(resp).then(resolve, reject);
      },
    };
    return c;
  }
  return {
    createClient: () => ({
      rpc: (fn: string, args: Record<string, unknown>) => buildRpc(fn, args),
    }),
  };
});

// ─── Subject (importar DESPUÉS de los mocks) ────────────────────────────────
import { searchConstitucionLoal } from './silClient.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function resetState() {
  _rpcCalls.length = 0;
  _hybridResponse = { data: [], error: null };
  _v2Response = { data: [], error: null };
  // Asegurar env para que silClient no aborte al construir el cliente.
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb-test-key';
}

function rawHit(opts: {
  chunk_id: string;
  source_type: string;
  articulo_numero?: string;
  articulo_numero_int?: number;
  titulo_seccion?: string;
  doc?: string;
  content: string;
  url?: string;
  dense?: number;
  rrf?: number;
}) {
  return {
    chunk_id: opts.chunk_id,
    source_type: opts.source_type,
    source_ref: opts.doc
      ? `${opts.doc} · Art. ${opts.articulo_numero ?? '?'}`
      : null,
    content: opts.content,
    dense_similarity: opts.dense ?? null,
    rrf_score: opts.rrf ?? null,
    metadata: {
      subtype: opts.source_type === 'constitucion' ? 'constitucion_articulo' : 'loal_articulo',
      articulo_numero: opts.articulo_numero ?? null,
      articulo_numero_int: opts.articulo_numero_int ?? null,
      titulo_seccion: opts.titulo_seccion ?? null,
      doc: opts.doc ?? null,
      url: opts.url ?? null,
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('searchConstitucionLoal — happy path hybrid', () => {
  beforeEach(resetState);

  it('llama match_chunks_hybrid con los args esperados', async () => {
    _hybridResponse = { data: [], error: null };
    await searchConstitucionLoal({ query: 'tratados internacionales', k: 5 });
    expect(_rpcCalls.length).toBeGreaterThanOrEqual(1);
    const first = _rpcCalls[0];
    expect(first.fn).toBe('match_chunks_hybrid');
    expect(first.args.query_text).toBe('tratados internacionales');
    expect(Array.isArray(first.args.query_embedding)).toBe(true);
    expect((first.args.query_embedding as number[]).length).toBe(3072);
    expect(first.args.rrf_k).toBe(60);
    expect(first.args.filter_source_type).toBeNull();
    // overFetch = max(k*8=40, 24) = 40 (k=5 → 40); cap 60.
    expect(first.args.match_count).toBe(40);
  });

  it('overFetch respeta el cap superior (60) cuando k es alto', async () => {
    _hybridResponse = { data: [], error: null };
    await searchConstitucionLoal({ query: 'q', k: 15 });
    const first = _rpcCalls[0];
    // k=15 → k*8=120 → cap 60.
    expect(first.args.match_count).toBe(60);
  });

  it('clamp k al rango [1, 15]', async () => {
    _hybridResponse = { data: [], error: null };
    await searchConstitucionLoal({ query: 'q', k: 999 });
    const first = _rpcCalls[0];
    // k clamped a 15 → overFetch = min(60, max(120, 24)) = 60.
    expect(first.args.match_count).toBe(60);
  });

  it('filtra hits que NO son constitucion/loal', async () => {
    _hybridResponse = {
      data: [
        rawHit({
          chunk_id: 'a',
          source_type: 'transcript', // ← ruido del corpus
          content: 'sesion plenaria foo',
        }),
        rawHit({
          chunk_id: 'b',
          source_type: 'constitucion',
          articulo_numero: '121',
          articulo_numero_int: 121,
          doc: 'Constitución Política',
          content: 'Artículo 121.- Atribuciones de la Asamblea...',
          rrf: 0.85,
        }),
        rawHit({
          chunk_id: 'c',
          source_type: 'sil_dictamen', // ← otro ruido
          content: 'dictamen sobre tratado',
        }),
      ],
      error: null,
    };
    const out = await searchConstitucionLoal({ query: 'tratados', k: 5 });
    expect(out.length).toBe(1);
    expect(out[0].chunk_id).toBe('b');
    expect(out[0].source_type).toBe('constitucion');
  });

  it('mapea metadata jsonb → campos top-level', async () => {
    _hybridResponse = {
      data: [
        rawHit({
          chunk_id: 'x',
          source_type: 'constitucion',
          articulo_numero: '121',
          articulo_numero_int: 121,
          titulo_seccion: 'TÍTULO IX — Poder Legislativo',
          doc: 'Constitución Política de la República de Costa Rica',
          content: 'Artículo 121.- Además de las otras atribuciones... 4) Aprobar o improbar los convenios internacionales, tratados públicos y concordatos.',
          url: 'https://www.tse.go.cr/pdf/normativa/constitucion.pdf',
          rrf: 0.91,
        }),
      ],
      error: null,
    };
    const out = await searchConstitucionLoal({ query: 'tratados internacionales' });
    expect(out.length).toBe(1);
    const h = out[0];
    expect(h.articulo_numero).toBe('121');
    expect(h.articulo_numero_int).toBe(121);
    expect(h.titulo_seccion).toBe('TÍTULO IX — Poder Legislativo');
    expect(h.doc).toBe('Constitución Política de la República de Costa Rica');
    expect(h.similarity).toBe(0.91);
    expect(h.url).toBe('https://www.tse.go.cr/pdf/normativa/constitucion.pdf');
    expect(h.content).toContain('convenios internacionales');
  });

  it('smoke: buscar "tratados internacionales" devuelve Art. 121 de Constitución', async () => {
    // El mock simula que el RPC indexa este artículo correctamente; este test
    // es el contrato end-to-end del read path. Si en prod la cobertura está
    // bien, este hit ES el que vuelve.
    _hybridResponse = {
      data: [
        rawHit({
          chunk_id: 'const-121',
          source_type: 'constitucion',
          articulo_numero: '121',
          articulo_numero_int: 121,
          titulo_seccion: 'TÍTULO IX',
          doc: 'Constitución Política',
          content: 'Artículo 121.- Además... 4) Aprobar o improbar los convenios internacionales, tratados públicos y concordatos.',
          rrf: 0.88,
        }),
      ],
      error: null,
    };
    const hits = await searchConstitucionLoal({ query: 'aprobación tratados internacionales' });
    expect(hits.length).toBe(1);
    expect(hits[0].articulo_numero).toBe('121');
    expect(hits[0].content).toMatch(/tratados/i);
  });
});

describe('searchConstitucionLoal — fallback paths', () => {
  beforeEach(resetState);

  it('cae a match_chunks_v2 cuando hybrid no existe (42883)', async () => {
    _hybridResponse = { data: null, error: { code: '42883', message: 'function match_chunks_hybrid(...) does not exist' } };
    _v2Response = {
      data: [
        rawHit({
          chunk_id: 'v2-1',
          source_type: 'loal',
          articulo_numero: '11',
          articulo_numero_int: 11,
          doc: 'LOAL',
          content: 'Artículo 11.- Las sesiones ordinarias...',
          dense: 0.75,
        }),
      ],
      error: null,
    };
    const out = await searchConstitucionLoal({ query: 'sesiones ordinarias' });
    expect(_rpcCalls.length).toBe(2); // hybrid intentado, luego v2
    expect(_rpcCalls[0].fn).toBe('match_chunks_hybrid');
    expect(_rpcCalls[1].fn).toBe('match_chunks_v2');
    expect(out.length).toBe(1);
    expect(out[0].source_type).toBe('loal');
    expect(out[0].similarity).toBe(0.75);
  });

  it('devuelve [] cuando ni hybrid ni v2 existen', async () => {
    _hybridResponse = { data: null, error: { code: '42883', message: 'match_chunks_hybrid no existe' } };
    _v2Response = { data: null, error: { code: '42883', message: 'match_chunks_v2 no existe' } };
    const out = await searchConstitucionLoal({ query: 'q' });
    expect(out).toEqual([]);
  });

  it('si el RPC devuelve [] (corpus sin chunks de este source_type) → []', async () => {
    _hybridResponse = { data: [], error: null };
    const out = await searchConstitucionLoal({ query: 'tratados' });
    expect(out).toEqual([]);
  });
});
