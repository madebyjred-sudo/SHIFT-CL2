/**
 * @deprecated 2026-05 — superseded by `atlasContentGenerator` +
 * `htmlAssetRenderer` (kind='pptx'). The new pipeline produces a fully
 * branded HTML→PDF deck (1920x1080) instead of delegating layout/visuals
 * to Gamma, which was generating off-brand presentations (stock photos,
 * random fonts that didn't respect CL2). Kept temporarily for backward
 * compat with the legacy /export endpoint and the chat tool
 * `generate_presentation`, both of which still flow through Gamma.
 * Migrate callers to the new `/export-asset` route + `generate_asset` tool.
 *
 * workspacePptxExport — shared pptx generation flow.
 *
 * Extracted from routes/workspace.ts so it can be called from two places:
 *
 *   1. POST /api/workspace/:id/export (the HTTP entrypoint, modal-driven UX)
 *   2. The Atlas `generate_presentation` tool dispatcher in openRouterClient
 *
 * Putting it in /services/ avoids a circular import: workspace.ts imports
 * openRouterClient (for /chat-style routes inside the workspace surface),
 * and openRouterClient now needs to call this exporter — so it has to live
 * outside both.
 *
 * Contract:
 *   - Verify the workspace exists and belongs to userId.
 *   - If !force AND last_pptx is < 1h old, return the cached deck.
 *   - Else: compose markdown from hojas, call Gamma generateAndWait, persist
 *     last_pptx, return the result.
 *   - Errors propagate as GammaApiError so callers can map to HTTP / UI.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { generateAndWait } from './gammaApi.js';
import { logger } from './logger.js';

let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase env missing for workspacePptxExport');
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

export interface WorkspacePptxResult {
  generationId: string;
  gammaUrl: string;
  exportUrl: string;
  filename: string;
  cached: boolean;
  generatedAt: string;
}

export class WorkspaceNotFoundError extends Error {
  constructor() {
    super('workspace_not_found');
    this.name = 'WorkspaceNotFoundError';
  }
}

/**
 * Per-presentation client preferences. All optional. When set, the values
 * are composed into Gamma's `additionalInstructions` field — that's the
 * only knob the public Gamma API exposes for stylistic + content guidance
 * (the `themeId` parameter exists too but requires user-saved themes,
 * which we don't surface yet).
 *
 * Cached on `workspaces.last_pptx.options` so the next button click pre-
 * populates the form with last time's choices.
 */
export interface PptxOptions {
  /** "ejecutivo, seco" / "didáctico" / "persuasivo" / "técnico". */
  tono?: string;
  /** "Diputados de Hacendarios" / "Equipo de comunicación" / etc. */
  audiencia?: string;
  /** Free text — what the user wants the deck to argue or showcase. */
  proposito?: string;
  /** Brand voice / visual notes. e.g. "Mantener vocabulario formal,
   *  evitar tecnicismos. Logo de Asamblea, paleta sobria.". */
  marca?: string;
  /** Emojis si/no. Defaults false. Decks legislativos casi nunca los quieren. */
  emojis?: boolean;
}

interface RunOpts {
  workspaceId: string;
  userId: string | null;
  /** Bypass the ~1h cache when true. */
  force?: boolean;
  /** Optional per-call branding/context options. When omitted, the cached
   *  options on the workspace row are reused (so re-clicks keep the same
   *  flavor without re-asking). */
  options?: PptxOptions;
}

/**
 * Compose the Gamma `additionalInstructions` payload from user options +
 * sane defaults. Pure — no DB. Easy to unit test.
 */
function buildAdditionalInstructions(opts: PptxOptions | undefined): string {
  const parts: string[] = [
    'Tono profesional legislativo costarricense por defecto.',
    'Mantené citas a expedientes (NN.NNN) y nombres propios sin reformular.',
    'No uses lenguaje de marketing — registro técnico-político.',
  ];
  if (opts?.tono) parts.push(`Tono específico: ${opts.tono}.`);
  if (opts?.audiencia) parts.push(`Audiencia objetivo: ${opts.audiencia}. Adaptá nivel de detalle y términos técnicos.`);
  if (opts?.proposito) parts.push(`Propósito de esta presentación: ${opts.proposito}.`);
  if (opts?.marca) parts.push(`Lineamientos de marca: ${opts.marca}.`);
  if (opts?.emojis === false || opts?.emojis === undefined) {
    parts.push('NO uses emojis ni iconos decorativos en el texto de las slides.');
  }
  return parts.join(' ');
}

/**
 * Run the full pptx export flow. Returns either the cached or freshly-
 * generated deck metadata. Throws WorkspaceNotFoundError if the workspace
 * doesn't exist or doesn't belong to userId, or GammaApiError on Gamma
 * failures.
 */
