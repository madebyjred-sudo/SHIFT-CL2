/**
 * @smoke @critical
 *
 * Smoke tests del health endpoint y endpoints públicos críticos.
 * Corre en < 30s. Falla → no se deploya.
 */
import { test, expect } from '@playwright/test';
import { apiCall, assert200 } from '../_helpers/api';
import { mintToken } from '../_helpers/auth';

test.describe('@smoke @critical Health + endpoints públicos', () => {
  test('GET /health responds 200 + service shape', async () => {
    const res = await apiCall<{ ok: boolean; service: string; tenant: string; timestamp: string }>(
      'GET',
      '/health',
    );
    const body = assert200(res);
    expect(body.ok).toBe(true);
    expect(body.service).toMatch(/cl2/i);
    expect(body.tenant).toBe('cl2');
    expect(new Date(body.timestamp).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  test('GET /api/agents responds 200 con 3 agents (lexa, atlas, centinela)', async () => {
    const res = await apiCall<{ ok: boolean; agents: Array<{ id: string }> }>('GET', '/api/agents');
    const body = assert200(res);
    expect(body.ok).toBe(true);
    expect(body.agents).toHaveLength(3);
    const ids = body.agents.map((a) => a.id).sort();
    expect(ids).toEqual(['atlas', 'centinela', 'lexa']);
  });

  test('GET /api/me sin auth responde 401', async () => {
    const res = await apiCall('GET', '/api/me');
    expect(res.status).toBe(401);
  });

  test('GET /api/me con admin token responde 200 + role=admin', async () => {
    const s = await mintToken('madebyjred@gmail.com');
    const res = await apiCall<{ ok: boolean; user: { role: string; status: string; email: string } }>(
      'GET',
      '/api/me',
      { token: s.access_token },
    );
    const body = assert200(res);
    expect(body.user.role).toBe('admin');
    expect(body.user.status).toBe('active');
    expect(body.user.email).toBe('madebyjred@gmail.com');
  });
});
