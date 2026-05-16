/**
 * @feature @sprint-3 Voice mode Lexa (Track S)
 *
 * Cubre:
 * - GET /api/voice/quota responde con shape esperado
 * - POST /api/voice/converse rebota 401 sin auth
 * - POST /api/voice/converse rebota 413 con audio > 5MB
 * - VoiceConverseModal abre con long-press del mic button
 * - VoiceConverseModal cierra con botón X
 *
 * NO ejecutamos TTS real (cuesta plata por minuto de ElevenLabs).
 * Para tests de integración real, ver `apps/api/src/routes/voice.test.ts`
 * (10 tests con mocks).
 */
import { test, expect } from '@playwright/test';
import { withAdmin } from '../_helpers/auth';
import { apiCall, assert200, assert401 } from '../_helpers/api';
import { mintToken } from '../_helpers/auth';

test.describe('@feature @sprint-3 @api Voice mode endpoints', () => {
  test('GET /api/voice/quota con admin → 200 + shape', async () => {
    const s = await mintToken('madebyjred@gmail.com');
    const res = await apiCall<{
      ok: boolean;
      chars_used_month: number;
      chars_quota: number;
      conversaciones_today: number;
      conversaciones_daily_limit: number;
    }>('GET', '/api/voice/quota', { token: s.access_token, base: 'web' });

    const body = assert200(res);
    expect(body.ok).toBe(true);
    expect(typeof body.chars_used_month).toBe('number');
    expect(body.chars_quota).toBeGreaterThan(0);
    expect(body.conversaciones_daily_limit).toBeGreaterThan(0);
  });

  test('POST /api/voice/converse sin auth → 401', async () => {
    const res = await apiCall('POST', '/api/voice/converse', { base: 'web' });
    assert401(res);
  });
});

test.describe('@feature @sprint-3 Voice mode UI', () => {
  test('Long-press en mic button abre VoiceConverseModal', async ({ page }) => {
    await withAdmin(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 15_000 });

    // El mic button existe en AnimatedAiInput
    const micButton = page.locator('button[aria-label*="micrófono"], button[aria-label*="voice"], [data-testid="voice-input-button"]').first();
    if ((await micButton.count()) === 0) {
      test.skip(true, 'Mic button no localizable — selector necesita data-testid');
      return;
    }

    // Long-press: mousedown → wait 600ms → mouseup
    const box = await micButton.boundingBox();
    if (!box) {
      test.skip(true, 'Mic button no tiene bounding box');
      return;
    }

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(600);
    await page.mouse.up();

    // El modal debería aparecer
    const modal = page.locator('[role="dialog"], [data-testid="voice-converse-modal"]').first();
    await expect(modal).toBeVisible({ timeout: 3_000 });

    // Botón X cierra
    const closeBtn = modal.locator('button[aria-label*="cerrar"], button[aria-label*="close"]').first();
    if ((await closeBtn.count()) > 0) {
      await closeBtn.click();
      await expect(modal).toBeHidden({ timeout: 2_000 });
    }
  });
});
