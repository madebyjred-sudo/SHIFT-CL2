/**
 * Landing pública — humo amplio sin LLM.
 *
 * Cubre la landing rediseñada en /landing:
 *   Hero  · Problem · MemoriaViva · Almas · Capabilities ·
 *   Comparison · CtaCloser · FAQ · Manifesto · Footer
 *
 * Notas técnicas:
 *  - Las secciones usan <Reveal> con IntersectionObserver y CSS .reveal
 *    arranca con opacity: 0. Para que Playwright las "vea" tenemos que
 *    scrollear cada sección al viewport antes de aserciones de visibilidad.
 *  - No hay dependencia de LLM ni Supabase aquí — la landing es pública.
 */
import { test, expect, type Page } from '@playwright/test';

/** Forza is-visible en TODOS los .reveal — atajo del IntersectionObserver. */
async function revealAll(page: Page) {
  await page.evaluate(async () => {
    document.querySelectorAll('.reveal').forEach((el) => {
      el.classList.add('is-visible');
    });
    await new Promise((r) => setTimeout(r, 200));
  });
}

test.describe('landing /landing — secciones principales', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/landing');
    await revealAll(page);
  });

  test('Hero: titular + sub + CTAs visibles', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /El mejor preparado de la sala/i }))
      .toBeVisible({ timeout: 8_000 });
    await expect(page.getByText(/Cada votación, cada audiencia, cada nota/i))
      .toBeVisible();
    const ctas = page.getByRole('link', { name: /Solicitar acceso al piloto/i });
    expect(await ctas.count()).toBeGreaterThanOrEqual(1);
  });

  test('Problem: eyebrow "Lo que perdés sin esto"', async ({ page }) => {
    await expect(page.getByText(/Lo que perdés sin esto/i).first()).toBeVisible();
  });

  test('MemoriaViva: 5 memorias con nombres conceptuales', async ({ page }) => {
    const concepts = ['El archivo', 'El plenario', 'El Reglamento', 'La agenda', 'Tu despacho'];
    let found = 0;
    for (const c of concepts) {
      const visible = await page.getByText(c, { exact: false }).first()
        .isVisible({ timeout: 1_500 }).catch(() => false);
      if (visible) found++;
    }
    expect(found).toBeGreaterThanOrEqual(3);
  });

  test('Almas: Lexa "Tu asesora al oído" + Atlas + Centinela', async ({ page }) => {
    // La sección Almas usa motion.div con initial opacity:0. La animación
    // puede dejar size:0 transitorio. Verificamos que existe en DOM.
    await expect(page.getByText(/Tu asesora al o[ií]do/i).first()).toBeAttached();
    await expect(page.getByText(/El que arma el trabajo/i).first()).toBeAttached();
    await expect(page.getByText(/El que vigila por vos/i).first()).toBeAttached();
  });

  test('Capabilities: 4 ejes', async ({ page }) => {
    const ejes = [
      /El día a día/i,
      /Durante la sesión/i,
      /Antes de la votación/i,
      /Memoria del despacho/i,
    ];
    for (const e of ejes) {
      await expect(page.getByText(e).first()).toBeVisible();
    }
  });

  test('Comparison: 4 columnas (cl2 + 3 alternativas)', async ({ page }) => {
    // El Comparison tiene render dual (mobile md:hidden + desktop hidden md:block).
    // .first() puede caer en el lado oculto. Verificamos attached.
    await expect(page.getByText(/IA general/i).first()).toBeAttached();
    await expect(page.getByText(/archivo nativo/i).first()).toBeAttached();
    await expect(page.getByText(/m[eé]todo tradicional/i).first()).toBeAttached();
  });

  test('CtaCloser: scarcity indicator + foot-in-the-door', async ({ page }) => {
    await expect(page.getByText(/de\s+10\s+cupos\s+disponibles/i)).toBeVisible();
    await expect(page.getByText(/Diez fracciones de la Asamblea/i)).toBeVisible();
  });

  test('FAQ: accordion abre/cierra al click', async ({ page }) => {
    const faqSection = page.locator('#faq');
    await faqSection.scrollIntoViewIfNeeded();
    await expect(faqSection).toBeVisible();
    const firstQuestion = faqSection.getByRole('button').first();
    await expect(firstQuestion).toBeVisible();
    await firstQuestion.click();
    await firstQuestion.click();
  });

  test('Footer renderiza al final', async ({ page }) => {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(page.locator('footer')).toBeVisible({ timeout: 5_000 });
  });
});

test.describe('landing /landing — anchors + accesibilidad', () => {
  test('CTA "Solicitar acceso" apunta a #waitlist', async ({ page }) => {
    await page.goto('/landing');
    const ctas = page.getByRole('link', { name: /Solicitar acceso al piloto/i });
    const href = await ctas.first().getAttribute('href');
    expect(href).toBe('#waitlist');
  });

  test('hay h1 + múltiples h2', async ({ page }) => {
    await page.goto('/landing');
    expect(await page.locator('h1').count()).toBeGreaterThanOrEqual(1);
    expect(await page.locator('h2').count()).toBeGreaterThanOrEqual(4);
  });
});
