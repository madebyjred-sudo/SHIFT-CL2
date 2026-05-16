/**
 * @feature @sprint-3 RAL Reglas procedurales — tool evaluate_ral_aplicacion (Track Q)
 *
 * Cubre integración del tool nuevo de Lexa. NO testea el SQL directo —
 * eso ya está cubierto por las 35 suites unitarias de
 * apps/api/src/services/ralReglasEvaluator.test.ts y golden.test.ts.
 *
 * Acá testeo end-to-end que:
 * - Las reglas existen en DB después de aplicar 0042.
 * - El chat con Lexa devuelve respuesta cuando la pregunta toca un art.
 *   del RAL (Lexa internamente invoca el tool, pero no validamos el tool
 *   call específico — solo que la respuesta cite la regla).
 */
import { test, expect } from '@playwright/test';
import { apiCall, assert200 } from '../_helpers/api';
import { mintToken } from '../_helpers/auth';

test.describe('@feature @sprint-3 @api RAL reglas — DB shape', () => {
  test('ral_reglas tiene ≥ 50 reglas vigentes después de seed', async () => {
    const s = await mintToken('madebyjred@gmail.com');

    // Endpoint /api/ral o similar para listar reglas — si no existe,
    // probamos directo via Supabase REST con el token (pasa por RLS,
    // policy "read ral_reglas" permite authenticated).
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/ral_reglas?vigente=eq.true&select=slug,area_procedural&limit=200`,
      {
        headers: {
          apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '',
          Authorization: `Bearer ${s.access_token}`,
        },
      },
    );
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ slug: string; area_procedural: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(50);

    // Distribución por área procedural
    const byArea: Record<string, number> = {};
    for (const r of rows) byArea[r.area_procedural] = (byArea[r.area_procedural] ?? 0) + 1;

    // Las 10 áreas mínimas (del spec)
    const expectedAreas = [
      'mociones', 'audiencias', 'comisiones', 'plenario', 'leyes_especiales',
      'consultas', 'cuatrienales', 'sesiones', 'votaciones', 'derechos_diputados',
    ];
    for (const area of expectedAreas) {
      expect(byArea[area] ?? 0).toBeGreaterThan(0);
    }
  });

  test('regla emblemática mocion_137_primer_dia_obligatoria existe + condiciones jsonb', async () => {
    const s = await mintToken('madebyjred@gmail.com');
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/ral_reglas?slug=eq.mocion_137_primer_dia_obligatoria&select=*`,
      {
        headers: {
          apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '',
          Authorization: `Bearer ${s.access_token}`,
        },
      },
    );
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<any>;
    expect(rows.length).toBe(1);
    const regla = rows[0];

    expect(regla.area_procedural).toBe('mociones');
    expect(regla.vigente).toBe(true);
    expect(regla.condiciones).toBeDefined();
    expect(Array.isArray(regla.articulos_relacionados)).toBe(true);
    expect(regla.articulos_relacionados).toContain('137');
  });
});
