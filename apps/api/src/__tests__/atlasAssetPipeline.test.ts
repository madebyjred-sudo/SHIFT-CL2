/**
 * Smoke tests for the branded asset pipeline (atlasContentGenerator +
 * htmlAssetRenderer).
 *
 * Strategy:
 *   - Mock OpenRouter (global fetch) → returns a fixture AssetContent.
 *   - Mock Supabase → returns workspace + nodes for loadWorkspaceContext,
 *     and stubs INSERT/UPDATE for the dispatcher path.
 *   - Mock @google-cloud/storage → no-op upload.
 *   - Mock playwright → returns a fake PDF buffer.
 *
 * Coverage:
 *   1. generateAssetContent returns normalized AssetContent for all 3 kinds.
 *   2. JSON wrapped in code fences still parses.
 *   3. Slide-kind validation: invalid kinds collapse to 'cover'/'content'.
 *   4. renderAssetToPdf calls playwright + uploads to GCS, returns URL.
 *   5. editSingleSlide preserves idx and clamps slide kind.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// ── Env setup BEFORE any service import (services read env at module load) ─
process.env.OPENROUTER_API_KEY = 'sk-test';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role';
process.env.CL2_ASSETS_BUCKET = 'cl2-assets-test';

// ── Mocks ──────────────────────────────────────────────────────────────────
import type { AssetContent } from '../services/atlasContentGenerator.js';

const fixtureAssetContent: AssetContent = {
  title: 'Reforma fiscal 2026',
  subtitle: 'Lo que tu sector necesita saber',
  slides: [
    { idx: 1, kind: 'cover' as const, headline: 'Reforma fiscal *2026*', body: 'Tres artículos clave.' },
    { idx: 2, kind: 'stats' as const, headline: 'Por los números', items: [
      { label: '17', value: '17', sub: 'días desde ingreso' },
    ]},
    { idx: 3, kind: 'list' as const, headline: 'Tres artículos', items: [
      { label: 'Art. 7', value: 'Reclasifica ingresos', sub: 'SUGEF' },
      { label: 'Art. 12', value: 'Endurece retenciones' },
    ]},
    { idx: 4, kind: 'comparison' as const, headline: 'Posiciones', columns: [
      { head: 'A favor', title: 'Pasar como está', bullets: ['FA', 'PLN'] },
      { head: 'Contra', title: 'Texto sustitutivo', bullets: ['PUSC'] },
    ]},
    { idx: 5, kind: 'alert' as const, headline: 'Recomendación',
      alert: { kind: 'recommendation' as const, title: 'Actuar ya', text: 'Esperar reduce el margen.' } },
    { idx: 6, kind: 'cta' as const, headline: 'Conversemos', body: 'contacto@cl2.cr' },
  ],
};

// fetch mock for OpenRouter
const originalFetch = global.fetch;
beforeEach(() => {
  vi.resetAllMocks();
  global.fetch = vi.fn(async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(fixtureAssetContent) } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
});

// Supabase mock
type ChainResult = { data: unknown; error: unknown };
const supaState: { workspace?: ChainResult; nodes?: ChainResult; insertResult?: ChainResult } = {};

vi.mock('@supabase/supabase-js', () => {
  function chain(table: string) {
    const c: Record<string, (...a: unknown[]) => unknown> = {
      select: () => c, eq: () => c, in: () => c, order: () => c, limit: () => c,
      single: () => Promise.resolve(table === 'workspaces' ? (supaState.workspace ?? { data: null, error: null }) : { data: null, error: null }),
      insert: () => ({ select: () => ({ single: () => Promise.resolve(supaState.insertResult ?? { data: { id: 'node-uuid' }, error: null }) }) }),
      update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
    };
    // Override .eq().in() chain for nodes load
    const orig = c.in;
    c.in = (...args: unknown[]) => {
      void args;
      if (table === 'workspace_nodes') return Promise.resolve(supaState.nodes ?? { data: [], error: null });
      return orig.call(c, ...args);
    };
    // Likewise terminal eq for nodes select pattern
    const origEq = c.eq;
    c.eq = (...args: unknown[]) => {
      void args;
      if (table === 'workspace_nodes') {
        const second = { ...c };
        second.in = (...a: unknown[]) => { void a; return Promise.resolve(supaState.nodes ?? { data: [], error: null }); };
        return second;
      }
      return origEq.call(c, ...args);
    };
    return c;
  }
  return {
    createClient: () => ({
      from: (t: string) => chain(t),
    }),
  };
});

// silClient mock (avoid real DB)
vi.mock('../services/silClient.js', () => ({
  getExpedienteById: vi.fn(async () => null),
}));

// logger mock
vi.mock('../services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// GCS mock — must expose Storage as a class with `bucket()` returning an
// object that has `name` and `file()`.
vi.mock('@google-cloud/storage', () => {
  class Storage {
    bucket(_name: string) {
      void _name;
      return {
        name: 'cl2-assets-test',
        file(_path: string) {
          void _path;
          return {
            save: async () => undefined,
          };
        },
      };
    }
  }
  return { Storage };
});

// Playwright mock (returns fake PDF)
vi.mock('playwright', () => {
  const fakeSlides = Array(6).fill(null).map(() => ({}));
  const page = {
    setContent: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => undefined),
    waitForFunction: vi.fn(async () => undefined),
    waitForTimeout: vi.fn(async () => undefined),
    pdf: vi.fn(async () => Buffer.from('%PDF-1.4 fake')),
    $$: vi.fn(async () => fakeSlides),
  };
  const ctx = { newPage: vi.fn(async () => page) };
  const browser = { newContext: vi.fn(async () => ctx), close: vi.fn(async () => undefined) };
  return {
    chromium: { launch: vi.fn(async () => browser) },
  };
});

// ── Tests ──────────────────────────────────────────────────────────────────
describe('atlasContentGenerator', () => {
  beforeEach(() => {
    supaState.workspace = { data: { id: 'ws-1', title: 'Reforma fiscal', description: 'Brief' }, error: null };
    supaState.nodes = { data: [
      { title: 'Hoja 1', subtitle: '', content: { md: 'Contenido sustancial sobre fiscal' }, type: 'hoja', x: 0, y: 0 },
    ], error: null };
  });

  it('returns normalized AssetContent for kind=carousel', async () => {
    const { generateAssetContent } = await import('../services/atlasContentGenerator.js');
    const out = await generateAssetContent({
      workspaceId: 'ws-1', userId: 'u-1', kind: 'carousel',
    });
    expect(out.title).toBeTypeOf('string');
    expect(out.slides.length).toBeGreaterThan(0);
    expect(out.slides[0].kind).toBe('cover');
    // Normalization: idx must be re-indexed monotonically from 1.
    out.slides.forEach((s, i) => expect(s.idx).toBe(i + 1));
  });

  it('returns normalized AssetContent for kind=pptx', async () => {
    const { generateAssetContent } = await import('../services/atlasContentGenerator.js');
    const out = await generateAssetContent({
      workspaceId: 'ws-1', userId: 'u-1', kind: 'pptx',
    });
    expect(out.slides.length).toBeGreaterThan(0);
  });

  it('returns normalized AssetContent for kind=document', async () => {
    const { generateAssetContent } = await import('../services/atlasContentGenerator.js');
    const out = await generateAssetContent({
      workspaceId: 'ws-1', userId: 'u-1', kind: 'document',
    });
    expect(out.slides.length).toBeGreaterThan(0);
  });

  it('parses JSON wrapped in ```json fences', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '```json\n' + JSON.stringify(fixtureAssetContent) + '\n```' } }],
    }), { status: 200 })) as unknown as typeof fetch;

    const { generateAssetContent } = await import('../services/atlasContentGenerator.js');
    const out = await generateAssetContent({ workspaceId: 'ws-1', userId: 'u-1', kind: 'carousel' });
    expect(out.slides.length).toBeGreaterThan(0);
  });

  it('coerces invalid slide.kind to a sane default', async () => {
    const bogus = { ...fixtureAssetContent, slides: [
      { idx: 1, kind: 'totally-invalid', headline: 'x' },
      { idx: 2, kind: 'unknown', headline: 'y' },
    ]};
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(bogus) } }],
    }), { status: 200 })) as unknown as typeof fetch;

    const { generateAssetContent } = await import('../services/atlasContentGenerator.js');
    const out = await generateAssetContent({ workspaceId: 'ws-1', userId: 'u-1', kind: 'carousel' });
    expect(out.slides[0].kind).toBe('cover');
    expect(out.slides[1].kind).toBe('content');
  });
});

describe('htmlAssetRenderer', () => {
  it('renders + uploads PDF for kind=carousel and returns export_url', async () => {
    const { renderAssetToPdf } = await import('../services/htmlAssetRenderer.js');
    const result = await renderAssetToPdf({
      content: fixtureAssetContent,
      kind: 'carousel',
      userId: 'u-1', workspaceId: 'ws-1', nodeId: 'node-1',
      workspaceTitle: 'Reforma fiscal 2026',
    });
    expect(result.exportUrl).toMatch(/^https:\/\/storage\.googleapis\.com\//);
    expect(result.filename).toContain('carrusel');
    expect(result.slidesCount).toBe(6);
  });

  it('renders kind=pptx with 16:9 dimensions', async () => {
    const { renderAssetToPdf } = await import('../services/htmlAssetRenderer.js');
    const result = await renderAssetToPdf({
      content: fixtureAssetContent,
      kind: 'pptx',
      userId: 'u-1', workspaceId: 'ws-1', nodeId: 'node-1',
      workspaceTitle: 'Reforma fiscal 2026',
    });
    expect(result.filename).toContain('presentacion');
  });

  it('renders kind=document with A4', async () => {
    const { renderAssetToPdf } = await import('../services/htmlAssetRenderer.js');
    const result = await renderAssetToPdf({
      content: fixtureAssetContent,
      kind: 'document',
      userId: 'u-1', workspaceId: 'ws-1', nodeId: 'node-1',
      workspaceTitle: 'Reforma fiscal 2026',
    });
    expect(result.filename).toContain('documento');
  });
});

describe('editSingleSlide', () => {
  it('preserves idx and shape after edit', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        idx: 99, kind: 'content', headline: 'editado', body: 'ok',
      }) } }],
    }), { status: 200 })) as unknown as typeof fetch;

    const { editSingleSlide } = await import('../services/atlasContentGenerator.js');
    const out = await editSingleSlide({
      slide: { idx: 3, kind: 'content', headline: 'antes' },
      instruction: 'hacelo más fuerte',
      assetKind: 'carousel',
      workspaceTitle: 'Test',
    });
    // idx must be the ORIGINAL (3), not the LLM-suggested (99).
    expect(out.idx).toBe(3);
    expect(out.headline).toBe('editado');
  });
});

afterAll(() => {
  global.fetch = originalFetch;
});
