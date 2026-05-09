/**
 * @deprecated 2026-05 — superseded by `atlasContentGenerator` +
 * `htmlAssetRenderer` (kind='carousel'). This file used to call Gamma's
 * social/1x1/condense pipeline; that produced off-brand carousels that
 * didn't match CL2's editorial system. The new pipeline is HTML→PDF with
 * the brand template `template-carousel.html` and gives us pixel-level
 * control over typography, color, and layout per slide.
 *
 * Kept ONLY as a thin shim to avoid breaking any caller that imports
 * `runWorkspaceCarouselExport`. The shim delegates to the new pipeline
 * and adapts the legacy result shape (generationId/gammaUrl/exportUrl).
 *
 * Remove this file once no caller imports it (grep `runWorkspaceCarousel`).
 */
import { generateAssetContent, type AssetGenerationOptions } from './atlasContentGenerator.js';
import { renderAssetToPdf } from './htmlAssetRenderer.js';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { logger } from './logger.js';

let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase env missing for workspaceCarouselExport');
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

/** @deprecated kept for legacy import shape. */
export interface WorkspaceCarouselResult {
  generationId: string;
  gammaUrl: string;     // legacy field — now points to the same exportUrl
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

/** @deprecated alias of `AssetGenerationOptions` for legacy callers. */
export type CarouselOptions = AssetGenerationOptions;

interface RunOpts {
  workspaceId: string;
  userId: string | null;
  /** Ignored — the new pipeline doesn't cache (re-renders are deterministic). */
  force?: boolean;
  options?: CarouselOptions;
}

export async function runWorkspaceCarouselExport(opts: RunOpts): Promise<WorkspaceCarouselResult> {
  if (!opts.userId) throw new Error('user_id required for runWorkspaceCarouselExport');

  // Verify workspace + ownership.
  const { data: ws, error } = await supa()
    .from('workspaces')
    .select('id, title')
    .eq('id', opts.workspaceId)
    .eq('user_id', opts.userId)
    .single();
  if (error || !ws) throw new WorkspaceNotFoundError();
  const wsTitle = (ws.title as string | undefined) ?? 'Workspace';

  // Generate + render via the new branded pipeline.
  const content = await generateAssetContent({
    workspaceId: opts.workspaceId,
    userId: opts.userId,
    kind: 'carousel',
    options: opts.options,
  });
  // Use a transient nodeId for the GCS object path — legacy callers don't
  // create canvas nodes through this entrypoint.
  const nodeId = `legacy-${Date.now()}`;
  const render = await renderAssetToPdf({
    content,
    kind: 'carousel',
    userId: opts.userId,
    workspaceId: opts.workspaceId,
    nodeId,
    workspaceTitle: wsTitle,
  });

  logger.info('workspace_carousel_legacy_shim_ok', {
    workspaceId: opts.workspaceId, slidesCount: render.slidesCount,
  });

  return {
    generationId: nodeId,
    gammaUrl: render.exportUrl,
    exportUrl: render.exportUrl,
    filename: render.filename,
    cached: false,
    generatedAt: render.generatedAt,
  };
}
