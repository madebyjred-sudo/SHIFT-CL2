/**
 * capture-pedidos-real.mjs — toma las 17 capturas que faltan, contra LOCAL DEV
 *   apuntando a producción Supabase + producción API.
 *
 * Por qué local dev: las páginas de prod tienen debug labels visibles (confidence,
 * filenames .ts, slugs sin formato). Las edits del 17-may esconden esos labels —
 * pero esas edits viven en working tree, no en deploy. Ejecutar contra localhost
 * con esos cambios da capturas limpias mientras los datos siguen siendo reales.
 *
 * Auth: mintToken via Supabase admin generateLink + verifyOtp (sin rotar password).
 *
 * Setup pre-corrida:
 *   1. cd apps/web && npm run dev  (background, port 5173)
 *   2. Confirmar que VITE_API_BASE_URL apunta a prod API
 *
 * Salida: PNG en /Users/juan/AGENTS/CL2/sprints/28-pedidos-2026-05-15/<key>.png
 */
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import path from 'node:path';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://romccykiucfltfdfatrx.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PROD_API = 'https://cl2-v2-api-u3rliii7wa-uc.a.run.app';
const LOCAL_WEB = 'http://localhost:5173';
const ADMIN_EMAIL = 'madebyjred@gmail.com';
const OUT_DIR = '/Users/juan/AGENTS/CL2/sprints/28-pedidos-2026-05-15';

