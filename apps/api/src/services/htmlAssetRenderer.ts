/**
 * htmlAssetRenderer — turns AssetContent into a branded PDF via Playwright.
 *
 * Why Playwright + HTML and not pptxgenjs / docx / pdfkit:
 *   The CL2 brand is dense visually — Newsreader italics, IBM Plex Mono micro-
 *   eyebrows, paper-tone background, asterisco logo. Reproducing that in any
 *   programmatic format (pptxgenjs, docx, pdfkit) means hand-painting fonts
 *   and shapes — fragile, slow, never quite matches the reference. Playwright
 *   headless Chromium running our own HTML+CSS gives us full fidelity in one
 *   render pass and reuses the same browser binary the e2e suite already
 *   installs.
 *
 * Per-kind dimensions:
 *   carousel  — 1080x1080 per slide (square — LinkedIn / IG / X carrusel)
 *   pptx      — 1920x1080 per slide (16:9 — corporate deck format)
 *   document  — 210mm x 297mm A4 portrait
 *
 * Storage:
 *   GCS bucket `cl2-assets` (created by migration 0023). Public-read because
 *   the export_url ends up shared via LinkedIn / download buttons. Service-
 *   role uploads only (the renderer holds those creds).
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Storage, type Bucket } from '@google-cloud/storage';
import { logger } from './logger.js';
import { withTimeout } from './resilience.js';
import type { AssetContent, AssetKind } from './atlasContentGenerator.js';

// Resolve template directory at module load — works in both `tsx` (dev,
// .ts source) and the compiled dist/ output. We expect a `templates/`
// folder colocated with this service after build (postbuild copies it).
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Templates live under apps/api/src/templates in source, and we replicate
// them under dist/templates at build time (see postbuild step in
// package.json). Resolution is relative to this file's directory so it
// works in both cases.
async function templatePath(kind: AssetKind): Promise<string> {
  const filename = kind === 'carousel'
    ? 'template-carousel.html'
    : kind === 'pptx'
    ? 'template-pptx.html'
    : 'template-document.html';

  const candidates = [
    path.resolve(__dirname, '..', 'templates', filename),         // dev (tsx)  → src/templates/...
    path.resolve(__dirname, '..', '..', 'src', 'templates', filename), // alt dev path
    path.resolve(__dirname, 'templates', filename),               // compiled (dist/services → dist/templates fallback)
    path.resolve(__dirname, '..', 'templates', filename),         // dist if templates copied to dist/templates
  ];
  for (const p of candidates) {
    try { await fs.access(p); return p; } catch { /* keep trying */ }
  }
  // Final fallback: if the template ever ships under dist/src/templates due
  // to tsc tree settings, find it via a last-resort relative jump.
  return path.resolve(__dirname, '..', 'templates', filename);
}