export async function runWorkspacePptxExport(opts: RunOpts): Promise<WorkspacePptxResult> {
  const { workspaceId, userId, force = false } = opts;
  if (!userId) throw new Error('user_id required for runWorkspacePptxExport');

  // ── Load workspace + nodes ─────────────────────────────────────────
  // SELECT with last_pptx; fall back without it for pre-migration envs.
  type WsRow = { id: string; title: string; description: string | null; last_pptx?: (WorkspacePptxResult & { creditsUsed?: number; options?: PptxOptions }) | null };
  let ws: WsRow;
  {
    const r = await supa()
      .from('workspaces')
      .select('id, title, description, last_pptx')
      .eq('id', workspaceId)
      .eq('user_id', userId)
      .single();
    if (r.error && /last_pptx/.test(r.error.message)) {
      const r2 = await supa()
        .from('workspaces')
        .select('id, title, description')
        .eq('id', workspaceId)
        .eq('user_id', userId)
        .single();
      if (r2.error || !r2.data) throw new WorkspaceNotFoundError();
      ws = r2.data as unknown as WsRow;
    } else {
      if (r.error || !r.data) throw new WorkspaceNotFoundError();
      ws = r.data as unknown as WsRow;
    }
  }

  const safeName = (ws.title ?? 'workspace')
    .replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_') || 'workspace';

  // ── Cache reuse ────────────────────────────────────────────────────
  // Cache returns the prior deck when:
  //   - force=false, AND
  //   - the cache is < 1h old, AND
  //   - either no new options were passed, OR the new options match what
  //     was cached (deep-equal as JSON). The latter rule prevents the
  //     options modal from quietly returning a stale deck after the user
  //     just changed their tone/audience.
  const cache = ws.last_pptx;
  if (!force && cache?.generatedAt && cache.exportUrl && cache.gammaUrl) {
    const ageMs = Date.now() - new Date(cache.generatedAt).getTime();
    const oneHour = 60 * 60 * 1000;
    const optionsChanged = opts.options
      ? JSON.stringify(opts.options) !== JSON.stringify(cache.options ?? null)
      : false;
    if (ageMs >= 0 && ageMs < oneHour && !optionsChanged) {
      logger.info('workspace_pptx_cache_hit', { workspaceId, ageMs, generationId: cache.generationId });
      return {
        generationId: cache.generationId,
        gammaUrl: cache.gammaUrl,
        exportUrl: cache.exportUrl,
        filename: `${safeName}.pptx`,
        cached: true,
        generatedAt: cache.generatedAt,
      };
    }
  }

  // ── Load hojas ────────────────────────────────────────────────────
  const { data: nodes, error: nErr } = await supa()
    .from('workspace_nodes')
    .select('id, title, subtitle, content, x, y')
    .eq('workspace_id', workspaceId);
  if (nErr) throw new Error(`load_nodes_failed: ${nErr.message}`);

  // Reading order: top-to-bottom, left-to-right (snap y to 200px bands).
  const ordered = (nodes ?? []).slice().sort((a, b) => {
    const yA = Math.floor((a.y as number) / 200);
    const yB = Math.floor((b.y as number) / 200);
    if (yA !== yB) return yA - yB;
    return (a.x as number) - (b.x as number);
  });

  // ── Compose deck source ───────────────────────────────────────────
  const lines: string[] = [];
  lines.push(`# ${ws.title}`);
  if (ws.description) lines.push('', ws.description);
  lines.push('', `_${ordered.length} hoja${ordered.length === 1 ? '' : 's'} · CL2_`);

  for (const n of ordered) {
    lines.push('', '---', '');
    lines.push(`# ${n.title}`);
    if (n.subtitle) lines.push('', `### ${n.subtitle}`);
    const md = (n.content as Record<string, unknown>)?.md as string ?? '';
    if (md.trim()) lines.push('', md.trim());
  }

  const inputText = lines.join('\n').slice(0, 400_000);

  // ── Call Gamma ────────────────────────────────────────────────────
  const gen = await generateAndWait(
    {
      inputText,
      format: 'presentation',
      exportAs: 'pptx',
      cardSplit: 'inputTextBreaks',
      textMode: 'preserve',
      textOptions: { language: 'es-419', tone: 'professional, legislative' },
      imageOptions: { source: 'aiGenerated' },
      cardOptions: { dimensions: '16x9' },
      additionalInstructions: buildAdditionalInstructions(
        // Use explicit options when caller passed them, else fall back to
        // whatever the user saved last time on this workspace, else nothing.
        opts.options ?? ws.last_pptx?.options ?? undefined,
      ),
    },
    { maxDurationMs: 5 * 60 * 1000 },
  );
  const generatedAt = new Date().toISOString();

  // ── Persist cache (best-effort) ───────────────────────────────────
  // Stash the options we used too — next time the user opens the modal
  // it pre-populates with their last choices, so they're not re-typing
  // "tono ejecutivo" every time.
  const cachePayload = {
    generationId: gen.generationId,
    gammaUrl: gen.gammaUrl,
    exportUrl: gen.exportUrl,
    generatedAt,
    options: opts.options ?? ws.last_pptx?.options ?? undefined,
  };
  try {
    const { error: upErr } = await supa()
      .from('workspaces')
      .update({ last_pptx: cachePayload, updated_at: generatedAt })
      .eq('id', workspaceId)
      .eq('user_id', userId);
    if (upErr) logger.warn('workspace_pptx_cache_write_failed', { workspaceId, error: upErr.message });
  } catch (err) {
    logger.warn('workspace_pptx_cache_write_threw', { workspaceId, error: (err as Error).message });
  }

  logger.info('workspace_pptx_generated', {
    workspaceId, hojas: ordered.length, generationId: gen.generationId, chars: inputText.length,
  });

  return {
    generationId: gen.generationId,
    gammaUrl: gen.gammaUrl ?? '',
    exportUrl: gen.exportUrl,
    filename: `${safeName}.pptx`,
    cached: false,
    generatedAt,
  };
}
