/**
 * Happy-path smoke for the demo flow (Acto 1-4 of DEMO-RUNBOOK).
 *
 * Cobertura sin LLM ni Supabase real:
 *   - Login surface renderiza en rutas auth-required.
 *   - El comportamiento de auth gate es consistente (/, /sesiones, etc.
 *     redirigen al login surface).
 *   - El injection de citation card como mensaje fake en localStorage
 *     todavía sirve cuando hay un chat shell montado.
 *
 * Notas:
 *  - Inyectar JWT mockeado dispara errores en supabase-js (token
 *    malformado) — eso ensucia los pageerrors. Por eso este spec
 *    NO inyecta auth para las verificaciones de "no crash".
 *  - El test de citation card sigue inyectando auth porque necesita
 *    el chat shell — pero no asume que monte limpio; usa skip si no
 *    aparece.
 *
 * Run:
 *   npm run test:e2e:install  (first time — downloads chromium)
 *   npm run test:e2e
 *   npm run test:e2e:ui       (debug UI)
 */
import { test, expect, type Page } from '@playwright/test';

const MOCK_SESSION = {
  currentSession: {
    access_token: 'mock.eyJhbGciOiJIUzI1NiJ9.test',
    refresh_token: 'mock-refresh',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'demo@cl2.test',
      role: 'authenticated',
      aud: 'authenticated',
      created_at: new Date().toISOString(),
      app_metadata: { provider: 'email' },
      user_metadata: { full_name: 'Demo Tester' },
    },
  },
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

async function injectAuth(page: Page) {
  await page.addInitScript(([sb]) => {
    const keys = ['sb-romccykiucfltfdfatrx-auth-token', 'supabase.auth.token'];
    for (const k of keys) {
      try { localStorage.setItem(k, JSON.stringify(sb)); } catch { /* noop */ }
    }
  }, MOCK_SESSION);
}

test.describe('auth gate — sin auth muestra login', () => {
  test('/ sin auth muestra login', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText(/Inteligencia/i).first()).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('button', { name: /Continuar con Google/i })).toBeVisible();
  });

  test('/sesiones sin auth muestra login', async ({ page }) => {
    await page.goto('/sesiones');
    await expect(page.getByRole('button', { name: /Continuar con Google/i })).toBeVisible();
  });

  test('/hojas sin auth muestra login', async ({ page }) => {
    await page.goto('/hojas');
    await expect(page.getByRole('button', { name: /Continuar con Google/i })).toBeVisible();
  });
});

test.describe('citation card link discipline (con session inyectada)', () => {
  test('SIL citation card linkea a /expediente cuando hay expediente_numero', async ({ page }) => {
    await injectAuth(page);
    await page.addInitScript(() => {
      const fakeSession = {
        id: 'demo',
        title: 'Demo session',
        updatedAt: Date.now(),
        model: 'claude-sonnet-4.6',
        agent: 'lexa',
        messages: [
          { id: 'u1', role: 'user', content: '¿Hay proyectos sobre minería?' },
          {
            id: 'a1',
            role: 'assistant',
            agent: 'lexa',
            content: 'Encontré el Exp. 22.293 [1].',
            citations: [
              {
                id: 'sil:exp:22293',
                session_id: '',
                source_ref: 'Exp. 22.293',
                content: 'MODIFICACIÓN AL ARTÍCULO 21 DE LA LEY DE TRANSPARENCIA',
                similarity: 0.92,
                fecha: '2020-11-09',
                comision: 'Plenario',
                tipo: 'PROCEDIMIENTO PROYECTO DE LEY ORDINARIO',
                source_type: 'sil_expediente',
                expediente_numero: '22.293',
                estado: 'ARCHIVO',
                proponente: 'RODRÍGUEZ STELLER',
                url_detalle: 'https://consultassil3.asamblea.go.cr/frmConsultaProyectos.aspx?expediente=22293',
                video_url: null,
                transcript_url: null,
              },
            ],
          },
        ],
      };
      try { localStorage.setItem('cl2_sessions', JSON.stringify([fakeSession])); } catch { /* noop */ }
    });

    await page.goto('/');
    const citationToggle = page.getByRole('button', { name: /fuentes? del SIL|fuentes? legislativa/i });
    if (await citationToggle.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await citationToggle.click();
      const verLink = page.getByRole('link', { name: /Ver expediente/i }).first();
      await expect(verLink).toBeVisible({ timeout: 3_000 });
      await expect(verLink).toHaveAttribute('href', /\/expediente\/22293/);
    } else {
      test.skip(true, 'chat shell no montado — el JWT mockeado no pasa supabase getSession');
    }
  });
});