if (!SUPABASE_SERVICE_KEY) {
  console.error('Set SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function mintAdminJwt() {
  const { data: link, error: linkErr } = await supa.auth.admin.generateLink({
    type: 'magiclink',
    email: ADMIN_EMAIL,
  });
  if (linkErr) throw linkErr;
  const { data: sess, error: verifyErr } = await supa.auth.verifyOtp({
    type: 'magiclink',
    token_hash: link.properties.hashed_token,
  });
  if (verifyErr) throw verifyErr;
  return sess.session;
}

async function injectAuth(page, session) {
  const projectRef = SUPABASE_URL.replace('https://', '').replace('.supabase.co', '');
  const key = `sb-${projectRef}-auth-token`;
  const stored = {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
    expires_in: session.expires_in ?? 3600,
    token_type: 'bearer',
    user: session.user,
  };
  await page.addInitScript(
    ([k, s]) => {
      try {
        localStorage.setItem(k, JSON.stringify(s));
        localStorage.setItem('supabase.auth.token', JSON.stringify({ currentSession: s }));
        // Suprimir el tour de onboarding y el wizard del primer login.
        localStorage.setItem('cl2:onboarding:v1:completed', 'true');
        localStorage.setItem('cl2:onboarding:v1:dismissedAt', new Date().toISOString());
      } catch {}
    },
    [key, stored],
  );
}

// Helper: cerrar cualquier modal/overlay que aparezca encima (Escape + click)
async function dismissOverlays(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
  // Si quedó un backdrop semitransparente, click en una esquina segura para cerrar
  await page.mouse.click(10, 10).catch(() => {});
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape').catch(() => {});
}

async function capture(page, url, outFile, options = {}) {
  console.log(`→ ${outFile} ← ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => {});
  await page.waitForTimeout(options.wait ?? 3_500);
  await dismissOverlays(page);
  if (options.action) {
    try { await options.action(page); } catch (e) { console.warn(`  ⚠ action falló: ${e.message}`); }
    await page.waitForTimeout(1_500);
  }
  const screenshotOpts = {
    path: path.join(OUT_DIR, outFile),
  };
  if (options.clip) {
    screenshotOpts.clip = options.clip;
  } else {
    screenshotOpts.fullPage = options.fullPage ?? true;
  }
  await page.screenshot(screenshotOpts);
  console.log(`  ✓ ${outFile}`);
}

async function captureChat(page, pregunta, outFile, options = {}) {
  console.log(`→ ${outFile} (chat) ← "${pregunta.slice(0, 60)}..."`);
  await page.goto(`${LOCAL_WEB}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => {});
  await page.waitForTimeout(3_000);
  await dismissOverlays(page);

  const ta = page.locator('textarea').first();
  await ta.waitFor({ state: 'visible', timeout: 12_000 });
  await ta.click();
  await ta.fill(pregunta);
  await ta.press('Enter');

  // Esperar a que termine el stream. La heurística: el campo input se libera
  // (deja de estar disabled) cuando termina la respuesta. Polling cada 2s
  // hasta 60s max.
  const maxWait = options.responseWait ?? 60_000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    await page.waitForTimeout(2_000);
    await dismissOverlays(page);
    const isDisabled = await ta.evaluate((el) => el.disabled).catch(() => true);
    if (!isDisabled) break;
  }
  // Margen extra para que el último token llegue + animación de aparición de citations
  await page.waitForTimeout(3_000);
  await dismissOverlays(page);

  // Scroll arriba del thread para que la pregunta del usuario quede visible
  // junto con el inicio de la respuesta. El scroller interno del chat usa
  // overflow-y-auto + scrollbar-hide, no es el body.
  try {
    await page.evaluate(() => {
      // Target el scroller del chat por sus clases típicas
      const scrollers = Array.from(document.querySelectorAll('div'))
        .filter((el) => {
          const cs = getComputedStyle(el);
          return cs.overflowY === 'auto' || cs.overflowY === 'scroll';
        });
      for (const s of scrollers) s.scrollTop = 0;
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(800);
  } catch {}

  await page.screenshot({ path: path.join(OUT_DIR, outFile), fullPage: options.fullPage ?? true });
  console.log(`  ✓ ${outFile}`);
}

// Pre-puebla watchlist con expedientes reales para que /centinela no esté vacía
async function seedWatchlist(jwt) {
  const expedientes = [
    { entity_id: '23.511', label: 'Ley Marco del Recurso Hídrico' },
    { entity_id: '24.018', label: 'Reforma al Reglamento de Donaciones' },
    { entity_id: '25.262', label: 'Modificación a la Ley del Sistema Financiero' },
  ];
  for (const e of expedientes) {
    try {
      const res = await fetch(`${PROD_API}/api/centinela/watchlist`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({ entity_type: 'expediente', ...e }),
      });
      if (res.ok) console.log(`  + Watchlist: ${e.entity_id} — ${e.label}`);
      else console.warn(`  · watchlist ${e.entity_id}: ${res.status}`);
    } catch (err) {
      console.warn(`  · watchlist ${e.entity_id} falló: ${err.message}`);
    }
  }
}

const PLAN = [
  {
    key: '07-fecha-dictamen',
    type: 'ui',
    url: `${LOCAL_WEB}/expediente/23.511`,
    action: async (p) => {
      await p.getByRole('button', { name: /Fechas/i }).first().click().catch(() => {});
    },
  },
  {
    key: '10-sharepoint-discovery',
    type: 'ui',
    url: `${LOCAL_WEB}/sil`,
  },
  {
    key: '11bis-primer-segundo-dia',
    type: 'ui',
    url: `${LOCAL_WEB}/expediente/23.511`,
    action: async (p) => {
      await p.getByRole('button', { name: /Novedades/i }).first().click().catch(() => {});
    },
  },
  {
    key: '16b-regla-24h',
    type: 'ui',
    url: `${LOCAL_WEB}/centinela`,
    wait: 5_000,
    // Crop al top de la página — muestra hero + alerta crítica con timestamps
    clip: { x: 0, y: 0, width: 1440, height: 1100 },
    fullPage: false,
  },
  {
    key: '16c-estructura-orden-dia',
    type: 'ui',
    url: `${LOCAL_WEB}/expediente/23.511`,
    action: async (p) => {
      await p.getByRole('button', { name: /Próx\.? sesión|Pr.xima sesi.n/i }).first().click().catch(() => {});
    },
  },
  {
    key: '16d-prioridad-alertas',
    type: 'ui',
    url: `${LOCAL_WEB}/centinela`,
    wait: 6_000,
    fullPage: true, // ver toda la página con los grupos de prioridad
  },
  {
    key: '16e-audiencias-entidad',
    type: 'ui',
    url: `${LOCAL_WEB}/centinela`,
    wait: 5_000,
    // Crop a la 1ª alerta crítica (audiencia INS) que está arriba después del hero.
    // Hero ocupa ~180px, primera alerta crítica entre 180 y 600px aprox.
    clip: { x: 0, y: 150, width: 1100, height: 650 },
    fullPage: false,
  },
  {
    key: '16f-comision-control',
    type: 'ui',
    url: `${LOCAL_WEB}/centinela`,
    wait: 5_000,
    // Crop al sidebar derecho (watchlist)
    clip: { x: 900, y: 200, width: 540, height: 900 },
    fullPage: false,
  },
  {
    key: '16g-fecha-negrita',
    type: 'ui',
    url: `${LOCAL_WEB}/expediente/23.511`,
    action: async (p) => {
      await p.getByRole('button', { name: /Fechas/i }).first().click().catch(() => {});
    },
  },
  {
    key: '16h-recalculo-fechas',
    type: 'ui',
    // Mismo panel que 07/16g — la herramienta cubre estos tres pedidos
    // en la misma sección. La doc lo explicita.
    url: `${LOCAL_WEB}/expediente/23.511`,
    action: async (p) => {
      await p.getByRole('button', { name: /Fechas/i }).first().click().catch(() => {});
    },
  },
  {
    key: '16i-decretos-ejecutivos',
    type: 'ui',
    url: `${LOCAL_WEB}/plenario/estado`,
    wait: 5_000,
  },
  {
    key: '16j-algoritmo-carlos',
    type: 'ui',
    url: `${LOCAL_WEB}/expediente/23.511`,
    action: async (p) => {
      await p.getByRole('button', { name: /Novedades/i }).first().click().catch(() => {});
    },
  },
  {
    key: '12b-por-tanto-chunker',
    type: 'chat',
    // Pregunta doctrinal: no triggera búsqueda en SIL, evita leak de tools
    pregunta: '¿Qué es una resolución de Sala Constitucional y qué importancia tiene cuando un expediente ha sido objeto de una?',
    responseWait: 75_000,
  },
  {
    key: '13-ral-comentado-api',
    type: 'chat',
    pregunta: 'Resumime brevemente el artículo 137 del Reglamento de la Asamblea Legislativa.',
    responseWait: 75_000,
  },
  {
    key: '14-ral-filtro-activo',
    type: 'chat',
    pregunta: 'En lo procedural: si un diputado quiere presentar una moción de fondo el primer día de discusión bajo el artículo 137, ¿qué requisitos tiene que cumplir?',
    responseWait: 75_000,
  },
  {
    // 16k tiene UI propia: expediente 23.511 tiene texto sustitutivo vigente,
    // el componente DocumentosExpediente muestra un banner destacándolo.
    // Mucho más confiable que un chat que depende de tools que están en deuda.
    key: '16k-texto-sustitutivo',
    type: 'ui',
    url: `${LOCAL_WEB}/expediente/23.511`,
    action: async (p) => {
      await p.getByRole('button', { name: /Documentos/i }).first().click().catch(() => {});
    },
    wait: 4_000,
  },
  {
    key: '16l-backfill-actas',
    type: 'chat',
    // Doctrinal: el rol de las actas de comisiones como evidencia procedimental.
    // Evita gatillar el tool de búsqueda que estaba erroreando.
    pregunta: 'En el trabajo de un consultor legislativo, ¿qué utilidad tienen las actas de comisión? ¿Por qué es importante poder consultarlas con histórico?',
    responseWait: 75_000,
  },
];

(async () => {
  console.log('1. Minteando JWT admin (sin rotar password)...');
  const session = await mintAdminJwt();
  console.log(`   ✓ JWT expira ${new Date(session.expires_at * 1000).toISOString()}`);

  console.log('2. Pre-poblando watchlist (para que /centinela no esté vacía)...');
  await seedWatchlist(session.access_token);

  console.log('3. Levantando Chromium headless...');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await injectAuth(page, session);

  console.log('4. Smoke: cargar localhost:5173 y verificar auth...');
  await page.goto(`${LOCAL_WEB}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => {});
  await page.waitForTimeout(2_500);
  console.log(`   URL: ${page.url()}`);

  console.log(`5. Tomando ${PLAN.length} capturas...`);
  const failed = [];
  for (const job of PLAN) {
    try {
      if (job.type === 'ui') {
        await capture(page, job.url, `${job.key}.png`, {
          wait: job.wait,
          action: job.action,
          clip: job.clip,
          fullPage: job.fullPage,
        });
      } else {
        await captureChat(page, job.pregunta, `${job.key}.png`, { responseWait: job.responseWait });
      }
    } catch (e) {
      console.error(`  ✗ ${job.key}: ${e.message}`);
      failed.push(job.key);
    }
  }

  await browser.close();
  console.log(`\n${PLAN.length - failed.length}/${PLAN.length} capturas tomadas.`);
  if (failed.length) console.log(`Fallidas: ${failed.join(', ')}`);
})();
