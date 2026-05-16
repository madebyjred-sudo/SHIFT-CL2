/**
 * @api @critical
 *
 * Contract tests del endpoint /api/expedientes/:numero/full.
 * Asegura que el shape devuelto al frontend no rompa.
 */
import { test, expect } from '@playwright/test';
import { apiCall, assert200 } from '../_helpers/api';
import { mintToken } from '../_helpers/auth';

test.describe('@api @critical /api/expedientes/:numero/full', () => {
  test('admin → 200 con shape completo', async () => {
    const s = await mintToken('madebyjred@gmail.com');
    const res = await apiCall<{ ok: boolean; expediente: any }>(
      'GET',
      '/api/expedientes/23.511/full',
      { token: s.access_token, base: 'web' },
    );
    const body = assert200(res);
    const exp = body.expediente;

    // Core tables (Sprint 1 v3)
    expect(exp.general).toBeDefined();
    expect(exp.general.numero).toBe('23.511');
    expect(exp.tramite).toBeInstanceOf(Array);
    expect(exp.proponentes).toBeInstanceOf(Array);
    expect(exp.consultas).toBeInstanceOf(Array);
    expect(exp.documentos).toBeInstanceOf(Array);

    // Sprint v3 — top-level keys (post Track H)
    expect(exp.fechas_extraidas).toBeDefined();
    expect(exp.audiencias).toBeInstanceOf(Array);
    expect(exp.actas_comision).toBeInstanceOf(Array);
    expect(exp.consultas_sala_constitucional).toBeInstanceOf(Array);
    expect(exp.orden_dia_apariciones).toBeInstanceOf(Array);
    expect(exp.novedades_detectadas).toBeInstanceOf(Array);

    // _source diagnóstico (post Track H + I)
    expect(exp._source).toBeDefined();
    expect(['tabla_dedicada', 'metadata_jsonb']).toContain(exp._source.fechas);
    expect(['centinela_eventos', 'detector_live', 'metadata_jsonb']).toContain(exp._source.novedades);
  });

  test('numero inexistente → 404', async () => {
    const s = await mintToken('madebyjred@gmail.com');
    const res = await apiCall('GET', '/api/expedientes/99.999/full', {
      token: s.access_token,
      base: 'web',
    });
    expect(res.status).toBe(404);
  });

  test('sin auth → 401', async () => {
    const res = await apiCall('GET', '/api/expedientes/23.511/full', { base: 'web' });
    expect(res.status).toBe(401);
  });
});

test.describe('@api @critical /api/decretos/estado-plenario', () => {
  test('admin → 200 con métricas + decretos recientes', async () => {
    const s = await mintToken('madebyjred@gmail.com');
    const res = await apiCall<{ ok: boolean; data: any }>(
      'GET',
      '/api/decretos/estado-plenario',
      { token: s.access_token, base: 'web' },
    );
    const body = assert200(res);
    expect(body.data.total_convocados).toBeGreaterThanOrEqual(0);
    expect(body.data.total_retirados).toBeGreaterThanOrEqual(0);
    expect(body.data.top_recientes).toBeInstanceOf(Array);
  });
});