// ─── Playwright dynamic import ─────────────────────────────────────────────
// Done lazily so importing this service doesn't fail if Playwright isn't
// installed (e.g., during typecheck on CI). The renderer is the only code
// path that needs the browser binary.
type ChromiumLike = {
  launch(opts?: { headless?: boolean }): Promise<BrowserLike>;
};
interface BrowserLike {
  newContext(opts?: Record<string, unknown>): Promise<ContextLike>;
  close(): Promise<void>;
}
interface ContextLike {
  newPage(): Promise<PageLike>;
}
interface PageLike {
  setContent(html: string, opts?: { waitUntil?: string }): Promise<void>;
  evaluate<T>(fn: (data: unknown) => T, arg?: unknown): Promise<T>;
  waitForFunction(fn: () => boolean | Promise<boolean>, opts?: { timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  pdf(opts: Record<string, unknown>): Promise<Buffer>;
  $$(selector: string): Promise<unknown[]>;
}

async function loadChromium(): Promise<ChromiumLike> {
  try {
    // Prefer the full `playwright` package if installed in apps/api.
    // Else fall back to `playwright-core` (which `@playwright/test` depends on).
    const pw = await import('playwright').catch(() => null);
    if (pw && (pw as { chromium?: ChromiumLike }).chromium) {
      return (pw as unknown as { chromium: ChromiumLike }).chromium;
    }
    const pwc = await import('playwright-core').catch(() => null);
    if (pwc && (pwc as { chromium?: ChromiumLike }).chromium) {
      return (pwc as unknown as { chromium: ChromiumLike }).chromium;
    }
  } catch {
    // fall through
  }
  // BLOCKED: if playwright isn't on the runtime path, surface a clear error.
  throw new Error(
    'playwright_not_installed: install `playwright` in apps/api or wire ' +
    'the workspace alias so dynamic import resolves. We rely on the ' +
    'bundled Chromium that `apps/web/test:e2e:install` already sets up.',
  );
}

// ─── GCS upload ────────────────────────────────────────────────────────────
const ASSETS_BUCKET = process.env.CL2_ASSETS_BUCKET ?? 'cl2-assets';
const UPLOAD_TIMEOUT_MS = 60_000;

let _storage: Storage | null = null;
function bucket(): Bucket {
  if (!_storage) _storage = new Storage();
  return _storage.bucket(ASSETS_BUCKET);
}

async function uploadAssetPdf(opts: {
  userId: string;
  workspaceId: string;
  nodeId: string;
  pdf: Buffer;
  filename: string;
}): Promise<{ exportUrl: string; gcsPath: string }> {
  const objectPath = `${opts.userId}/${opts.workspaceId}/${opts.nodeId}/${opts.filename}`;
  const file = bucket().file(objectPath);
  await withTimeout(
    () =>
      file.save(opts.pdf, {
        contentType: 'application/pdf',
        resumable: false,
        metadata: { cacheControl: 'public, max-age=3600' },
      }),
    { ms: UPLOAD_TIMEOUT_MS, label: 'gcs:upload_asset' },
  );
  // Public bucket → use the public URL form (no signing needed). The
  // bucket policy from migration 0023 grants SELECT to anon.
  const exportUrl = `https://storage.googleapis.com/${ASSETS_BUCKET}/${encodeURI(objectPath)}`;
  return { exportUrl, gcsPath: `gs://${ASSETS_BUCKET}/${objectPath}` };
}

// ─── Public API ────────────────────────────────────────────────────────────
export interface RenderOptions {
  /** When set, overrides default footerLeft on every slide. */
  footerLeft?: string;
  /** When set, overrides default footerRight on every slide. */
  footerRight?: string;
  /** Brand "edition" line for cover (carousel/pptx). */
  edition?: string;
}

export interface RenderResult {
  /** Public URL on cl2-assets bucket. */
  exportUrl: string;
  /** Canonical gs:// path — useful for ops debugging. */
  gcsPath: string;
  /** Local filename (downloads). */
  filename: string;
  /** Number of slides actually rendered. */
  slidesCount: number;
  /** ISO timestamp of generation. */
  generatedAt: string;
}

export interface RenderArgs {
  content: AssetContent;
  kind: AssetKind;
  userId: string;
  workspaceId: string;
  /** Asset node id — used as object path prefix in GCS so re-renders overwrite. */
  nodeId: string;
  /** Workspace title (for filename). */
  workspaceTitle: string;
  options?: RenderOptions;
}

function dimensionsFor(kind: AssetKind): { width: string; height: string; pageSize: string } {
  if (kind === 'carousel') return { width: '1080px', height: '1080px', pageSize: '1080px 1080px' };
  if (kind === 'pptx')     return { width: '1920px', height: '1080px', pageSize: '1920px 1080px' };
  // A4 portrait → 210mm x 297mm
  return { width: '210mm', height: '297mm', pageSize: 'A4' };
}

function safeFilename(workspaceTitle: string, kind: AssetKind): string {
  const stem = workspaceTitle
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .toLowerCase() || 'cl2-asset';
  const suffix = kind === 'carousel' ? 'carrusel' : kind === 'pptx' ? 'presentacion' : 'documento';
  return `${stem}-${suffix}.pdf`;
}

export async function renderAssetToPdf(args: RenderArgs): Promise<RenderResult> {
  const t0 = Date.now();
  const { content, kind, userId, workspaceId, nodeId, workspaceTitle, options } = args;

  const tplPath = await templatePath(kind);
  const html = await fs.readFile(tplPath, 'utf-8');

  const chromium = await loadChromium();
  const browser = await chromium.launch({ headless: true });
  let pdfBuffer: Buffer;
  let slidesCount = content.slides.length;
  try {
    const dims = dimensionsFor(kind);
    const ctx = await browser.newContext({
      viewport: kind === 'document'
        ? { width: 794, height: 1123 }   // A4 @ 96dpi
        : { width: parseInt(dims.width), height: parseInt(dims.height) },
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();

    // Inject the data BEFORE the template scripts run, by appending a small
    // <script> that sets window.__ASSET_DATA__ inline in the head. We do
    // this by replacing a sentinel comment in the template; if the sentinel
    // isn't there, we fall back to prepending a script tag.
    const dataPayload = {
      content,
      kind,
      options: {
        footerLeft: options?.footerLeft ?? 'Análisis · cl2.cr',
        footerRight: options?.footerRight ?? '',
        edition: options?.edition ?? '',
      },
    };
    const inject = `<script>window.__ASSET_DATA__ = ${JSON.stringify(dataPayload).replace(/</g, '\\u003c')};</script>`;
    const sentinel = '<!--ASSET_DATA_INJECTION_POINT-->';
    const finalHtml = html.includes(sentinel)
      ? html.replace(sentinel, inject)
      : html.replace('</head>', `${inject}</head>`);

    await page.setContent(finalHtml, { waitUntil: 'load' });
    // Render hook: the template's inline script sets window.__ASSET_RENDERED__
    // to true once it has populated the DOM. We wait up to 8s for it.
    try {
      await page.waitForFunction(
        () => (window as unknown as { __ASSET_RENDERED__?: boolean }).__ASSET_RENDERED__ === true,
        { timeout: 8_000 },
      );
    } catch {
      logger.warn('html_asset_render_no_signal', { kind, slides: slidesCount });
    }
    // Give Google Fonts a final tick — `load` doesn't always wait for them.
    await page.waitForTimeout(700);

    const slides = await page.$$('.slide');
    if (slides.length > 0) slidesCount = slides.length;

    pdfBuffer = (await page.pdf({
      width: dims.width,
      height: dims.height,
      printBackground: true,
      preferCSSPageSize: true,
      format: kind === 'document' ? 'A4' : undefined,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    })) as Buffer;
  } finally {
    await browser.close().catch(() => undefined);
  }

  const filename = safeFilename(workspaceTitle, kind);
  const upload = await uploadAssetPdf({ userId, workspaceId, nodeId, pdf: pdfBuffer, filename });

  const generatedAt = new Date().toISOString();
  logger.info('html_asset_rendered', {
    kind,
    workspaceId,
    nodeId,
    slidesCount,
    bytes: pdfBuffer.byteLength,
    ms: Date.now() - t0,
  });

  return {
    exportUrl: upload.exportUrl,
    gcsPath: upload.gcsPath,
    filename,
    slidesCount,
    generatedAt,
  };
}
