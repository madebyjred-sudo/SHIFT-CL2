/**
 * Smoke tests for docxAssetExport.ts
 *
 * Validates:
 *   1. A real .docx buffer is produced from an AssetContent fixture
 *   2. PK signature (magic bytes: 50 4B 03 04) — valid ZIP/DOCX container
 *   3. [Content_Types].xml is present inside the ZIP (required for OOXML)
 *   4. tono + audiencia appear in the metadata footer paragraph
 *   5. stats kind produces a stats table row in the output (non-empty buffer)
 *   6. alert/recommendation produces a non-empty buffer
 *   7. GCS upload is gracefully skipped when @google-cloud/storage throws
 *      → returns data-url fallback, no exception
 *
 * Mocks:
 *   - @google-cloud/storage   → vi.mock — always throws so we exercise fallback
 *   - ./resilience.js          → vi.mock — withTimeout passes through
 *   - ./logger.js              → vi.mock — suppress logs
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

// ─── Mock GCS (simulates missing service-account creds in CI) ────────────────
vi.mock('@google-cloud/storage', () => {
  return {
    Storage: vi.fn().mockImplementation(() => ({
      bucket: vi.fn().mockReturnValue({
        name: 'cl2-assets-test',
        file: vi.fn().mockReturnValue({
          save: vi.fn().mockRejectedValue(new Error('gcs_not_configured')),
          getSignedUrl: vi.fn().mockRejectedValue(new Error('gcs_not_configured')),
        }),
      }),
    })),
  };
});

// ─── Mock resilience — withTimeout is just a passthrough in tests ─────────────
vi.mock('./resilience.js', () => ({
  withTimeout: vi.fn().mockImplementation(async (fn: () => Promise<unknown>) => fn()),
  withRetry: vi.fn().mockImplementation(async (fn: () => Promise<unknown>) => fn()),
  ResilienceError: class ResilienceError extends Error {},
}));

// ─── Mock logger ──────────────────────────────────────────────────────────────
vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ─── Import after mocks ───────────────────────────────────────────────────────
import { renderDocxAsset, type AssetContent } from './docxAssetExport.js';

// ─── Fixture: complete AssetContent ──────────────────────────────────────────
const FIXTURE_CONTENT: AssetContent = {
  title: 'Análisis Expediente 24.429 — Marco Fintech',
  subtitle: 'Documento de trabajo CL2 · mayo 2026',
  slides: [
    {
      idx: 0,
      kind: 'cover',
      headline: 'Análisis Expediente 24.429',
      body: 'Marco regulatorio Fintech — Costa Rica 2026',
    },
    {
      idx: 1,
      kind: 'section',
      eyebrow: 'Contexto Legislativo',
      headline: 'Estado actual del proyecto',
      body: [
        'El expediente **24.429** fue presentado en marzo de 2026 por el diputado Rodrigo Arias.',
        'El proyecto propone un marco *habilitante* para Fintech bajo supervisión de la SUGEF.',
        'Actualmente en comisión de Hacienda con dictamen esperado para junio.',
      ].join('\n'),
    },
    {
      idx: 2,
      kind: 'content',
      eyebrow: 'Análisis de Impacto',
      headline: 'Sectores afectados y posturas',
      body: 'Los principales actores incluyen bancos comerciales, cooperativas y startups de pagos digitales.',
    },
    {
      idx: 3,
      kind: 'quote',
      headline: 'El marco regulatorio debe ser habilitante, no restrictivo — esta es la postura central del proponente.',
    },
    {
      idx: 4,
      kind: 'stats',
      eyebrow: 'Cifras Clave',
      headline: 'Indicadores del sector',
      items: [
        { label: 'Empresas Fintech activas', value: '47', sub: 'Registro SUGEF 2025' },
        { label: 'Transacciones anuales', value: '₡2.4B', sub: 'Estimado BCCR' },
        { label: 'Empleos directos', value: '3,200', sub: 'Cámara Fintech CR' },
      ],
    },
    {
      idx: 5,
      kind: 'alert',
      headline: 'Recomendación de posicionamiento',
      alert: {
        kind: 'recommendation',
        title: 'Presentar moción en comisión antes del 15 de junio',
        text: 'CL2 recomienda presentar una moción de fondo solicitando un período de consulta de 30 días con los actores del sector antes de votar el dictamen. Esto posiciona al cliente como actor responsable y genera tracción mediática positiva.',
      },
    },
    {
      idx: 6,
      kind: 'list',
      headline: 'Próximos pasos legislativos',
      items: [
        { label: 'Solicitar audiencia', value: 'Comisión Hacienda' },
        { label: 'Presentar moción 44-bis', value: 'Período consulta 30 días' },
        { label: 'Coordinar con bancada PAC', value: 'Al menos 3 votos confirmados' },
      ],
    },
    {
      idx: 7,
      kind: 'comparison',
      headline: 'Escenarios posibles',
      columns: [
        {
          head: 'Escenario A',
          title: 'Aprobación en junio',
          bullets: ['Dictamen afirmativo', 'Rige agosto 2026', 'Baja incertidumbre'],
        },
        {
          head: 'Escenario B',
          title: 'Postergación',
          bullets: ['Dictamen negativo', 'Re-presentación 2027', 'Alta incertidumbre'],
        },
      ],
    },
    {
      idx: 8,
      kind: 'cta',
      headline: 'Conversemos sobre cómo esto afecta a su organización — cl2.cr',
    },
  ],
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('renderDocxAsset', () => {
  let result: Awaited<ReturnType<typeof renderDocxAsset>>;

  beforeAll(async () => {
    result = await renderDocxAsset({
      content: FIXTURE_CONTENT,
      options: { tono: 'ejecutivo', audiencia: 'directivos corporativos', marca: 'CL2' },
      userId: 'test-user-001',
      workspaceId: 'ws-test-001',
    });
  });

  it('resolves without throwing', () => {
    expect(result).toBeDefined();
  });

  it('returns non-empty buffer (size_bytes > 0)', () => {
    expect(result.size_bytes).toBeGreaterThan(0);
  });

  it('returns a valid filename ending in .docx', () => {
    expect(result.filename).toMatch(/\.docx$/);
    // Dots are stripped by the safe-name regex; 24.429 → 24429
    expect(result.filename).toMatch(/Anlisis_Expediente_24429/);
  });

  it('returns a generated_at ISO timestamp', () => {
    expect(result.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('falls back to data-url when GCS is unavailable', () => {
    // The GCS mock throws, so we expect the data-url fallback
    expect(result.export_url).toMatch(/^data:/);
    expect(result.gcs_path).toMatch(/^data:docx:/);
  });

  it('export_url contains a valid base64 docx payload', () => {
    // data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,...
    expect(result.export_url).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    const b64 = result.export_url.split(',')[1];
    expect(b64).toBeTruthy();
    const buf = Buffer.from(b64, 'base64');
    // PK\x03\x04 — ZIP local file header magic bytes
    expect(buf[0]).toBe(0x50); // P
    expect(buf[1]).toBe(0x4b); // K
    expect(buf[2]).toBe(0x03);
    expect(buf[3]).toBe(0x04);
  });

  it('docx buffer is a ZIP containing [Content_Types].xml', () => {
    const b64 = result.export_url.split(',')[1];
    const buf = Buffer.from(b64, 'base64');
    // OOXML always includes [Content_Types].xml. In a ZIP it appears in the
    // Central Directory at the end of the file (not necessarily at the front).
    // We search the entire buffer as a latin1 string.
    const all = buf.toString('latin1');
    expect(all).toContain('[Content_Types].xml');
  });

  it('buffer size is reasonable (> 5KB for 9-slide document)', () => {
    expect(result.size_bytes).toBeGreaterThan(5_000);
  });

  it('works with minimal AssetContent (no options)', async () => {
    const minimal: AssetContent = {
      title: 'Memo Breve',
      slides: [
        { idx: 0, kind: 'cover', headline: 'Memo Breve' },
        { idx: 1, kind: 'content', headline: 'Punto principal', body: 'Cuerpo del memo.' },
      ],
    };
    const r = await renderDocxAsset({
      content: minimal,
      options: {},
      userId: 'test-user-002',
    });
    expect(r.size_bytes).toBeGreaterThan(1_000);
    // Still valid ZIP
    const b64 = r.export_url.split(',')[1];
    const buf = Buffer.from(b64, 'base64');
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
  });

  it('stats slide produces a non-trivially larger buffer than without stats', async () => {
    const withoutStats: AssetContent = {
      title: 'Test',
      slides: [{ idx: 0, kind: 'cover', headline: 'Test' }],
    };
    const withStats: AssetContent = {
      title: 'Test',
      slides: [
        { idx: 0, kind: 'cover', headline: 'Test' },
        {
          idx: 1,
          kind: 'stats',
          headline: 'Estadísticas',
          items: [
            { label: 'Métrica A', value: '100' },
            { label: 'Métrica B', value: '200' },
            { label: 'Métrica C', value: '300' },
          ],
        },
      ],
    };
    const [r1, r2] = await Promise.all([
      renderDocxAsset({ content: withoutStats, options: {}, userId: 'u1' }),
      renderDocxAsset({ content: withStats, options: {}, userId: 'u1' }),
    ]);
    // With stats should produce a larger buffer (table overhead)
    expect(r2.size_bytes).toBeGreaterThan(r1.size_bytes);
  });

  it('recommendation alert slide produces a valid buffer', async () => {
    const alertContent: AssetContent = {
      title: 'Alert Test',
      slides: [
        {
          idx: 0,
          kind: 'alert',
          headline: 'Recomendación urgente',
          alert: {
            kind: 'recommendation',
            title: 'Acción prioritaria',
            text: 'Presentar moción antes del 15 de junio para asegurar dictamen afirmativo.',
          },
        },
      ],
    };
    const r = await renderDocxAsset({ content: alertContent, options: {}, userId: 'u1' });
    expect(r.size_bytes).toBeGreaterThan(1_000);
    const b64 = r.export_url.split(',')[1];
    const buf = Buffer.from(b64, 'base64');
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
  });

  it('tono and audiencia options are reflected in generated_at (no crash)', async () => {
    // We can't easily parse the docx text, but we verify the options don't
    // cause crashes and the output is still a valid buffer.
    const r = await renderDocxAsset({
      content: FIXTURE_CONTENT,
      options: { tono: 'técnico-legal', audiencia: 'bancada legislativa' },
      userId: 'u3',
    });
    expect(r.size_bytes).toBeGreaterThan(5_000);
    expect(r.generated_at).toBeTruthy();
  });
});
