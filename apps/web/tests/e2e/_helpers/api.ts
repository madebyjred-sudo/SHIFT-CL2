/**
 * API helper para tests sin browser.
 *
 * Use cases:
 *   - Smoke testing de endpoints
 *   - Contract tests (shape de response)
 *   - Setup data antes de un UI test
 *
 * Patrón:
 *   import { apiCall } from '../_helpers/api';
 *   import { mintToken } from '../_helpers/auth';
 *
 *   test('@api endpoint X', async () => {
 *     const s = await mintToken('madebyjred@gmail.com');
 *     const res = await apiCall('GET', '/api/expedientes/23.511/full', { token: s.access_token });
 *     expect(res.status).toBe(200);
 *     expect(res.body.expediente.audiencias).toBeInstanceOf(Array);
 *   });
 */
import { E2E_ENV } from './env';

export interface ApiResponse<T = unknown> {
  status: number;
  ok: boolean;
  body: T;
  headers: Record<string, string>;
}

export interface ApiOptions {
  /** Bearer token. Sin este, llamada va sin auth y la mayoría de endpoints rebotan 401. */
  token?: string;
  /** Body para POST/PUT/PATCH. Stringificado automáticamente como JSON. */
  body?: unknown;
  /** Query params {key: value} → ?key=value */
  query?: Record<string, string | number | boolean | undefined>;
  /** Override de base URL. Default: E2E_ENV.apiBaseUrl o webBaseUrl (proxy). */
  base?: 'api' | 'web';
  /** Timeout ms. Default 30s. */
  timeoutMs?: number;
}

function buildUrl(path: string, opts: ApiOptions): string {
  const base = opts.base === 'web' ? E2E_ENV.webBaseUrl : E2E_ENV.apiBaseUrl;
  const url = new URL(path, base);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export async function apiCall<T = unknown>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  opts: ApiOptions = {},
): Promise<ApiResponse<T>> {
  const url = buildUrl(path, opts);
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  const ct = res.headers.get('content-type') ?? '';
  let body: T;
  if (ct.includes('application/json')) {
    body = (await res.json()) as T;
  } else {
    body = (await res.text()) as unknown as T;
  }

  const headerObj: Record<string, string> = {};
  res.headers.forEach((v, k) => { headerObj[k] = v; });

  return {
    status: res.status,
    ok: res.ok,
    body,
    headers: headerObj,
  };
}

// ─── Common assertions ────────────────────────────────────────────────────

export function assert200<T>(res: ApiResponse<T>): T {
  if (res.status !== 200) {
    throw new Error(`Expected 200, got ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
  }
  return res.body;
}

export function assert401<T>(res: ApiResponse<T>): void {
  if (res.status !== 401) {
    throw new Error(`Expected 401, got ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
  }
}

export function assert403<T>(res: ApiResponse<T>): void {
  if (res.status !== 403) {
    throw new Error(`Expected 403, got ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
  }
}
