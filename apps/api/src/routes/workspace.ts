/**
 * Workspace "Hojas" — CRUD for canvas workspaces and their nodes.
 *
 * Architecture:
 *   workspaces  — canvas containers (one per legislative research project).
 *   workspace_nodes — individual "hoja" pages positioned on the canvas.
 *
 * RLS on both tables ensures users only see their own data; the service-role
 * key still enforces these policies because we call `.auth.getUser()` first.
 *
 * Export endpoint (POST /:id/nodes/:nodeId/export) supports:
 *   md   — returns raw markdown, Content-Disposition: attachment
 *   docx — uses `docx` npm package to build a real Word document
 *   pdf  — stubbed (Phase 1); returns 501 with friendly message
 */
import { Router, type Request, type Response } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import multer from 'multer';
import { getUserIdFromRequest } from '../services/auth.js';
import { openRouterStream } from '../services/openRouterClient.js';
import { getExpedienteById } from '../services/silClient.js';
import { getTranscripcionById, fetchTranscriptJson, type TranscriptBlob } from '../services/legacyCl2Client.js';
import { requireQuota, logAiCall } from '../services/aiQuota.js';
import { generateAndWait, GammaApiError } from '../services/gammaApi.js';

export const workspaceRouter = Router();

// ─── Supabase singleton ───────────────────────────────────────────────
let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase env missing');
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

async function requireUser(req: Request, res: Response): Promise<string | null> {
  const userId = await getUserIdFromRequest(req);
  if (!userId) { res.status(401).json({ ok: false, error: 'auth_required' }); return null; }
  return userId;
}

// ─── Helper: verify workspace belongs to user ─────────────────────────
async function ownedWorkspace(userId: string, workspaceId: string, res: Response): Promise<boolean> {
  const { data, error } = await supa()
    .from('workspaces')
    .select('id')
    .eq('id', workspaceId)
    .eq('user_id', userId)
    .single();
  if (error || !data) {
    res.status(404).json({ ok: false, error: 'workspace_not_found' });
    return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════════
// WORKSPACES
// ═══════════════════════════════════════════════════════════════════════

// GET /api/workspace — list user's workspaces with node count
workspaceRouter.get('/', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const includeArchived = req.query.archived === '1';

  try {
    let q = supa()
      .from('workspaces')
      .select('id, title, description, archived, created_at, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });
    if (!includeArchived) q = q.eq('archived', false);

    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);

    // Attach node counts (batch query for efficiency)
    const ids = (rows ?? []).map((r) => r.id as string);
    let countMap: Record<string, number> = {};
    if (ids.length > 0) {
      const { data: nodeCounts } = await supa()
        .from('workspace_nodes')
        .select('workspace_id')
        .in('workspace_id', ids);
      for (const n of nodeCounts ?? []) {
        countMap[n.workspace_id as string] = (countMap[n.workspace_id as string] ?? 0) + 1;
      }
    }

    const items = (rows ?? []).map((r) => ({
      ...r,
      node_count: countMap[r.id as string] ?? 0,
    }));

    res.json({ ok: true, items });
  } catch (err) {
    req.log?.warn('workspace/list failed', { error: (err as Error).message });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// POST /api/workspace — create workspace
workspaceRouter.post('/', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { title = 'Mi espacio', description = '' } = req.body ?? {};

  try {
    const { data, error } = await supa()
      .from('workspaces')
      .insert({ user_id: userId, title: String(title).slice(0, 200), description: String(description).slice(0, 1000) })
      .select('id, title, description, archived, created_at, updated_at')
      .single();
    if (error) throw new Error(error.message);
    res.status(201).json({ ok: true, workspace: { ...data, node_count: 0 } });
  } catch (err) {
    req.log?.warn('workspace/create failed', { error: (err as Error).message });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// PATCH /api/workspace/:id — rename / archive
workspaceRouter.patch('/:id', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id } = req.params;

  const allowed: Record<string, unknown> = {};
  if (typeof req.body.title === 'string') allowed.title = req.body.title.slice(0, 200);
  if (typeof req.body.description === 'string') allowed.description = req.body.description.slice(0, 1000);
  if (typeof req.body.archived === 'boolean') allowed.archived = req.body.archived;

  try {
    const { data, error } = await supa()
      .from('workspaces')
      .update(allowed)
      .eq('id', id)
      .eq('user_id', userId)
      .select('id, title, description, archived, updated_at')
      .single();
    if (error || !data) { res.status(404).json({ ok: false, error: 'workspace_not_found' }); return; }
    res.json({ ok: true, workspace: data });
  } catch (err) {
    req.log?.warn('workspace/update failed', { error: (err as Error).message });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// DELETE /api/workspace/:id — hard delete (cascade clears nodes)
workspaceRouter.delete('/:id', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id } = req.params;

  try {
    const { error } = await supa()
      .from('workspaces')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    req.log?.warn('workspace/delete failed', { error: (err as Error).message });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// NODES
// ═══════════════════════════════════════════════════════════════════════

// GET /api/workspace/:id/nodes — list nodes
//
// Default: no content (perf — list-views typically only need geometry
// + titles). Pass ?withContent=1 to include the JSONB `content` column;
// the canvas hydration path uses this so hojas show their bodies on
// first paint (otherwise refreshing the page renders empty editors
// even though content IS persisted in DB).
workspaceRouter.get('/:id/nodes', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id } = req.params;
  if (!await ownedWorkspace(userId, id, res)) return;

  const withContent = req.query.withContent === '1';
  const cols = withContent
    ? 'id, workspace_id, type, x, y, width, height, z_index, title, subtitle, color, content, created_at, updated_at'
    : 'id, workspace_id, type, x, y, width, height, z_index, title, subtitle, color, created_at, updated_at';

  try {
    const { data, error } = await supa()
      .from('workspace_nodes')
      .select(cols)
      .eq('workspace_id', id)
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    res.json({ ok: true, nodes: data ?? [] });
  } catch (err) {
    req.log?.warn('workspace/nodes/list failed', { error: (err as Error).message });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// GET /api/workspace/:id/nodes/:nodeId — single node WITH content
workspaceRouter.get('/:id/nodes/:nodeId', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id, nodeId } = req.params;
  if (!await ownedWorkspace(userId, id, res)) return;

  try {
    const { data, error } = await supa()
      .from('workspace_nodes')
      .select('*')
      .eq('id', nodeId)
      .eq('workspace_id', id)
      .single();
    if (error || !data) { res.status(404).json({ ok: false, error: 'node_not_found' }); return; }
    res.json({ ok: true, node: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// POST /api/workspace/:id/nodes — create node
workspaceRouter.post('/:id/nodes', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id } = req.params;
  if (!await ownedWorkspace(userId, id, res)) return;

  const {
    type = 'hoja',
    x = 0, y = 0,
    width = 640, height = 420,
    title = 'Sin título',
    subtitle = '',
    content = {},
    color = 'default',
  } = req.body ?? {};

  try {
    const { data, error } = await supa()
      .from('workspace_nodes')
      .insert({
        workspace_id: id,
        type: String(type),
        x: Number(x), y: Number(y),
        width: Number(width), height: Number(height),
        title: String(title).slice(0, 300),
        subtitle: String(subtitle).slice(0, 300),
        content: typeof content === 'object' ? content : {},
        color: String(color),
      })
      .select('*')
      .single();
    if (error) throw new Error(error.message);
    res.status(201).json({ ok: true, node: data });
  } catch (err) {
    req.log?.warn('workspace/nodes/create failed', { error: (err as Error).message });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// PATCH /api/workspace/:id/nodes/:nodeId — update (position, content, title, etc.)
workspaceRouter.patch('/:id/nodes/:nodeId', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id, nodeId } = req.params;
  if (!await ownedWorkspace(userId, id, res)) return;

  const allowed: Record<string, unknown> = {};
  if (typeof req.body.title    === 'string')  allowed.title    = req.body.title.slice(0, 300);
  if (typeof req.body.subtitle === 'string')  allowed.subtitle = req.body.subtitle.slice(0, 300);
  if (typeof req.body.color    === 'string')  allowed.color    = req.body.color;
  if (typeof req.body.x        === 'number')  allowed.x        = req.body.x;
  if (typeof req.body.y        === 'number')  allowed.y        = req.body.y;
  if (typeof req.body.width    === 'number')  allowed.width    = req.body.width;
  if (typeof req.body.height   === 'number')  allowed.height   = req.body.height;
  if (typeof req.body.z_index  === 'number')  allowed.z_index  = req.body.z_index;
  if (req.body.content !== undefined)         allowed.content  = req.body.content;

  if (Object.keys(allowed).length === 0) {
    res.status(400).json({ ok: false, error: 'no_fields' });
    return;
  }

  try {
    const { data, error } = await supa()
      .from('workspace_nodes')
      .update(allowed)
      .eq('id', nodeId)
      .eq('workspace_id', id)
      .select('id, title, subtitle, color, x, y, width, height, z_index, updated_at')
      .single();
    if (error || !data) { res.status(404).json({ ok: false, error: 'node_not_found' }); return; }
    res.json({ ok: true, node: data });
  } catch (err) {
    req.log?.warn('workspace/nodes/update failed', { error: (err as Error).message });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// DELETE /api/workspace/:id/nodes/:nodeId
workspaceRouter.delete('/:id/nodes/:nodeId', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id, nodeId } = req.params;
  if (!await ownedWorkspace(userId, id, res)) return;

  try {
    const { error } = await supa()
      .from('workspace_nodes')
      .delete()
      .eq('id', nodeId)
      .eq('workspace_id', id);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════════════════════

// POST /api/workspace/:id/export
// body: { format: 'md' | 'docx' }
//
// Workspace-wide export: concatenates ALL hojas in the workspace into a
// single document, ordered by node grid position (top-to-bottom,
// left-to-right — y first, then x). The output has:
//   - Workspace title as Heading1
//   - Optional description as a paragraph below
//   - Auto-generated TOC (just titles, no page numbers — DOCX renderers
//     resolve those at open time)
//   - Each hoja as a section: title (Heading2), subtitle (Heading3 italic),
//     body markdown. Hojas are separated by page breaks in DOCX.
//
// This is the "demo moment" export — turns a research canvas into a
// printable brief in one click.
workspaceRouter.post('/:id/export', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id } = req.params;

  const format = (req.body?.format ?? 'md') as string;
  if (!['md', 'docx', 'pptx'].includes(format)) {
    res.status(400).json({ ok: false, error: 'invalid_format', hint: 'md|docx|pptx' });
    return;
  }

  try {
    // Fetch workspace metadata + all nodes in one round-trip.
    const [{ data: ws, error: wsErr }, { data: nodes, error: nErr }] = await Promise.all([
      // SELECT with last_pptx (added by migration 0020). The query is
      // resilient: if the column doesn't exist yet (pre-migration env),
      // fall back to a SELECT without it so the export endpoint keeps
      // working — cache logic just degrades to no-cache.
      (async () => {
        const r = await supa()
          .from('workspaces')
          .select('id, title, description, last_pptx')
          .eq('id', id)
          .eq('user_id', userId)
          .single();
        if (r.error && /last_pptx/.test(r.error.message)) {
          // Column missing → retry without it.
          return supa()
            .from('workspaces')
            .select('id, title, description')
            .eq('id', id)
            .eq('user_id', userId)
            .single();
        }
        return r;
      })(),
      supa()
        .from('workspace_nodes')
        .select('id, title, subtitle, content, x, y, color, type')
        .eq('workspace_id', id),
    ]);
    if (wsErr || !ws) { res.status(404).json({ ok: false, error: 'workspace_not_found' }); return; }
    if (nErr) throw new Error(nErr.message);

    // Reading order: top-to-bottom, then left-to-right. Snap y to row
    // bands of 200px so two hojas at slightly different y don't flip
    // randomly — visually-aligned hojas stay aligned in the doc.
    const ordered = (nodes ?? []).slice().sort((a, b) => {
      const yA = Math.floor((a.y as number) / 200);
      const yB = Math.floor((b.y as number) / 200);
      if (yA !== yB) return yA - yB;
      return (a.x as number) - (b.x as number);
    });

    const safeName = String(ws.title)
      .replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_') || 'workspace';

    if (format === 'md') {
      const lines: string[] = [];
      lines.push(`# ${ws.title}`);
      if (ws.description) lines.push('', `_${ws.description}_`);
      lines.push('', `_Generado por CL2 · ${ordered.length} hoja${ordered.length === 1 ? '' : 's'}_`, '');

      // TOC
      if (ordered.length > 1) {
        lines.push('## Contenido', '');
        ordered.forEach((n, i) => {
          lines.push(`${i + 1}. ${n.title}`);
        });
        lines.push('');
      }

      // Body
      for (const n of ordered) {
        lines.push('---', '');
        lines.push(`## ${n.title}`);
        if (n.subtitle) lines.push('', `_${n.subtitle}_`);
        const md = (n.content as Record<string, unknown>)?.md as string ?? '';
        if (md.trim()) lines.push('', md.trim());
        lines.push('');
      }

      const body = lines.join('\n');
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.md"`);
      res.send(body);
      return;
    }

    // ── PPTX via Gamma API ────────────────────────────────────────────────
    // Strategy: build the SAME markdown the md format produces, but use
    // explicit "\n---\n" slide breaks (already present between hojas) so
    // Gamma respects the canvas structure 1:1. Each hoja becomes one or
    // more cards. Workspace title + description form the cover.
    //
    // We block until completion (max ~5min) and return a JSON envelope with
    // the signed download URL. The client opens it in a new tab; the URL is
    // valid for ~1 week per Gamma's CDN policy. If we ever need permanent
    // hosting we re-host in GCS, but that's overkill for the demo.
    if (format === 'pptx') {
      // Pptx generation lives in services/workspacePptxExport so the same
      // code path serves both the HTTP route AND the Atlas chat-tool
      // dispatcher. We just delegate. Body params:
      //   force?     — bypass the 1h cache (e.g. "Generar de nuevo" link)
      //   options?   — branding/context preferences (PptxOptions); new
      //                values invalidate the cache automatically inside
      //                runWorkspacePptxExport.
      const force = Boolean(req.body?.force);
      const options = (req.body?.options ?? undefined) as undefined | {
        tono?: string; audiencia?: string; proposito?: string; marca?: string; emojis?: boolean;
      };
      const { runWorkspacePptxExport: runPptx } = await import('../services/workspacePptxExport.js');
      try {
        const result = await runPptx({ workspaceId: id, userId, force, options });
        req.log?.info('workspace/export pptx ok', {
          workspace: id, hojas: ordered.length, generationId: result.generationId, cached: result.cached,
        });
        res.json({
          ok: true,
          format: 'pptx',
          cached: result.cached,
          generatedAt: result.generatedAt,
          filename: result.filename,
          url: result.exportUrl,
          gammaUrl: result.gammaUrl,
          generationId: result.generationId,
        });
        return;
      } catch (err) {
        if (err instanceof GammaApiError) {
          req.log?.warn('workspace/export pptx failed', {
            workspace: id, code: err.code, error: err.message,
          });
          const statusMap: Record<string, number> = {
            auth: 503, insufficient_credits: 402, forbidden: 403,
            bad_request: 400, rate_limited: 429, timeout: 504,
            failed: 502, no_export_url: 502, upstream: 502, network: 502,
          };
          res.status(statusMap[err.code] ?? 500).json({
            ok: false, error: err.code, detail: err.message,
          });
          return;
        }
        throw err;
      }
    }

    // ─── DOCX ─────────────────────────────────────────────────────
    let docxLib: typeof import('docx');
    try { docxLib = await import('docx'); } catch {
      res.status(501).json({ ok: false, error: 'docx_not_installed', hint: 'Run: npm install docx --workspace=apps/api' });
      return;
    }
    const {
      Document, Packer, Paragraph, HeadingLevel, TextRun, PageBreak, AlignmentType,
      Footer, Header, PageNumber, NumberFormat, BorderStyle, ExternalHyperlink,
      LevelFormat, convertInchesToTwip,
    } = docxLib;

    // ─── Inline markdown parser ──────────────────────────────────
    // Walks **bold**, *italic*, `code`, [text](url) into TextRun array.
    // Order matters: code first (so backtick contents aren't reparsed),
    // then bold (** before *), then italic, then links last.
    type InlineToken = { type: 'text' | 'code' | 'link'; text: string; url?: string; bold?: boolean; italics?: boolean };
    function parseInline(input: string): InlineToken[] {
      const tokens: InlineToken[] = [];
      // Mask out code spans first
      const codePlaceholders: string[] = [];
      let masked = input.replace(/`([^`]+)`/g, (_, code) => {
        codePlaceholders.push(code);
        return `${codePlaceholders.length - 1}`;
      });
      // Mask links [text](url)
      const linkPlaceholders: Array<{ text: string; url: string }> = [];
      masked = masked.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => {
        linkPlaceholders.push({ text: t, url: u });
        return `${linkPlaceholders.length - 1}`;
      });

      // Now walk the masked string for bold/italic
      const pieces = masked.split(/(\*\*[^*]+\*\*|\*[^*]+\*|\d+|\d+)/g).filter(Boolean);
      for (const piece of pieces) {
        const codeMatch = piece.match(/^(\d+)$/);
        if (codeMatch) {
          tokens.push({ type: 'code', text: codePlaceholders[Number(codeMatch[1])] });
          continue;
        }
        const linkMatch = piece.match(/^(\d+)$/);
        if (linkMatch) {
          const { text, url } = linkPlaceholders[Number(linkMatch[1])];
          tokens.push({ type: 'link', text, url });
          continue;
        }
        if (/^\*\*[^*]+\*\*$/.test(piece)) {
          tokens.push({ type: 'text', text: piece.slice(2, -2), bold: true });
          continue;
        }
        if (/^\*[^*]+\*$/.test(piece)) {
          tokens.push({ type: 'text', text: piece.slice(1, -1), italics: true });
          continue;
        }
        tokens.push({ type: 'text', text: piece });
      }
      return tokens;
    }

    function inlineToRuns(input: string): Array<InstanceType<typeof TextRun> | InstanceType<typeof ExternalHyperlink>> {
      const out: Array<InstanceType<typeof TextRun> | InstanceType<typeof ExternalHyperlink>> = [];
      for (const tk of parseInline(input)) {
        if (tk.type === 'code') {
          out.push(new TextRun({
            text: tk.text,
            font: { name: 'Consolas' },
            color: '6B2438',
            shading: { fill: 'F5EEEF', type: 'clear' as never, color: 'auto' },
            size: 20,
          }));
        } else if (tk.type === 'link' && tk.url) {
          out.push(new ExternalHyperlink({
            link: tk.url,
            children: [new TextRun({ text: tk.text, color: '7A3B47', underline: {} })],
          }));
        } else {
          out.push(new TextRun({ text: tk.text, bold: tk.bold, italics: tk.italics }));
        }
      }
      return out.length > 0 ? out : [new TextRun({ text: input })];
    }

    // ─── Block parser ─────────────────────────────────────────────
    function mdBlocksToParagraphs(md: string): InstanceType<typeof Paragraph>[] {
      const out: InstanceType<typeof Paragraph>[] = [];
      const lines = md.split('\n');
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();

        // Empty line — skip
        if (!trimmed) { i++; continue; }

        // Horizontal rule
        if (/^(---|___|\*\*\*)\s*$/.test(trimmed)) {
          out.push(new Paragraph({
            border: { bottom: { color: 'CCCCCC', space: 1, style: BorderStyle.SINGLE, size: 6 } },
          }));
          i++; continue;
        }

        // ATX headings ###/##/#
        if (/^####\s+/.test(trimmed)) {
          out.push(new Paragraph({ children: inlineToRuns(trimmed.replace(/^####\s+/, '')), heading: HeadingLevel.HEADING_4 }));
          i++; continue;
        }
        if (/^###\s+/.test(trimmed)) {
          out.push(new Paragraph({ children: inlineToRuns(trimmed.replace(/^###\s+/, '')), heading: HeadingLevel.HEADING_3 }));
          i++; continue;
        }
        if (/^##\s+/.test(trimmed)) {
          out.push(new Paragraph({ children: inlineToRuns(trimmed.replace(/^##\s+/, '')), heading: HeadingLevel.HEADING_2 }));
          i++; continue;
        }
        if (/^#\s+/.test(trimmed)) {
          out.push(new Paragraph({ children: inlineToRuns(trimmed.replace(/^#\s+/, '')), heading: HeadingLevel.HEADING_3 }));
          i++; continue;
        }

        // Code fence
        if (/^```/.test(trimmed)) {
          const codeLines: string[] = [];
          i++;
          while (i < lines.length && !/^```/.test(lines[i].trim())) {
            codeLines.push(lines[i]);
            i++;
          }
          i++; // skip closing fence
          for (const cl of codeLines) {
            out.push(new Paragraph({
              children: [new TextRun({ text: cl, font: { name: 'Consolas' }, size: 20, color: '24292E' })],
              shading: { fill: 'F6F8FA', type: 'clear' as never, color: 'auto' },
              indent: { left: convertInchesToTwip(0.25) },
            }));
          }
          continue;
        }

        // Block quote
        if (/^>\s+/.test(trimmed)) {
          const quoteLines: string[] = [];
          while (i < lines.length && /^>\s+/.test(lines[i].trim())) {
            quoteLines.push(lines[i].replace(/^\s*>\s+/, ''));
            i++;
          }
          out.push(new Paragraph({
            children: inlineToRuns(quoteLines.join(' ')),
            indent: { left: convertInchesToTwip(0.4) },
            border: { left: { color: '7A3B47', space: 8, style: BorderStyle.SINGLE, size: 18 } },
            spacing: { before: 80, after: 80 },
          }));
          continue;
        }

        // Numbered list
        if (/^\d+\.\s+/.test(trimmed)) {
          while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
            const itemText = lines[i].trim().replace(/^\d+\.\s+/, '');
            out.push(new Paragraph({
              children: inlineToRuns(itemText),
              numbering: { reference: 'cl2-numbered', level: 0 },
            }));
            i++;
          }
          continue;
        }

        // Bullet list
        if (/^[-*+]\s+/.test(trimmed)) {
          while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
            const itemText = lines[i].trim().replace(/^[-*+]\s+/, '');
            out.push(new Paragraph({
              children: inlineToRuns(itemText),
              bullet: { level: 0 },
            }));
            i++;
          }
          continue;
        }

        // Paragraph — gather contiguous non-blank, non-special lines
        const paraLines: string[] = [trimmed];
        i++;
        while (i < lines.length) {
          const l = lines[i].trim();
          if (!l) break;
          if (/^(#{1,6}\s|>\s|[-*+]\s|\d+\.\s|```|---|___|\*\*\*$)/.test(l)) break;
          paraLines.push(l);
          i++;
        }
        out.push(new Paragraph({
          children: inlineToRuns(paraLines.join(' ')),
          spacing: { before: 60, after: 60, line: 320 },
        }));
      }
      return out;
    }

    // ─── Color accent per hoja ───────────────────────────────────
    const HOJA_ACCENTS: Record<string, string> = {
      default: '7A3B47',
      burgundy: '7A3B47',
      ink: '0E1745',
      sage: '2F7A5C',
      amber: 'B57F00',
    };

    const children: InstanceType<typeof Paragraph>[] = [];

    // ─── Cover page ───────────────────────────────────────────────
    // Eyebrow: small caps "Inteligencia Legislativa · Asamblea de CR"
    children.push(new Paragraph({
      children: [new TextRun({
        text: 'INTELIGENCIA LEGISLATIVA · ASAMBLEA DE COSTA RICA',
        size: 18, color: '7A3B47', characterSpacing: 60,
      })],
      alignment: AlignmentType.CENTER,
      spacing: { before: 1800, after: 240 },
    }));

    // Title — large, centered
    children.push(new Paragraph({
      children: [new TextRun({ text: String(ws.title), size: 56, bold: true, color: '0E1745' })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
    }));

    // Description / dek
    if (ws.description && String(ws.description).trim()) {
      children.push(new Paragraph({
        children: [new TextRun({
          text: String(ws.description),
          italics: true, size: 26, color: '555555',
        })],
        alignment: AlignmentType.CENTER,
        spacing: { after: 400, line: 360 },
      }));
    }

    // Divider rule
    children.push(new Paragraph({
      border: { bottom: { color: '7A3B47', space: 1, style: BorderStyle.SINGLE, size: 12 } },
      spacing: { before: 200, after: 200 },
      alignment: AlignmentType.CENTER,
      children: [],
    }));

    // Stats line
    const dateStr = new Date().toLocaleDateString('es-CR', { day: 'numeric', month: 'long', year: 'numeric' });
    children.push(new Paragraph({
      children: [new TextRun({
        text: `${ordered.length} ${ordered.length === 1 ? 'hoja' : 'hojas'} · Generado el ${dateStr}`,
        italics: true, size: 22, color: '888888',
      })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
    }));
    children.push(new Paragraph({
      children: [new TextRun({ text: 'CL2 — Shift Lab', size: 18, color: 'AAAAAA' })],
      alignment: AlignmentType.CENTER,
    }));

    // ─── TOC ──────────────────────────────────────────────────────
    if (ordered.length > 1) {
      children.push(new Paragraph({ children: [new PageBreak()] }));
      children.push(new Paragraph({
        children: [new TextRun({ text: 'CONTENIDO', size: 22, bold: true, color: '7A3B47', characterSpacing: 80 })],
        spacing: { after: 240 },
        border: { bottom: { color: '7A3B47', space: 6, style: BorderStyle.SINGLE, size: 6 } },
      }));
      ordered.forEach((n, i) => {
        const num = String(i + 1).padStart(2, '0');
        children.push(new Paragraph({
          children: [
            new TextRun({ text: `${num}    `, color: '7A3B47', bold: true, size: 22 }),
            new TextRun({ text: String(n.title), size: 22, color: '0E1745' }),
            ...(n.subtitle
              ? [new TextRun({ text: `   —   ${n.subtitle}`, size: 20, italics: true, color: '888888' })]
              : []),
          ],
          spacing: { before: 80, after: 80 },
        }));
      });
    }

    // ─── Body — one hoja per section ──────────────────────────────
    ordered.forEach((n, i) => {
      children.push(new Paragraph({ children: [new PageBreak()] }));
      const accent = HOJA_ACCENTS[String(n.color)] ?? HOJA_ACCENTS.default;

      // Hoja number eyebrow
      children.push(new Paragraph({
        children: [new TextRun({
          text: `HOJA ${String(i + 1).padStart(2, '0')}`,
          size: 16, color: accent, bold: true, characterSpacing: 80,
        })],
        spacing: { after: 120 },
      }));
      // Title
      children.push(new Paragraph({
        children: [new TextRun({ text: String(n.title), size: 40, bold: true, color: '0E1745' })],
        spacing: { after: 80 },
      }));
      // Subtitle
      if (n.subtitle && String(n.subtitle).trim()) {
        children.push(new Paragraph({
          children: [new TextRun({ text: String(n.subtitle), size: 24, italics: true, color: '666666' })],
          spacing: { after: 240 },
        }));
      } else {
        children.push(new Paragraph({ text: '', spacing: { after: 120 } }));
      }
      // Accent bar
      children.push(new Paragraph({
        border: { bottom: { color: accent, space: 1, style: BorderStyle.SINGLE, size: 8 } },
        spacing: { after: 240 },
        children: [],
      }));

      // Body
      const md = (n.content as Record<string, unknown>)?.md as string ?? '';
      if (md.trim()) {
        children.push(...mdBlocksToParagraphs(md));
      } else {
        children.push(new Paragraph({
          children: [new TextRun({ text: '(Hoja sin contenido)', italics: true, color: 'BBBBBB' })],
        }));
      }
    });

    // ─── Document with header/footer + numbering ──────────────────
    const doc = new Document({
      creator: 'CL2 — Inteligencia Legislativa',
      title: String(ws.title),
      description: String(ws.description ?? ''),
      numbering: {
        config: [{
          reference: 'cl2-numbered',
          levels: [{
            level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: convertInchesToTwip(0.5), hanging: convertInchesToTwip(0.25) } } },
          }],
        }],
      },
      styles: {
        default: {
          document: { run: { font: { name: 'Calibri' }, size: 22 } },
        },
        paragraphStyles: [
          {
            id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal',
            run: { font: { name: 'Calibri' }, size: 36, bold: true, color: '0E1745' },
            paragraph: { spacing: { before: 360, after: 160 } },
          },
          {
            id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal',
            run: { font: { name: 'Calibri' }, size: 28, bold: true, color: '7A3B47' },
            paragraph: { spacing: { before: 240, after: 120 } },
          },
          {
            id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal',
            run: { font: { name: 'Calibri' }, size: 24, bold: true, color: '0E1745' },
            paragraph: { spacing: { before: 200, after: 100 } },
          },
        ],
      },
      sections: [{
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(1), right: convertInchesToTwip(1),
              bottom: convertInchesToTwip(1), left: convertInchesToTwip(1),
            },
          },
        },
        headers: {
          default: new Header({
            children: [new Paragraph({
              alignment: AlignmentType.RIGHT,
              children: [new TextRun({ text: String(ws.title), size: 18, color: 'AAAAAA', italics: true })],
            })],
          }),
        },
        footers: {
          default: new Footer({
            children: [new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({ text: 'CL2 · ', size: 16, color: 'AAAAAA' }),
                new TextRun({ children: [PageNumber.CURRENT], size: 16, color: 'AAAAAA' }),
                new TextRun({ text: ' / ', size: 16, color: 'AAAAAA' }),
                new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: 'AAAAAA' }),
              ],
            })],
          }),
        },
        children,
      }],
    });
    // Suppress unused-var linting on the optional NumberFormat + bullet helpers we
    // referenced via the destructure to keep the surface explicit.
    void NumberFormat;
    const buffer = await Packer.toBuffer(doc);

    req.log?.info('workspace/export ok', {
      workspace: id, format, hojas: ordered.length, bytes: buffer.length,
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.docx"`);
    res.send(buffer);
  } catch (err) {
    req.log?.warn('workspace/export failed', { error: (err as Error).message });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// POST /api/workspace/:id/nodes/:nodeId/export
// body: { format: 'md' | 'docx' | 'pdf' | 'pptx' }
workspaceRouter.post('/:id/nodes/:nodeId/export', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id, nodeId } = req.params;
  if (!await ownedWorkspace(userId, id, res)) return;

  const format = (req.body?.format ?? 'md') as string;
  if (!['md', 'docx', 'pdf', 'pptx'].includes(format)) {
    res.status(400).json({ ok: false, error: 'invalid_format', hint: 'md|docx|pdf|pptx' });
    return;
  }

  try {
    const { data: node, error } = await supa()
      .from('workspace_nodes')
      .select('title, subtitle, content')
      .eq('id', nodeId)
      .eq('workspace_id', id)
      .single();
    if (error || !node) { res.status(404).json({ ok: false, error: 'node_not_found' }); return; }

    const mdContent = (node.content as Record<string, unknown>)?.md as string ?? '';
    const safeName = (node.title as string).replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_') || 'hoja';

    if (format === 'md') {
      const body = [
        `# ${node.title}`,
        node.subtitle ? `\n*${node.subtitle}*` : '',
        '',
        mdContent,
      ].join('\n');
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.md"`);
      res.send(body);
      return;
    }

    if (format === 'docx') {
      // Lazy import — `docx` is an optional dep; graceful 501 if not installed.
      let docxLib: typeof import('docx');
      try { docxLib = await import('docx'); } catch {
        res.status(501).json({ ok: false, error: 'docx_not_installed', hint: 'Run: npm install docx --workspace=apps/api' });
        return;
      }
      const { Document, Packer, Paragraph, HeadingLevel, TextRun } = docxLib;

      const children: InstanceType<typeof Paragraph>[] = [
        new Paragraph({ text: node.title as string, heading: HeadingLevel.HEADING_1 }),
      ];
      if (node.subtitle) {
        children.push(new Paragraph({ text: node.subtitle as string, heading: HeadingLevel.HEADING_2 }));
      }
      children.push(new Paragraph({ text: '' }));
      for (const line of mdContent.split('\n')) {
        children.push(new Paragraph({ children: [new TextRun({ text: line })] }));
      }

      const doc = new Document({ sections: [{ children }] });
      const buffer = await Packer.toBuffer(doc);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.docx"`);
      res.send(buffer);
      return;
    }

    // ── PPTX via Gamma ────────────────────────────────────────────────────
    // Single-hoja PPTX. Smaller input → smaller deck. We let Gamma auto-split
    // into ~6-8 cards (a single hoja rarely deserves more) and lean on the
    // "condense" textMode so dense paragraphs become bullets.
    if (format === 'pptx') {
      const inputLines: string[] = [];
      inputLines.push(`# ${node.title}`);
      if (node.subtitle) inputLines.push('', `### ${node.subtitle}`);
      if (mdContent.trim()) inputLines.push('', mdContent.trim());
      const inputText = inputLines.join('\n').slice(0, 400_000);

      try {
        const result = await generateAndWait(
          {
            inputText,
            format: 'presentation',
            exportAs: 'pptx',
            cardSplit: 'auto',
            numCards: Math.max(4, Math.min(10, Math.ceil(mdContent.length / 600))),
            textMode: 'condense',
            textOptions: { language: 'es-419', tone: 'professional, legislative' },
            imageOptions: { source: 'aiGenerated' },
            cardOptions: { dimensions: '16x9' },
          },
          { maxDurationMs: 5 * 60 * 1000 },
        );
        req.log?.info('workspace/node-export gamma pptx ok', {
          workspace: id, node: nodeId,
          generationId: result.generationId,
          chars: inputText.length,
        });
        res.json({
          ok: true,
          format: 'pptx',
          filename: `${safeName}.pptx`,
          url: result.exportUrl,
          gammaUrl: result.gammaUrl,
          generationId: result.generationId,
        });
        return;
      } catch (err) {
        if (err instanceof GammaApiError) {
          req.log?.warn('workspace/node-export gamma pptx failed', {
            workspace: id, node: nodeId, code: err.code, error: err.message,
          });
          const statusMap: Record<string, number> = {
            auth: 503, insufficient_credits: 402, forbidden: 403,
            bad_request: 400, rate_limited: 429, timeout: 504,
            failed: 502, no_export_url: 502, upstream: 502, network: 502,
          };
          res.status(statusMap[err.code] ?? 500).json({
            ok: false, error: err.code, detail: err.message,
          });
          return;
        }
        throw err;
      }
    }

    // PDF — Phase 1
    res.status(501).json({ ok: false, error: 'pdf_phase1', hint: 'PDF export coming in Phase 1. Use MD, DOCX or PPTX for now.' });
  } catch (err) {
    req.log?.warn('workspace/export failed', { error: (err as Error).message });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// IMPORT — drop a file (img/doc/aud) onto the canvas as a new asset node
// ═══════════════════════════════════════════════════════════════════════
//
// POST /api/workspace/:id/nodes/import (multipart)
//   field "file"   — required, single file ≤ 100MB
//   field "x"/"y"  — optional, canvas position; defaults to grid next-slot
//   field "width"/"height" — optional, defaults are type-aware
//
// Pipeline:
//   1. multer parses the multipart, holds the buffer in memory
//   2. We sniff the mime → decide node `type` (image/audio/document)
//   3. Service-role Supabase client uploads to bucket `workspace-assets`
//      under `${userId}/${workspaceId}/${nodeId}-${filename}`
//   4. Get the public URL (bucket is public-read)
//   5. Insert workspace_nodes row with type + content={url, filename, ...}
//   6. Respond with the created node
//
// Bucket creation is lazy — first import in a fresh Supabase project will
// create-or-update the bucket. Migration 0014 also creates it idempotently.

const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB cap
});

const ASSET_TYPE_ALLOWLIST: Record<string, 'image' | 'audio' | 'document'> = {
  // images
  'image/png': 'image', 'image/jpeg': 'image', 'image/gif': 'image',
  'image/webp': 'image', 'image/svg+xml': 'image',
  // audio
  'audio/mpeg': 'audio', 'audio/mp4': 'audio', 'audio/wav': 'audio',
  'audio/x-wav': 'audio', 'audio/ogg': 'audio', 'audio/webm': 'audio',
  // documents
  'application/pdf': 'document',
  'application/msword': 'document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
  'text/plain': 'document', 'text/markdown': 'document',
};

/** Cap on extracted text we persist + forward to the LLM. ~15K tokens
 *  with room to spare in a Sonnet/Opus context. Beyond this we truncate
 *  with a marker so the model knows the source was longer. */
const ASSET_EXTRACT_MAX_CHARS = 60_000;

// pdf-parse v2 ESM bridge — lazy so the import cost only hits the
// first PDF upload, not every API cold start.
let _PDFParse: any | null = null;
async function getPDFParse(): Promise<any> {
  if (_PDFParse) return _PDFParse;
  const mod = await import('pdf-parse');
  _PDFParse = (mod as any).PDFParse ?? (mod as any).default?.PDFParse;
  if (!_PDFParse) throw new Error('pdf-parse: PDFParse class not found');
  return _PDFParse;
}

/**
 * Extract plain text from an uploaded asset buffer when feasible (PDF,
 * DOCX, plain text, markdown). Returns `null` for non-textual types
 * (images, audio) — the caller persists nothing in that case.
 *
 * Why on the SERVER: the user attached a doc to the canvas; from now on
 * Lexa sees this doc whenever the user asks "qué dice la hoja
 * seleccionada". Without extraction the model only saw filename+size
 * (the AssetContent shape), so it'd reply "no hay contenido" — the
 * exact bug Oscar surfaced.
 */
async function extractAssetText(
  buffer: Buffer,
  mime: string,
): Promise<string | null> {
  // Plain text + markdown — just decode.
  if (mime === 'text/plain' || mime === 'text/markdown') {
    return buffer.toString('utf-8').slice(0, ASSET_EXTRACT_MAX_CHARS);
  }
  // PDF
  if (mime === 'application/pdf') {
    const PDFParse = await getPDFParse();
    const parser = new PDFParse({ data: buffer });
    const parsed = await parser.getText();
    await parser.destroy?.();
    const txt = ((parsed.text ?? '') as string).trim();
    return txt.length > ASSET_EXTRACT_MAX_CHARS
      ? txt.slice(0, ASSET_EXTRACT_MAX_CHARS) + '\n\n[…truncado por longitud]'
      : txt;
  }
  // DOCX (the new MS Word format). The legacy .doc binary is not
  // supported by mammoth — those will skip extraction.
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const mammoth = await import('mammoth');
    const { value } = await mammoth.extractRawText({ buffer });
    const txt = (value ?? '').trim();
    return txt.length > ASSET_EXTRACT_MAX_CHARS
      ? txt.slice(0, ASSET_EXTRACT_MAX_CHARS) + '\n\n[…truncado por longitud]'
      : txt;
  }
  // Images, audio, legacy .doc, etc. — nothing to extract.
  return null;
}

let _bucketEnsured = false;
async function ensureAssetsBucket() {
  if (_bucketEnsured) return;
  // Service-role client can create buckets. Idempotent — if it exists,
  // we get a 409 we silently swallow.
  await supa().storage.createBucket('workspace-assets', {
    public: true,
    fileSizeLimit: 100 * 1024 * 1024,
  }).catch(() => null);
  _bucketEnsured = true;
}

workspaceRouter.post('/:id/nodes/import', importUpload.single('file'), async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  // multer's middleware loosens `req.params` typing — coerce explicitly
  // so tsc doesn't trip on `string | string[]` inference.
  const id = String(req.params.id);
  if (!await ownedWorkspace(userId, id, res)) return;

  if (!req.file) {
    res.status(400).json({ ok: false, error: 'file_required' });
    return;
  }

  const mime = req.file.mimetype;
  const assetType = ASSET_TYPE_ALLOWLIST[mime];
  if (!assetType) {
    res.status(415).json({
      ok: false, error: 'unsupported_media_type',
      detail: `MIME "${mime}" no permitido. Soportados: png/jpg/gif/webp/svg, mp3/m4a/wav/ogg/webm, pdf/docx/md/txt.`,
    });
    return;
  }

  await ensureAssetsBucket();

  // Generate a stable name. We use a UUID prefix so two uploads with the
  // same filename don't collide.
  const safeName = (req.file.originalname || 'file')
    .replace(/[^\w.\-]/g, '_').slice(0, 200);
  const objectId = crypto.randomUUID();
  const objectPath = `${userId}/${id}/${objectId}-${safeName}`;

  try {
    // Upload
    const { error: upErr } = await supa().storage
      .from('workspace-assets')
      .upload(objectPath, req.file.buffer, {
        contentType: mime,
        upsert: false,
      });
    if (upErr) throw new Error(`upload: ${upErr.message}`);

    // Public URL
    const { data: urlData } = supa().storage
      .from('workspace-assets')
      .getPublicUrl(objectPath);
    const publicUrl = urlData.publicUrl;

    // Position + size (type-aware defaults)
    const x = Number(req.body?.x ?? 80);
    const y = Number(req.body?.y ?? 80);
    const defaultDims = {
      image:    { width: 480, height: 360 },
      audio:    { width: 420, height: 140 },
      document: { width: 380, height: 280 },
    }[assetType];
    const width = Number(req.body?.width ?? defaultDims.width);
    const height = Number(req.body?.height ?? defaultDims.height);

    // Best-effort text extraction for PDFs / DOCXs / plain text. Failure
    // is non-fatal — the asset still gets uploaded and a node created,
    // we just can't surface its text to Lexa. (The extracted text feeds
    // the workspace turn handler so "qué dice este documento" actually
    // sees the body, not just the filename.)
    let extractedText: string | null = null;
    try {
      extractedText = await extractAssetText(req.file.buffer, mime);
    } catch (extractErr) {
      req.log?.warn('workspace/asset_extract_failed', {
        error: (extractErr as Error).message,
        mime,
        bytes: req.file.size,
      });
    }

    // Insert node row
    const { data: node, error: nErr } = await supa()
      .from('workspace_nodes')
      .insert({
        workspace_id: id,
        type: assetType,
        x, y, width, height,
        title: req.file.originalname || safeName,
        subtitle: `${assetType} · ${(req.file.size / 1024).toFixed(0)} KB`,
        content: {
          url: publicUrl,
          path: objectPath,
          filename: req.file.originalname || safeName,
          size: req.file.size,
          mime,
          ...(extractedText && extractedText.length > 0
            ? { extracted_text: extractedText }
            : {}),
        },
        color: 'default',
      })
      .select('*')
      .single();
    if (nErr) {
      // Clean up the orphan object on insert failure
      await supa().storage.from('workspace-assets').remove([objectPath]).catch(() => null);
      throw new Error(`insert: ${nErr.message}`);
    }

    req.log?.info('workspace/import ok', {
      workspace: id, nodeId: node.id, mime, bytes: req.file.size, type: assetType,
    });

    res.status(201).json({ ok: true, node });
  } catch (err) {
    req.log?.warn('workspace/import failed', { error: (err as Error).message, mime });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// POST /:id/nodes/:nodeId/reextract — re-run text extraction for an
// already-uploaded asset. Used to backfill nodes that were uploaded
// before the extractor existed (the demo's existing docx). Pulls the
// object from the public URL, runs extractAssetText, persists into
// content.extracted_text. Idempotent.
// ═══════════════════════════════════════════════════════════════════════
workspaceRouter.post('/:id/nodes/:nodeId/reextract', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const id = String(req.params.id);
  const nodeId = String(req.params.nodeId);
  if (!await ownedWorkspace(userId, id, res)) return;

  // Pull the node + its current content
  const { data: node, error: getErr } = await supa()
    .from('workspace_nodes')
    .select('id, type, content, title')
    .eq('id', nodeId)
    .eq('workspace_id', id)
    .single();
  if (getErr || !node) {
    res.status(404).json({ ok: false, error: 'node_not_found' });
    return;
  }
  if (node.type !== 'document') {
    res.status(400).json({ ok: false, error: 'not_a_document' });
    return;
  }

  const c = (node.content ?? {}) as Record<string, unknown>;
  const path = typeof c.path === 'string' ? c.path : null;
  const mime = typeof c.mime === 'string' ? c.mime : null;
  if (!path || !mime) {
    res.status(400).json({ ok: false, error: 'missing_path_or_mime' });
    return;
  }

  try {
    // Download from the storage bucket directly (private path; the
    // service-role client has read access regardless of bucket policy).
    const { data: blob, error: dlErr } = await supa()
      .storage
      .from('workspace-assets')
      .download(path);
    if (dlErr || !blob) {
      res.status(502).json({ ok: false, error: 'download_failed', detail: dlErr?.message });
      return;
    }
    const arrayBuf = await blob.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);

    const extracted = await extractAssetText(buffer, mime);
    if (!extracted) {
      res.status(415).json({ ok: false, error: 'extractor_unsupported', mime });
      return;
    }

    // Patch into content.extracted_text
    const newContent = { ...c, extracted_text: extracted };
    const { error: upErr } = await supa()
      .from('workspace_nodes')
      .update({ content: newContent })
      .eq('id', nodeId)
      .eq('workspace_id', id);
    if (upErr) throw new Error(`update: ${upErr.message}`);

    res.json({ ok: true, chars: extracted.length, truncated: extracted.includes('[…truncado por longitud]') });
  } catch (err) {
    req.log?.warn('workspace/reextract failed', { error: (err as Error).message, nodeId });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// IMPORT SOURCES — bulk insert sesión / expediente content as hojas
// ═══════════════════════════════════════════════════════════════════════
//
// POST /api/workspace/:id/import-sources
// body: { sources: [{ type: 'sesion'|'expediente', id: string }, ...] }
// returns: { ok: true, nodes: WorkspaceNode[] }
//
// Materializes one hoja-type node per source with the SOURCE'S FULL
// CONTENT formatted as HTML. Heavier payload than podcast loadSource:
// sesión embeds the full transcript text (capped) so the user can
// search/cite later from inside Hojas; expediente lists every
// document. Title / subtitle / metadata go up top so the hoja renders
// cleanly even if the editor never expands the body.
//
// Position: appended to the next free grid slots after existing nodes.
// Multi-source calls return all created nodes in input order so the
// client can stagger-animate them in.
//
// Auth: workspace owner only. Each source goes through the standard
// SIL/legacy clients; failures on individual sources are partial —
// we still create what we can and report the failures in `errors`.
const SESION_TRANSCRIPT_CAP = 60_000; // chars — well above podcast cap
const SOURCE_GRID_COLS = 3;
const SOURCE_NODE_W = 660;
const SOURCE_NODE_H = 440;
const SOURCE_NODE_GAP = 48;

interface ImportSourceItem {
  type: 'sesion' | 'expediente' | 'chat';
  id?: string | number;
  /** Only for type='chat' — the assistant message body (HTML or plain
   *  text) the client wants persisted as a new hoja. */
  payload?: {
    title?: string;
    html?: string;
    prompt?: string;
    agent?: string;
    timestamp?: string;
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Convert a multi-line plain string into <p>-separated HTML. */
function paragraphize(s: string): string {
  return s
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Construye un payload secundario con la transcripción en formato SRT
 * (timecodes [HH:MM:SS] inline). Devuelve null si la sesión no es UUID
 * o no tiene transcript_segments. Pedido por Jred 2026-05-12: el usuario
 * quiere arrastrar el SRT al workspace junto con el resumen editorial.
 */
async function buildSesionSrtPayload(
  rawId: string | number,
): Promise<{ title: string; subtitle: string; html: string; sourceLabel: string } | null> {
  const rawStr = String(rawId);
  if (!UUID_REGEX.test(rawStr)) return null; // solo sesiones nuevas (Supabase)

  const { data: s } = await supa()
    .from('sessions')
    .select('id, youtube_video_id, fecha, metadata')
    .eq('id', rawStr)
    .maybeSingle();
  if (!s) return null;

  const meta = (s.metadata ?? {}) as { raw_title?: string; sesion_label?: string };
  const title = meta.raw_title || meta.sesion_label || `Sesión ${s.youtube_video_id ?? rawStr.slice(0, 8)}`;
  const fechaFmt = s.fecha
    ? new Date(s.fecha).toLocaleDateString('es-CR', { year: 'numeric', month: 'long', day: 'numeric' })
    : '';

  // Paginar segments (cap PostgREST 1000)
  const segs: Array<{ start_seconds: number; end_seconds: number; text: string }> = [];
  for (let off = 0; off < 50_000; off += 1000) {
    const { data: page } = await supa()
      .from('transcript_segments')
      .select('start_seconds, end_seconds, text')
      .eq('session_id', rawStr)
      .order('segment_idx', { ascending: true })
      .range(off, off + 999);
    if (!page || page.length === 0) break;
    segs.push(...(page as Array<{ start_seconds: number; end_seconds: number; text: string }>));
    if (page.length < 1000) break;
  }
  if (segs.length === 0) return null;

  // Agrupar segments consecutivos en bloques de ~30s para que la SRT sea
  // legible. Sin esto cada línea es una palabra suelta — buena para
  // subtítulos pero malo para lectura. 30s es el grano que usa Lexa
  // cuando lee el transcript en el system prompt.
  const fmtTs = (sec: number): string => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s2 = Math.floor(sec % 60);
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s2).padStart(2, '0')}`
      : `${m}:${String(s2).padStart(2, '0')}`;
  };
  type Block = { start: number; end: number; texts: string[] };
  const blocks: Block[] = [];
  for (const seg of segs) {
    const last = blocks[blocks.length - 1];
    if (!last || seg.start_seconds - last.start >= 30) {
      blocks.push({ start: seg.start_seconds, end: seg.end_seconds, texts: [(seg.text ?? '').trim()] });
    } else {
      last.end = seg.end_seconds;
      last.texts.push((seg.text ?? '').trim());
    }
  }

  const html: string[] = [];
  html.push(`<h2>SRT — ${escapeHtml(title)}</h2>`);
  if (fechaFmt) html.push(`<p><em>${escapeHtml(fechaFmt)} · ${segs.length} segmentos · ${blocks.length} bloques</em></p>`);
  html.push('<p><em>Transcripción cronológica con timecodes. Útil para referenciar momentos exactos en presentaciones, informes o citas.</em></p>');
  html.push('<hr>');
  // Capamos a 60k chars para no romper el editor. Plenarias de 6h+ caben
  // si los bloques son densos.
  let charsUsed = 0;
  for (const b of blocks) {
    const line = `[${fmtTs(b.start)}] ${b.texts.filter(Boolean).join(' ').trim()}`;
    if (charsUsed + line.length > SESION_TRANSCRIPT_CAP) {
      html.push(`<p><em>… transcripción truncada en ${fmtTs(b.start)} (cap ${SESION_TRANSCRIPT_CAP} chars). Para descarga completa usá el botón "Descargar" en la sesión.</em></p>`);
      break;
    }
    html.push(`<p>${escapeHtml(line)}</p>`);
    charsUsed += line.length;
  }

  return {
    title: `SRT — ${title}`.slice(0, 200),
    subtitle: fechaFmt ? `Transcripción · ${fechaFmt}` : 'Transcripción con timecodes',
    html: html.join(''),
    sourceLabel: `srt-${rawStr.slice(0, 8)}`,
  };
}

async function buildSesionPayload(
  rawId: string | number,
): Promise<{ title: string; subtitle: string; html: string; sourceLabel: string } | null> {
  const rawStr = String(rawId);

  // ── Path A: UUID → sesión nueva en Supabase ──────────────────────────
  // Las sesiones del pipeline YouTube post-mayo 2026 viven en `sessions`
  // (Supabase). Las viejas viven en MariaDB legacy. Detectamos por shape
  // del id y resolvemos en la fuente correcta.
  if (UUID_REGEX.test(rawStr)) {
    const { data: s, error: sErr } = await supa()
      .from('sessions')
      .select('id, youtube_video_id, fecha, status, metadata, created_at')
      .eq('id', rawStr)
      .maybeSingle();
    if (sErr || !s) return null;

    const meta = (s.metadata ?? {}) as {
      raw_title?: string;
      sesion_label?: string;
      duration_seconds?: number;
      resumen?: { ejecutivo?: string; puntos_clave?: string; acuerdos?: string };
    };
    const title = meta.raw_title || meta.sesion_label || `Sesión ${s.youtube_video_id ?? rawStr.slice(0, 8)}`;
    const fechaFmt = s.fecha
      ? new Date(s.fecha).toLocaleDateString('es-CR', { year: 'numeric', month: 'long', day: 'numeric' })
      : '';

    // Transcript: lo armamos a partir de transcript_segments. Cap suficiente
    // para una plenaria (~30K palabras < 60K chars).
    let transcriptText = '';
    try {
      const { data: segs } = await supa()
        .from('transcript_segments')
        .select('text')
        .eq('session_id', rawStr)
        .order('segment_idx', { ascending: true });
      if (segs && segs.length) {
        transcriptText = segs.map((row) => (row as { text: string }).text).join(' ').slice(0, SESION_TRANSCRIPT_CAP);
      }
    } catch {
      transcriptText = '';
    }

    const html: string[] = [];
    html.push(`<h2>${escapeHtml(title)}</h2>`);
    if (fechaFmt) html.push(`<p><em>${escapeHtml(fechaFmt)}</em></p>`);

    // Resumen estructurado del LLM (3 cards) si está disponible.
    if (meta.resumen?.ejecutivo) {
      html.push('<h3>Resumen ejecutivo</h3>');
      html.push(paragraphize(meta.resumen.ejecutivo));
    }
    if (meta.resumen?.puntos_clave) {
      html.push('<h3>Puntos clave</h3>');
      html.push(paragraphize(meta.resumen.puntos_clave));
    }
    if (meta.resumen?.acuerdos) {
      html.push('<h3>Acuerdos y mociones</h3>');
      html.push(paragraphize(meta.resumen.acuerdos));
    }

    if (transcriptText.trim()) {
      html.push('<h3>Transcripción</h3>');
      html.push(paragraphize(transcriptText));
    } else if (s.youtube_video_id) {
      html.push('<h3>Transcripción</h3>');
      const ytUrl = `https://www.youtube.com/watch?v=${s.youtube_video_id}`;
      html.push(`<p><em>Transcripción aún no disponible. Fuente: <a href="${escapeHtml(ytUrl)}">YouTube</a>.</em></p>`);
    }

    html.push('<hr>');
    html.push(
      `<p><em>Importado desde la sesión ${escapeHtml(title)} de la Asamblea. Esta hoja es una copia editable — los cambios no afectan la fuente original.</em></p>`,
    );

    return {
      title: title.slice(0, 200),
      subtitle: fechaFmt || 'Sesión Plenaria',
      html: html.join(''),
      sourceLabel: `sesión-${rawStr.slice(0, 8)}`,
    };
  }

  // ── Path B: int → sesión legacy en MariaDB ──────────────────────────
  const numId = Number(rawStr);
  if (!Number.isFinite(numId) || numId <= 0) return null;
  const sess = await getTranscripcionById(numId);
  if (!sess) return null;

  // Best-effort transcript pull. We don't fail the whole import if the
  // GCS-hosted transcript is offline — we still ship the resumen.
  let transcriptText = '';
  if (sess.transcripcion) {
    try {
      const blob: TranscriptBlob = await fetchTranscriptJson(sess.transcripcion);
      transcriptText = (blob.text ?? '').slice(0, SESION_TRANSCRIPT_CAP);
    } catch {
      transcriptText = '';
    }
  }

  const fechaFmt = sess.fecha
    ? new Date(sess.fecha).toLocaleDateString('es-CR', { year: 'numeric', month: 'long', day: 'numeric' })
    : '';

  const html: string[] = [];
  html.push(`<h2>${escapeHtml(sess.titulo || `Sesión #${numId}`)}</h2>`);
  if (fechaFmt) html.push(`<p><em>${escapeHtml(fechaFmt)}</em></p>`);

  if (sess.resumen?.trim()) {
    html.push('<h3>Resumen</h3>');
    html.push(paragraphize(sess.resumen.trim()));
  }

  if (transcriptText.trim()) {
    html.push('<h3>Transcripción</h3>');
    html.push(paragraphize(transcriptText));
  } else if (sess.youtube) {
    html.push('<h3>Transcripción</h3>');
    html.push(`<p><em>No se pudo cargar la transcripción. Fuente original: <a href="${escapeHtml(sess.youtube)}">YouTube</a>.</em></p>`);
  }

  html.push('<hr>');
  html.push(
    `<p><em>Importado desde la sesión #${numId} de la Asamblea. Esta hoja es una copia editable — los cambios no afectan la fuente original.</em></p>`,
  );

  return {
    title: sess.titulo?.slice(0, 200) || `Sesión #${numId}`,
    subtitle: fechaFmt || `Sesión Plenaria #${numId}`,
    html: html.join(''),
    sourceLabel: `sesión-${numId}`,
  };
}

async function buildExpedientePayload(
  rawId: string | number,
): Promise<{ title: string; subtitle: string; html: string; sourceLabel: string } | null> {
  const numId = Number(rawId);
  if (!Number.isFinite(numId)) return null;
  const exp = await getExpedienteById(numId);
  if (!exp) return null;

  const html: string[] = [];
  html.push(`<h2>Expediente ${escapeHtml(exp.numero)}</h2>`);
  if (exp.titulo) html.push(`<p><strong>${escapeHtml(exp.titulo)}</strong></p>`);

  // Metadata block
  const meta: string[] = [];
  if (exp.proponente)         meta.push(`<strong>Proponente:</strong> ${escapeHtml(exp.proponente)}`);
  if (exp.estado)             meta.push(`<strong>Estado:</strong> ${escapeHtml(exp.estado)}`);
  if (exp.comision)           meta.push(`<strong>Comisión:</strong> ${escapeHtml(exp.comision)}`);
  if (exp.tipo)               meta.push(`<strong>Tipo:</strong> ${escapeHtml(exp.tipo)}`);
  if (exp.legislatura)        meta.push(`<strong>Legislatura:</strong> ${escapeHtml(exp.legislatura)}`);
  if (exp.fecha_presentacion) meta.push(`<strong>Presentado:</strong> ${escapeHtml(exp.fecha_presentacion)}`);
  if (meta.length) {
    html.push(`<p>${meta.join('<br>')}</p>`);
  }

  if (exp.documentos?.length) {
    html.push('<h3>Documentos</h3>');
    html.push('<ul>');
    for (const d of exp.documentos) {
      const tipo = escapeHtml(d.tipo);
      const titulo = escapeHtml(d.titulo ?? '(sin título)');
      const fecha = d.fecha ? ` · ${escapeHtml(d.fecha)}` : '';
      const link = d.source_url
        ? ` · <a href="${escapeHtml(d.source_url)}">ver fuente</a>`
        : '';
      html.push(`<li><strong>${tipo}</strong>: ${titulo}${fecha}${link}</li>`);
    }
    html.push('</ul>');
  }

  if (exp.url_detalle) {
    html.push(`<p><em>Detalle SIL: <a href="${escapeHtml(exp.url_detalle)}">${escapeHtml(exp.url_detalle)}</a></em></p>`);
  }

  html.push('<hr>');
  html.push(
    `<p><em>Importado desde el expediente ${escapeHtml(exp.numero)}. Notas y análisis abajo son tuyos — la metadata de arriba es la copia oficial al momento de la importación.</em></p>`,
  );

  return {
    title: exp.titulo
      ? `${exp.numero} — ${exp.titulo.slice(0, 160)}`
      : `Expediente ${exp.numero}`,
    subtitle: exp.proponente ? `Proponente: ${exp.proponente}` : `Expediente ${exp.numero}`,
    html: html.join(''),
    sourceLabel: `expediente-${exp.numero}`,
  };
}

/**
 * Build a hoja payload from an inline chat-message body. Unlike sesion
 * / expediente builders this does NO external fetch — the client
 * already has the assistant's text + context, we just sanitize and
 * frame it. Server-side validation prevents arbitrary HTML injection
 * (we strip <script>, on* handlers, and pin allowed tags).
 */
function buildChatPayload(
  raw: NonNullable<ImportSourceItem['payload']>,
): { title: string; subtitle: string; html: string; sourceLabel: string } | null {
  const rawHtml = (raw.html ?? '').toString().slice(0, 80_000);
  if (!rawHtml.trim()) return null;

  const safeBody = sanitizeChatHtml(rawHtml);
  const titleInput = (raw.title ?? '').toString().trim();
  const title = titleInput.length > 0
    ? titleInput.slice(0, 200)
    : derivedTitle(safeBody) || 'Conversación con Lexa';

  const ts = raw.timestamp
    ? new Date(raw.timestamp).toLocaleString('es-CR', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : new Date().toLocaleString('es-CR', { dateStyle: 'medium', timeStyle: 'short' });
  const agent = (raw.agent ?? 'Lexa').toString().slice(0, 60);

  const html: string[] = [];
  html.push(`<h2>${escapeHtml(title)}</h2>`);
  html.push(`<p><em>${escapeHtml(`Respuesta de ${agent} · ${ts}`)}</em></p>`);

  if (raw.prompt && raw.prompt.trim()) {
    html.push('<h3>Pregunta</h3>');
    html.push(`<blockquote>${escapeHtml(raw.prompt.trim().slice(0, 1500))}</blockquote>`);
  }

  html.push('<h3>Respuesta</h3>');
  html.push(safeBody);

  html.push('<hr>');
  html.push(
    `<p><em>Guardado desde el chat. La respuesta original es de ${escapeHtml(agent)}; podés editarla acá sin afectar el historial del chat.</em></p>`,
  );

  return {
    title,
    subtitle: `${agent} · ${ts}`,
    html: html.join(''),
    sourceLabel: 'chat',
  };
}

/**
 * Allow-list HTML sanitizer for chat-sourced content. We're stricter
 * than the editor's normal accept set because this string came from
 * the client and could be tampered with via DevTools. Drops:
 *   - script tags + their content
 *   - on* event-handler attributes
 *   - javascript: / data: URIs in href/src
 *   - everything outside the allowed tag list
 *
 * Markdown-like input (no tags) is wrapped in <p> blocks via
 * paragraphize() upstream.
 */
function sanitizeChatHtml(input: string): string {
  // Quick path: if there are no tags at all, paragraphize the plain text.
  if (!/<[a-z][^>]*>/i.test(input)) return paragraphize(input);

  return input
    // Strip script/style blocks entirely
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    // Strip event handlers (onclick=, onload=, etc.)
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    // Neutralize javascript: + data: URIs in attributes
    .replace(/(href|src)\s*=\s*"(?:javascript|data):[^"]*"/gi, '$1="#"')
    .replace(/(href|src)\s*=\s*'(?:javascript|data):[^']*'/gi, "$1='#'")
    // Strip any tag not in the allow-list. Matches `<tag…>` and `</tag>`.
    .replace(/<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi, (match, tag: string) => {
      const allow = new Set([
        'p', 'br', 'strong', 'em', 'u', 's', 'del',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'ul', 'ol', 'li', 'blockquote',
        'pre', 'code', 'mark',
        'a', 'hr',
      ]);
      return allow.has(tag.toLowerCase()) ? match : '';
    });
}

/** Pull the first heading or sentence as a 60-char-ish title. */
function derivedTitle(html: string): string {
  // Try to match an h1/h2/h3 first
  const h = html.match(/<(h[1-3])>([^<]+)<\/\1>/i);
  if (h?.[2]) return h[2].trim().slice(0, 80);
  // Otherwise first paragraph text up to 80 chars
  const p = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return p.slice(0, 80);
}

workspaceRouter.post('/:id/import-sources', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id: workspaceId } = req.params;
  if (!await ownedWorkspace(userId, workspaceId, res)) return;

  const sources = req.body?.sources;
  if (!Array.isArray(sources) || sources.length === 0) {
    res.status(400).json({ ok: false, error: 'sources_required' });
    return;
  }
  // Hard cap to prevent runaway imports — pickers UI will surface this.
  if (sources.length > 25) {
    res.status(400).json({ ok: false, error: 'too_many_sources', max: 25 });
    return;
  }

  // Look up current node count so we can append new ones to the next
  // free grid slot rather than overlapping existing hojas.
  const { count: existingCount, error: countErr } = await supa()
    .from('workspace_nodes')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId);
  if (countErr) {
    res.status(500).json({ ok: false, error: countErr.message });
    return;
  }
  const startIndex = existingCount ?? 0;

  const created: unknown[] = [];
  const errors: Array<{ source: ImportSourceItem; error: string }> = [];

  for (let i = 0; i < sources.length; i++) {
    const item = sources[i] as ImportSourceItem;
    if (!item || (item.type !== 'sesion' && item.type !== 'expediente' && item.type !== 'chat')) {
      errors.push({ source: item, error: 'bad_source_shape' });
      continue;
    }
    if ((item.type === 'sesion' || item.type === 'expediente') && !item.id) {
      errors.push({ source: item, error: 'missing_id' });
      continue;
    }
    if (item.type === 'chat' && (!item.payload || !item.payload.html)) {
      errors.push({ source: item, error: 'missing_payload' });
      continue;
    }
    try {
      const payload = item.type === 'sesion'
        ? await buildSesionPayload(item.id!)
        : item.type === 'expediente'
          ? await buildExpedientePayload(item.id!)
          : buildChatPayload(item.payload!);
      if (!payload) {
        errors.push({ source: item, error: 'source_not_found' });
        continue;
      }

      const slot = startIndex + i;
      const col = slot % SOURCE_GRID_COLS;
      const row = Math.floor(slot / SOURCE_GRID_COLS);
      const x = col * (SOURCE_NODE_W + SOURCE_NODE_GAP) + 80;
      const y = row * (SOURCE_NODE_H + SOURCE_NODE_GAP) + 80;

      const { data: node, error: insErr } = await supa()
        .from('workspace_nodes')
        .insert({
          workspace_id: workspaceId,
          type: 'hoja',
          x, y,
          width: SOURCE_NODE_W,
          height: SOURCE_NODE_H,
          title: payload.title,
          subtitle: payload.subtitle,
          // Body uses the same {md} key the editor reads. The string
          // is HTML, not Markdown — the field name is historical and
          // TipTap's setContent accepts both shapes interchangeably.
          content: { md: payload.html, source_label: payload.sourceLabel },
          color: item.type === 'sesion'
            ? 'ink'
            : item.type === 'expediente'
              ? 'burgundy'
              : 'sage', // chat → sage so the source is visually distinct
        })
        .select('*')
        .single();
      if (insErr) {
        errors.push({ source: item, error: insErr.message });
        continue;
      }
      created.push(node);

      // Si la fuente es una sesión UUID, agregar un nodo SECUNDARIO con la
      // transcripción en formato SRT (timecodes inline). Pedido por Jred
      // 2026-05-12: el operador trabaja sobre la sesión y necesita
      // referenciar momentos exactos por timecode en su narrativa.
      // El nodo SRT queda al lado del editorial — color 'sage' para
      // diferenciar visualmente.
      if (item.type === 'sesion') {
        try {
          const srtPayload = await buildSesionSrtPayload(item.id!);
          if (srtPayload) {
            const srtSlot = startIndex + i + sources.length; // posicionar después del bloque editorial
            const srtCol = srtSlot % SOURCE_GRID_COLS;
            const srtRow = Math.floor(srtSlot / SOURCE_GRID_COLS);
            const srtX = srtCol * (SOURCE_NODE_W + SOURCE_NODE_GAP) + 80;
            const srtY = srtRow * (SOURCE_NODE_H + SOURCE_NODE_GAP) + 80;
            const { data: srtNode } = await supa()
              .from('workspace_nodes')
              .insert({
                workspace_id: workspaceId,
                type: 'hoja',
                x: srtX, y: srtY,
                width: SOURCE_NODE_W,
                height: SOURCE_NODE_H,
                title: srtPayload.title,
                subtitle: srtPayload.subtitle,
                content: { md: srtPayload.html, source_label: srtPayload.sourceLabel },
                color: 'sage', // diferenciable del nodo editorial 'ink'
              })
              .select('*')
              .single();
            if (srtNode) created.push(srtNode);
          }
        } catch (err) {
          // No es fatal — la hoja editorial ya se creó. El SRT extra es
          // bonus, no crítico para el workflow del operador.
          req.log.warn('workspace_import_srt_failed_continuing', {
            sesion_id: item.id,
            error: (err as Error).message,
          });
        }
      }
    } catch (err) {
      errors.push({ source: item, error: (err as Error).message });
    }
  }

  if (created.length === 0) {
    res.status(502).json({ ok: false, error: 'no_sources_imported', errors });
    return;
  }

  // Bump workspace updated_at so the listing refresh picks up the change.
  // Postgrest builders don't return a Promise until awaited — wrap in
  // a try/catch instead of .catch().
  try {
    await supa()
      .from('workspaces')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', workspaceId);
  } catch {
    /* non-critical */
  }

  res.status(201).json({ ok: true, nodes: created, errors });
});

// ═══════════════════════════════════════════════════════════════════════
// SELECTION TRANSFORM — Alt+select / ⌘K inline AI ops
// ═══════════════════════════════════════════════════════════════════════
//
// POST /api/workspace/:id/transform
// body: { selection: string, action: 'rewrite' | 'summarize' | 'expand' | 'translate', tone?: string, instruction?: string }
//
// One-shot text transform on a user-highlighted fragment inside a hoja.
// The frontend sends the raw selection plus an action verb; we wrap it in
// a system prompt and return a single replacement string. No streaming —
// the UX is "click button, see result in 1-2s" so a single round-trip is
// the right shape (matches the architect endpoint pattern).
//
// Model selection: MiniMax M2.7 by default (cheap floor that handles
// rewrite/summarize fine). For 'expand' we bump to Sonnet because the
// model needs more reasoning to fabricate net-new content.
//
// Cost guardrails:
//   - selection capped at 4000 chars
//   - max_tokens: 1500 (≈4-5 paragraphs of output)
//   - response_format: text (no JSON parsing overhead)

type TransformAction = 'rewrite' | 'summarize' | 'expand' | 'translate' | 'custom';

const TRANSFORM_SYSTEMS: Record<TransformAction, string> = {
  rewrite: `Sos un editor experto. Reescribí el siguiente fragmento manteniendo el sentido, en estilo legislativo formal de Costa Rica. Conservá referencias a expedientes, fechas y actores. Devolvé SOLO el texto reescrito, sin prólogo.`,
  summarize: `Sos una asistente legislativa. Resumí el siguiente fragmento en 2-3 oraciones, conservando los datos clave (números de expediente, fechas, actores). Devolvé SOLO el resumen, sin prólogo.`,
  expand: `Sos una asistente legislativa con conocimiento del proceso de la Asamblea de Costa Rica. Expandí el siguiente fragmento agregando contexto procedimental, antecedentes históricos relevantes, o implicaciones. Mantené tono formal y objetivo. Devolvé SOLO el texto expandido (incluyendo el original integrado naturalmente), sin prólogo.`,
  translate: `Traducí el siguiente fragmento al español neutro de Costa Rica si está en otro idioma; si ya está en español, mejorá su claridad. Devolvé SOLO el texto traducido/mejorado, sin prólogo.`,
  custom: '', // filled in below from `instruction`
};

workspaceRouter.post('/:id/transform', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id } = req.params;
  if (!await ownedWorkspace(userId, id, res)) return;

  const selection = String(req.body?.selection ?? '').trim();
  const action = String(req.body?.action ?? 'rewrite') as TransformAction;
  const instruction = String(req.body?.instruction ?? '').trim();
  const tone = String(req.body?.tone ?? '').trim();

  if (!selection) { res.status(400).json({ ok: false, error: 'selection_required' }); return; }
  if (selection.length > 4000) { res.status(400).json({ ok: false, error: 'selection_too_long' }); return; }
  if (!(action in TRANSFORM_SYSTEMS)) { res.status(400).json({ ok: false, error: 'invalid_action' }); return; }
  if (action === 'custom' && !instruction) { res.status(400).json({ ok: false, error: 'instruction_required' }); return; }

  const orKey = process.env.OPENROUTER_API_KEY;
  if (!orKey) { res.status(500).json({ ok: false, error: 'openrouter_not_configured' }); return; }

  // Daily quota — workspace.* prefix shares the cap with architect/turn.
  if ((await requireQuota(userId, 'workspace.transform', res)) === 'denied') return;

  // Default to MiniMax M2 instead of Sonnet 4.6 for `expand` —
  // ~30× cheaper at acceptable quality for legislative drafting.
  // Sonnet still available via TRANSFORM_EXPAND_MODEL env override.
  const model = action === 'expand'
    ? (process.env.TRANSFORM_EXPAND_MODEL ?? 'minimax/minimax-m2')
    : (process.env.TRANSFORM_MODEL ?? 'google/gemini-3.1-flash-lite-preview');
  void logAiCall(userId, 'workspace.transform', { action, model, selection_len: selection.length });

  // Build the system prompt. For 'custom', the instruction IS the prompt.
  let systemPrompt = TRANSFORM_SYSTEMS[action];
  if (action === 'custom') {
    systemPrompt = `Sos una asistente legislativa de Costa Rica. ${instruction}. Devolvé SOLO el texto resultante, sin prólogo ni explicación.`;
  }
  if (tone) {
    systemPrompt += ` Tono: ${tone}.`;
  }

  try {
    const t0 = Date.now();
    const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${orKey}`,
        'HTTP-Referer': 'https://cl2.shift.ai',
        'X-Title': 'CL2 - Hoja Transform',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: selection },
        ],
        max_tokens: 1500,
        temperature: action === 'expand' ? 0.6 : 0.3,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!upstream.ok) {
      const errBody = await upstream.text();
      req.log?.warn('transform/openrouter_error', { status: upstream.status, action, model, body: errBody.slice(0, 300) });
      res.status(502).json({ ok: false, error: 'transform_upstream_error', detail: errBody.slice(0, 200) });
      return;
    }

    const body = await upstream.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = (body?.choices?.[0]?.message?.content ?? '').trim();
    if (!text) {
      res.status(502).json({ ok: false, error: 'transform_empty_response' });
      return;
    }

    req.log?.info('transform/ok', {
      action,
      model,
      selection_chars: selection.length,
      output_chars: text.length,
      ms: Date.now() - t0,
    });

    res.json({ ok: true, text, action, model, ms: Date.now() - t0 });
  } catch (err) {
    req.log?.warn('transform/failed', { error: (err as Error).message });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ARQUITECTA — multi-hoja generation
// ═══════════════════════════════════════════════════════════════════════
//
// POST /api/workspace/:id/architect
// body: { prompt: string }
//
// Calls OpenRouter (same key as chat) with a strict JSON-output system prompt
// that instructs Lexa to design 3-7 hojas for the user's request. Inserts all
// returned hojas in one batch and responds with the created node rows.
//
// We intentionally do NOT stream this — the canvas wants a single atomic
// "now-show-all" payload so the entrance animation looks coordinated. Pass-2
// streaming would be possible if we wanted per-hoja progress, but for the
// demo a 6-10s "Lexa is composing…" loader is more dramatic and reliable.

const ARCHITECT_SYSTEM = `Sos Lexa Arquitecta — una analista legislativa de la Asamblea Legislativa de Costa Rica.

Tu trabajo: dada una solicitud de análisis sobre un proyecto de ley, moción, dictamen o tema legislativo, escribís un BRIEF DE ANÁLISIS estructurado como múltiples páginas markdown (cada página = "hoja").

CONTEXTO IMPORTANTE: NO estás diseñando oficinas, ergonomía, ni infraestructura física. NO mencionés "espacios físicos", "puestos de trabajo", "ergonomía", "infraestructura del edificio" ni nada parecido. Lo que generás es ANÁLISIS LEGISLATIVO: contenido jurídico, político y procedimental sobre la solicitud del usuario.

Respondés ÚNICAMENTE con un objeto JSON válido siguiendo este schema EXACTO:

{
  "hojas": [
    {
      "title":      "string — título descriptivo, máx 80 chars",
      "subtitle":   "string — subtítulo de 1 línea (puede ser vacío)",
      "content_md": "string — cuerpo en markdown, OBLIGATORIO 300-700 palabras de contenido sustantivo",
      "color":      "default" | "burgundy" | "ink" | "sage" | "amber"
    }
  ],
  "summary": "string — 1-2 oraciones explicando el layout"
}

ESTRUCTURA TÍPICA (adaptala al tema):
1. Resumen Ejecutivo (color "burgundy") — qué es, quién lo propone, por qué importa
2. Antecedentes y Objeto — historial legislativo, finalidad, estado de comisión
3. Análisis de Contenido — texto del articulado, novedades, modificaciones
4. Implicaciones Jurídicas — roces constitucionales, jurisprudencia relacionada
5. Posturas y Actores — bancadas a favor/contra, dictámenes, votaciones
6. Conclusión y Recomendación — síntesis ejecutiva, próximos pasos sugeridos

REGLAS ESTRICTAS:
1. Generá entre 3 y 6 hojas según la complejidad. Variá colores.
2. La PRIMERA hoja siempre es "Resumen Ejecutivo" en burgundy.
3. CADA HOJA debe tener content_md NO VACÍO con 300-700 palabras de análisis real.
   El content_md es lo más importante — un brief sin contenido es inútil.
4. Citá expedientes así: [Exp. N°XX.XXX]. Si no tenés datos verificados, escribí "[verificar]" como marcador.
5. Markdown válido: ## subsecciones, **bold**, listas con -, líneas en blanco entre párrafos.
6. NO uses backticks ni \`\`\`json. Solo el objeto JSON puro.
7. Si la solicitud es vaga, generá un análisis hipotético basado en el número/tema mencionado.

EJEMPLO DE TEMAS para "armame análisis de la moción 23.583":
✓ Resumen Ejecutivo: Moción 23.583, Antecedentes Legislativos, Análisis del Articulado, Implicaciones Constitucionales, Posición de Bancadas
✗ Espacialidad y Flujo, Ergonomía, Infraestructura del Edificio (esto es OFICINA física, NO análisis legislativo)`;

// ─── Pre-fetch expedientes mentioned in the user's prompt ────────────
// Detects Costa Rica legislative expediente numbers in formats:
//   "23.583", "23,583", "23583", "Exp. 23.583", "expediente N° 23.583"
// Looks them up in sil_expedientes and returns formatted context blocks
// the architect can lean on. Cap at 3 expedientes per call so the system
// prompt stays bounded.
async function fetchExpedienteContext(prompt: string): Promise<string> {
  // Match groups of 4-5 digits (with optional . or , thousands separator).
  // CR expedientes are 5-digit ids — accept 12000-30000 range to filter
  // false positives like dates or article numbers.
  const numbers = new Set<number>();
  const re = /\b(\d{2})[.,]?(\d{3})\b/g;
  let m;
  while ((m = re.exec(prompt)) !== null) {
    const num = Number(`${m[1]}${m[2]}`);
    if (num >= 12000 && num <= 35000) numbers.add(num);
  }

  if (numbers.size === 0) return '';

  const ids = [...numbers].slice(0, 3);
  const expedientes = await Promise.all(ids.map((n) => getExpedienteById(n).catch(() => null)));
  const found = expedientes.filter((e): e is NonNullable<typeof e> => e !== null);

  if (found.length === 0) {
    // Mentioned but not in DB — be honest with the model
    return `\n\n[CONTEXTO SIL]\nEl usuario mencionó expediente(s) ${ids.join(', ')} pero NO se encontraron en la base de datos del SIL. Indicale al usuario en el resumen que el expediente no está indexado y armá un análisis genérico marcando datos como "[verificar]".`;
  }

  const blocks = found.map((e) => {
    const docCount = e.documentos?.length ?? 0;
    const recentDocs = (e.documentos ?? []).slice(0, 5).map((d) => `  - ${d.tipo ?? 'doc'}: ${d.titulo ?? '(sin título)'} ${d.fecha ? `(${d.fecha.slice(0, 10)})` : ''}`);
    return [
      `### Expediente N° ${e.numero}`,
      `Título oficial: ${e.titulo ?? '(sin título)'}`,
      e.proponente ? `Proponente: ${e.proponente}` : '',
      // SIL semantics:
      //   `comision` = WHERE the expediente is being discussed RIGHT NOW
      //                (e.g. "PLENARIO" once it's out of the technical commission)
      //   `estado`   = procedural state / origin commission for context
      // Label both fields explicitly so the model doesn't fold one into the other.
      e.comision ? `Ubicación actual del trámite: ${e.comision}` : '',
      e.estado ? `Estado / Comisión técnica de origen: ${e.estado}` : '',
      e.tipo ? `Tipo de procedimiento: ${e.tipo}` : '',
      e.fecha_presentacion ? `Fecha de presentación: ${e.fecha_presentacion.slice(0, 10)}` : '',
      e.legislatura ? `Legislatura: ${e.legislatura}` : '',
      `Documentos asociados (${docCount}):`,
      ...recentDocs,
      e.url_detalle ? `URL oficial: ${e.url_detalle}` : '',
    ].filter(Boolean).join('\n');
  });

  return `\n\n[CONTEXTO SIL — DATOS REALES VERIFICADOS]\nUSÁ ESTOS DATOS para tu análisis. Reglas:\n• NO inventes proponentes, comisiones, fechas, ni números de artículo que no estén aquí.\n• Cuando hables de "comisión", distinguí entre la "ubicación actual del trámite" y la "comisión técnica de origen / estado" — son DIFERENTES.\n• Si necesitás un dato no incluido (texto del articulado, votos, jurisprudencia específica), marcalo como "[verificar]".\n\n${blocks.join('\n\n')}`;
}

// ─── runArchitect helper — extracted so /turn can reuse it ───────────
async function runArchitect(workspaceId: string, prompt: string): Promise<{
  nodes: Record<string, unknown>[];
  summary: string;
  ms: number;
}> {
  const orKey = process.env.OPENROUTER_API_KEY;
  if (!orKey) throw new Error('openrouter_not_configured');

  // ── Pre-fetch SIL data (Option A — anti-hallucination) ──────────────
  // If the user mentioned expediente numbers in their prompt, look them up
  // and inject the real data into the system prompt. This grounds the
  // architect in verified facts instead of letting it hallucinate dates,
  // proponents, articles, etc.
  const t_pre = Date.now();
  const silContext = await fetchExpedienteContext(prompt);
  if (silContext) {
    console.log(`[architect] SIL context fetched in ${Date.now() - t_pre}ms · ${silContext.length} chars`);
  }

  // Existing canvas content as context for Atlas. Same fix as Lexa — without
  // this, Atlas was building new hojas blind, with zero awareness of what
  // the user already had on the canvas. Result: duplicate analysis, repeated
  // titles, hojas that contradict prior ones the user wrote.
  // Cap: 6 hojas × 4K chars ≈ 24K — leaves headroom in the 16K max_tokens
  // response window since the model uses input context separately.
  const ARCHITECT_CONTEXT_PER_HOJA = 4_000;
  const { data: existingHojas } = await supa()
    .from('workspace_nodes')
    .select('title, subtitle, content, type')
    .eq('workspace_id', workspaceId)
    .in('type', ['hoja', 'note', 'document'])
    .order('updated_at', { ascending: false })
    .limit(6);
  const canvasContextBlocks = (existingHojas ?? [])
    .map((n) => {
      const c = (n.content ?? {}) as Record<string, unknown>;
      const md = typeof c.md === 'string' ? c.md.trim() : '';
      const extracted = typeof c.extracted_text === 'string' ? c.extracted_text.trim() : '';
      const body = md || extracted;
      if (!body) return null;
      const trimmed = body.length > ARCHITECT_CONTEXT_PER_HOJA
        ? body.slice(0, ARCHITECT_CONTEXT_PER_HOJA) + '\n[…]'
        : body;
      const subtitle = (n as { subtitle?: string }).subtitle;
      const tag = n.type === 'document' ? 'Documento' : 'Hoja';
      const header = subtitle ? `"${n.title}" — ${subtitle}` : `"${n.title}"`;
      return `[${tag} ya en el canvas] ${header}:\n${trimmed}`;
    })
    .filter((s): s is string => Boolean(s));
  const canvasContext = canvasContextBlocks.length > 0
    ? '\n\nEL CANVAS YA TIENE EL SIGUIENTE CONTENIDO (no lo dupliques — extendé, complementá o referenciá):\n\n' +
      canvasContextBlocks.join('\n\n---\n\n')
    : '';

  // Find the next free starting Y so multiple architect runs stack vertically
  // instead of overwriting each other on the canvas grid.
  const { data: existing } = await supa()
    .from('workspace_nodes')
    .select('y, height')
    .eq('workspace_id', workspaceId);
  const maxBottom = (existing ?? []).reduce(
    (m, n) => Math.max(m, (n.y as number) + (n.height as number)),
    0,
  );

  // Call OpenRouter — non-streaming, JSON mode.
  const t0 = Date.now();
  const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${orKey}`,
      'HTTP-Referer': 'https://cl2.shift.ai',
      'X-Title': 'CL2 - Hojas Arquitecta',
    },
    body: JSON.stringify({
      model: process.env.ARCHITECT_MODEL ?? 'google/gemini-3.1-flash-lite-preview',
      messages: [
        { role: 'system', content: ARCHITECT_SYSTEM + silContext + canvasContext },
        { role: 'user', content: prompt },
      ],
      max_tokens: 16000,
      temperature: 0.4,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!upstream.ok) {
    const errBody = await upstream.text();
    throw new Error(`architect_upstream_error: ${errBody.slice(0, 200)}`);
  }

  const body = await upstream.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = body?.choices?.[0]?.message?.content ?? '';

  let parsed: { hojas?: Array<Record<string, unknown>>; summary?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Fallback: extract JSON from a code fence if the model misbehaved
    const m = raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
    if (!m) throw new Error('architect_invalid_json');
    parsed = JSON.parse(m[1]);
  }

  if (!Array.isArray(parsed.hojas) || parsed.hojas.length === 0) {
    throw new Error('architect_empty_response');
  }

  // Diagnostic: log how much content_md the model actually returned per hoja.
  // If average is < 200 chars, the model is producing skeleton-only output
  // (which we saw with Gemini when the prompt was ambiguous about "workspaces").
  const contentLens = parsed.hojas.map((h) => String(h.content_md ?? '').length);
  const avgLen = contentLens.reduce((s, n) => s + n, 0) / contentLens.length;
  if (avgLen < 200) {
    console.warn('[architect] LOW CONTENT — avg=' + avgLen.toFixed(0) + ' chars/hoja', {
      contentLens,
      titles: parsed.hojas.map(h => String(h.title ?? '')),
      raw_preview: raw.slice(0, 800),
    });
  } else {
    console.log('[architect] OK — ' + parsed.hojas.length + ' hojas · avg ' + avgLen.toFixed(0) + ' chars/body');
  }

  // Layout: 3-column grid below the existing content
  const NODE_W = 660, NODE_H = 440, GAP = 48, COLS = 3;
  const VALID_COLORS = new Set(['default', 'burgundy', 'ink', 'sage', 'amber']);
  const yOffset = maxBottom > 0 ? maxBottom + GAP : 80;

  const rows = parsed.hojas.slice(0, 7).map((h, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const colorRaw = String(h.color ?? 'default');
    return {
      workspace_id: workspaceId,
      type: 'hoja',
      title: String(h.title ?? 'Sin título').slice(0, 200),
      subtitle: String(h.subtitle ?? '').slice(0, 200),
      content: { md: String(h.content_md ?? '') },
      color: VALID_COLORS.has(colorRaw) ? colorRaw : 'default',
      x: col * (NODE_W + GAP) + 80,
      y: yOffset + row * (NODE_H + GAP),
      width: NODE_W,
      height: NODE_H,
    };
  });

  const { data: created, error: insErr } = await supa()
    .from('workspace_nodes')
    .insert(rows)
    .select('*');
  if (insErr) throw new Error(insErr.message);

  // Touch the workspace updated_at so the list page reorders correctly
  await supa().from('workspaces').update({ updated_at: new Date().toISOString() }).eq('id', workspaceId);

  return {
    nodes: (created ?? []) as Record<string, unknown>[],
    summary: String(parsed.summary ?? ''),
    ms: Date.now() - t0,
  };
}

workspaceRouter.post('/:id/architect', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id } = req.params;
  if (!await ownedWorkspace(userId, id, res)) return;

  const prompt = String(req.body?.prompt ?? '').trim();
  if (!prompt) { res.status(400).json({ ok: false, error: 'prompt_required' }); return; }
  if (prompt.length > 4000) { res.status(400).json({ ok: false, error: 'prompt_too_long' }); return; }

  // Daily quota — architect is the heaviest workspace op (max_tokens
  // 16k, multi-hoja generation). Counts against the same workspace.*
  // bucket as transforms so a user can't bypass via this route.
  if ((await requireQuota(userId, 'workspace.architect', res)) === 'denied') return;
  void logAiCall(userId, 'workspace.architect', { prompt_len: prompt.length });

  const orKey = process.env.OPENROUTER_API_KEY;
  if (!orKey) { res.status(500).json({ ok: false, error: 'openrouter_not_configured' }); return; }

  try {
    const result = await runArchitect(id, prompt);

    req.log?.info('architect/ok', {
      workspace: id,
      hojas: result.nodes.length,
      ms: result.ms,
      prompt_chars: prompt.length,
    });

    res.json({
      ok: true,
      nodes: result.nodes,
      summary: result.summary,
      ms: result.ms,
    });
  } catch (err) {
    req.log?.warn('architect/failed', { error: (err as Error).message });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// TURN — unified smart turn (classify intent → execute)
// ═══════════════════════════════════════════════════════════════════════
//
// POST /api/workspace/:id/turn
// body: { query, selected_node_id?, deep_insight?, mode, forced_intent?, hoja_titles? }
//
// Step 1: Classify intent (skip if mode=manual + forced_intent supplied).
// Step 2: Execute — chat (SSE stream), build (runArchitect), edit_selected,
//         edit_by_match.

// Model policy (cost-tuned 2026-04-26 after DeepSeek V4 Flash hit Together
// upstream rate-limits during the demo prep):
//   • CLASSIFIER → Gemini 3.1 Flash Lite Preview. ~3-4s, clean JSON,
//                  no reasoning-model footgun. Google rate-limits are
//                  separate from Together — no 429 cascade.
//   • CHAT       → Sonnet 4.6 — user-facing streaming. Same model as the
//                  main Lexa chat (consistency across the app).
//   • EDIT       → Gemini 3.1 Flash Lite Preview. Result is a node update
//                  (no token streaming), so first-token latency is moot.
//
// `preview` caveat: Google may deprecate this model id without notice.
// For the demo runway it's acceptable; flip to gemini-2.5-flash-lite
// (stable, slightly slower, slightly more expensive) via env var if a
// preview deprecation hits.
// Workspace AI model defaults. We default the heavy chat path
// (TURN_CHAT_MODEL) to MiniMax M2 instead of Sonnet 4.6 — the cost
// delta is roughly 30× and quality is acceptable for legislative-note
// drafting. Override via env if a hoja workflow needs Sonnet again.
//
// Classifier + edit stay on the cheapest tier (Gemini Flash Lite) —
// they handle short prompts and structured edits where MiniMax isn't
// a clear win and Gemini's latency is lower.
const TURN_CLASSIFIER_MODEL  = process.env.TURN_CLASSIFIER_MODEL  ?? 'google/gemini-3.1-flash-lite-preview';
const TURN_CHAT_MODEL        = process.env.TURN_CHAT_MODEL        ?? 'minimax/minimax-m2';
const TURN_EDIT_MODEL        = process.env.TURN_EDIT_MODEL        ?? 'google/gemini-3.1-flash-lite-preview';

type TurnIntent = 'chat' | 'build' | 'edit_selected' | 'edit_by_match' | 'pptx';

/**
 * Detect "user is asking for a presentation" — runs before the architect
 * gets to mis-classify the query as a build intent. We only fire on
 * unambiguous keywords; ambiguous mentions ("ese análisis para presentar
 * mañana") still route to whatever the user picked. This intentionally
 * favors false negatives (recall < precision) — a missed pptx hint just
 * means the user has to click the canvas button instead.
 */
function looksLikePptxRequest(query: string): boolean {
  const q = query.toLowerCase();
  // Verbs + noun pairs. A bare "presentación" without verb (e.g. "esta es
  // mi presentación del proyecto X") doesn't qualify — the verb is the
  // intent signal.
  const pattern = /(?:hac[eé]|cre[aá]|gener[aá]|armad?|pasa(?:me)?|convert[ií]|necesit[oa])\s+(?:una|un|el|la|esto\s+(?:en|a))?\s*(?:presentaci[oó]n|deck|pptx?|slides|powerpoint|diapositivas)/;
  return pattern.test(q);
}

workspaceRouter.post('/:id/turn', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id } = req.params;
  if (!await ownedWorkspace(userId, id, res)) return;

  const orKey = process.env.OPENROUTER_API_KEY;
  if (!orKey) { res.status(500).json({ ok: false, error: 'openrouter_not_configured' }); return; }

  const query: string         = String(req.body?.query ?? '').trim();
  const mode: string          = String(req.body?.mode ?? 'auto');
  const forcedIntent          = req.body?.forced_intent as TurnIntent | undefined;
  const selectedNodeId        = req.body?.selected_node_id as string | undefined;
  const hojaToitles           = (req.body?.hoja_titles ?? []) as Array<{ id: string; title: string; subtitle?: string }>;
  const deepInsight: boolean  = Boolean(req.body?.deep_insight);
  // 2026-04-28: agent picker en workspace. Lexa = chat (no edita).
  // Atlas = build/edit (no responde Q&A en chat-prose). Si el cliente
  // no manda agent_id (e.g. cliente viejo), fallback a la lógica
  // anterior de classifier de intent — back-compat. Ver docs/AGENTS.md.
  const requestedAgentId = (req.body?.agent_id as string | undefined)?.toLowerCase();
  const agentId: 'lexa' | 'atlas' =
    requestedAgentId === 'atlas' ? 'atlas' :
    requestedAgentId === 'lexa'  ? 'lexa'  :
    'lexa'; // default seguro
  // Conversation history (prior turns in this workspace's chat). Without
  // it the LLM treats every turn as a fresh thread — references like
  // "el #1" or "expandí esa idea" lose context. Frontend builds this
  // from the local message store; we cap downstream.
  const history = (Array.isArray(req.body?.history) ? req.body.history : []) as Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;

  if (!query)              { res.status(400).json({ ok: false, error: 'query_required' }); return; }
  if (query.length > 4000) { res.status(400).json({ ok: false, error: 'query_too_long' }); return; }

  // Daily quota gate — counts against workspace.* (shared with
  // transform + architect). Logged before dispatch so cancelled
  // streams still count.
  if ((await requireQuota(userId, 'workspace.turn', res)) === 'denied') return;
  void logAiCall(userId, 'workspace.turn', { mode, deep_insight: deepInsight });

  // ── Step 1: determine intent ──────────────────────────────────────
  let intent: TurnIntent;
  let classifierConfidence = 1.0;
  let classifierTargetNodeId: string | null = null;

  // NEW PATH (2026-04-28): si el cliente nuevo manda explícitamente
  // agent_id en el body, derivamos intent del agente seleccionado y
  // del estado de selección. Esto reemplaza el classifier para los
  // dos agentes que viven en el workspace (Lexa y Atlas), ahorrando
  // un round-trip a Gemini y una latencia de 2-3s por turn.
  //
  //   Lexa  → siempre chat (es el agente reactivo de Q&A)
  //   Atlas → edit_selected si hay nodo seleccionado, sino build
  //           (Atlas es el constructor — siempre produce estructura)
  if (requestedAgentId) {
    // Pptx pre-empt: independent of agent_id, an unambiguous "hacé una
    // presentación" should produce a deck — not be silently routed into
    // the architect's "build hojas" mode (which is what was happening
    // before this branch existed). The keyword detector is intentionally
    // tight; ambiguous mentions still flow to the picker default.
    if (looksLikePptxRequest(query)) {
      intent = 'pptx';
      req.log?.info('turn/pptx_detected', { agentId, query: query.slice(0, 80) });
    } else {
      intent = agentId === 'lexa'
        ? 'chat'
        : (selectedNodeId ? 'edit_selected' : 'build');
      req.log?.info('turn/agent_picker', { agentId, intent, selectedNodeId });
    }
    classifierTargetNodeId = selectedNodeId ?? null;
  } else if (mode === 'manual' && forcedIntent) {
    intent = forcedIntent;
  } else {
    // Auto-classify via OpenRouter
    const classifierSystem = `Sos un clasificador de intenciones para CL2 (asistente legislativa de Costa Rica).
Dado el mensaje del usuario y el contexto del workspace, devolvé ÚNICAMENTE un objeto JSON con este schema exacto:
{ "intent": "chat" | "build" | "edit_selected" | "edit_by_match", "target_node_id": "<id de hoja o null>", "confidence": 0.0-1.0 }

Reglas de decisión:
- "chat" = pregunta o diálogo informativo (¿qué es?, ¿cuál es el estado de?, explicame)
- "build" = pedido de armar nuevo análisis multi-hoja ("armame", "creá hojas sobre", "análisis completo de", "generá un workspace")
- "edit_selected" = "mejorá esto", "reescribí", "expandí", "corregí" + hay nodo seleccionado activo
- "edit_by_match" = referencia a una hoja por título ("actualizá la cronología", "expandí el resumen ejecutivo") → target_node_id = id de la hoja que mejor coincide

Si confidence < 0.7, retornás intent="chat" de todos modos.
NO incluyas prosa. Solo el objeto JSON.`;

    const classifierUser = [
      `Mensaje: "${query}"`,
      selectedNodeId ? `Nodo seleccionado actualmente: ${selectedNodeId}` : 'Sin nodo seleccionado.',
      hojaToitles.length > 0
        ? `Hojas en el workspace:\n${hojaToitles.map(h => `- id="${h.id}" título="${h.title}"${h.subtitle ? ` subtítulo="${h.subtitle}"` : ''}`).join('\n')}`
        : 'Sin hojas aún.',
    ].join('\n');

    try {
      const clf = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${orKey}`,
          'HTTP-Referer': 'https://cl2.shift.ai',
          'X-Title': 'CL2 - Turn Classifier',
        },
        body: JSON.stringify({
          model: TURN_CLASSIFIER_MODEL,
          messages: [
            { role: 'system', content: classifierSystem },
            { role: 'user',   content: classifierUser },
          ],
          max_tokens: 2000,
          temperature: 0.1,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(15_000),
      });

      const clfBody = await clf.json() as { choices?: Array<{ message?: { content?: string } }> };
      const clfRaw  = clfBody?.choices?.[0]?.message?.content ?? '{}';
      const clfParsed = JSON.parse(clfRaw) as {
        intent?: TurnIntent;
        target_node_id?: string | null;
        confidence?: number;
      };

      classifierConfidence   = typeof clfParsed.confidence === 'number' ? clfParsed.confidence : 1.0;
      classifierTargetNodeId = clfParsed.target_node_id ?? null;
      intent = (classifierConfidence >= 0.7 && clfParsed.intent) ? clfParsed.intent : 'chat';
      req.log?.info('turn/classifier_ok', {
        intent, classifierConfidence, target: classifierTargetNodeId,
        raw: clfRaw.slice(0, 200),
      });
    } catch (clfErr) {
      // Classifier failed — fall back to chat
      req.log?.warn('turn/classifier_failed', { error: (clfErr as Error).message });
      intent = 'chat';
    }
  }

  // ── Step 2: execute ───────────────────────────────────────────────

  // ── chat: delegate to openRouterStream (Lexa with FULL tool kit) ───
  // Why route through openRouterStream instead of a local fetch:
  //   It already has all of Lexa's tools wired up (search_sil_corpus,
  //   search_reglamento, get_sil_expediente, query_legislative_graph,
  //   etc.) — same engine that powers the main /api/chat/stream path.
  //   That means the workspace chat is as capable as the home-page Lexa,
  //   not a stripped-down LLM-only echo.
  //
  //   The cost: we send the same OpenAI tool-loop traffic per turn (one
  //   non-stream pass1 + one streamed pass2). For the demo this is fine.
  //
  //   The model_override carries TURN_CHAT_MODEL so we keep Sonnet 4.6
  //   regardless of what lexa.yaml might have configured.
  if (intent === 'chat') {
    // Workspace context as a scope_system_prompt — openRouterStream
    // injects this between agent.persona and the user query.
    //
    // FOUR queries in parallel:
    //   1. Workspace metadata (title + description)
    //   2. The selected hoja, if any (full content)
    //   3. Asset nodes (PDFs/DOCXs the user dropped on the canvas)
    //   4. Hoja nodes (the user-authored pages on the canvas)  ← ADDED 2026-04-29
    //
    // Bug context: previously we only fetched (1)(2)(3). Hojas the user
    // wrote with Atlas / Lexa-inline / TipTap had their content
    // completely missing from Lexa's context — she could see titles in
    // the [Otras hojas] line but not the actual text. Result: "no puedo
    // leer el contenido, pegámelo aquí". This 4th query fixes it.
    const [
      { data: ws },
      { data: selNode },
      { data: assetNodes },
      { data: hojaNodes },
    ] = await Promise.all([
      supa().from('workspaces').select('title, description').eq('id', id).single(),
      selectedNodeId
        ? supa().from('workspace_nodes').select('title, content, type').eq('id', selectedNodeId).eq('workspace_id', id).single()
        : Promise.resolve({ data: null }),
      // (3) Asset nodes — extracted text from PDFs/DOCXs. Cap at 3 docs,
      // 8K chars each (24K total) to keep the system prompt sane.
      supa()
        .from('workspace_nodes')
        .select('id, title, content, type')
        .eq('workspace_id', id)
        .in('type', ['document'])
        .order('updated_at', { ascending: false })
        .limit(3),
      // (4) Hoja nodes — user-authored pages with markdown content.
      // Cap at 8 hojas, 5K chars each (40K total) — Sonnet 4.6 has 200K
      // context, this leaves comfortable headroom for tools / RAG.
      // Order by updated_at desc so recently-edited hojas win the cap.
      supa()
        .from('workspace_nodes')
        .select('id, title, subtitle, content, type')
        .eq('workspace_id', id)
        .in('type', ['hoja', 'note'])
        .order('updated_at', { ascending: false })
        .limit(8),
    ]);

    // Helper — pulls a markdown OR extracted_text body out of a node.
    // Returns null when the node has no usable text.
    const nodeBody = (node: Record<string, unknown> | null): string | null => {
      if (!node) return null;
      const c = node.content as Record<string, unknown> | undefined;
      if (!c) return null;
      const md = typeof c.md === 'string' ? c.md.trim() : '';
      const extracted = typeof c.extracted_text === 'string' ? c.extracted_text.trim() : '';
      const body = md || extracted;
      return body.length > 0 ? body : null;
    };

    const selBody = nodeBody(selNode as Record<string, unknown> | null);
    const ASSET_CONTEXT_PER_DOC = 8_000;
    const assetBlocks = (assetNodes ?? [])
      .filter((n) => n.id !== selectedNodeId) // selected one already shown
      .map((n) => {
        const body = nodeBody(n as Record<string, unknown>);
        if (!body) return null;
        const trimmed = body.length > ASSET_CONTEXT_PER_DOC
          ? body.slice(0, ASSET_CONTEXT_PER_DOC) + '\n[…]'
          : body;
        return `[Documento en canvas] "${n.title}":\n${trimmed}`;
      })
      .filter((s): s is string => Boolean(s));

    // Hojas the user authored (Atlas / Lexa inline / TipTap). Same shape
    // as assetBlocks but tagged differently so the model treats them
    // appropriately ("hoja" = co-authored note, "documento" = imported file).
    // Tighter per-doc cap because users tend to have more hojas than docs.
    const HOJA_CONTEXT_PER_DOC = 5_000;
    const hojaBlocks = (hojaNodes ?? [])
      .filter((n) => n.id !== selectedNodeId) // selected one already shown
      .map((n) => {
        const body = nodeBody(n as Record<string, unknown>);
        if (!body) return null;
        const trimmed = body.length > HOJA_CONTEXT_PER_DOC
          ? body.slice(0, HOJA_CONTEXT_PER_DOC) + '\n[…]'
          : body;
        const subtitle = (n as { subtitle?: string }).subtitle;
        const header = subtitle ? `"${n.title}" — ${subtitle}` : `"${n.title}"`;
        return `[Hoja en canvas] ${header}:\n${trimmed}`;
      })
      .filter((s): s is string => Boolean(s));

    // We OVERRIDE the agent persona's "only use numbered extracts" rule
    // when there is canvas/hoja content in the prompt, otherwise Sonnet
    // hallucinates that it can't read documents the user attached. This
    // sub-prompt is explicit and goes BEFORE the content blocks so the
    // model reads the rules first.
    const hasAnyCanvasContent = !!selBody || assetBlocks.length > 0 || hojaBlocks.length > 0;
    const canvasReadingRules = hasAnyCanvasContent
      ? [
          '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
          'CONTEXTO DEL WORKSPACE — REGLAS DE LECTURA',
          '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
          'A diferencia del chat principal, en este turno te estoy entregando',
          'DIRECTAMENTE el contenido de las hojas y documentos que el usuario',
          'puso en su canvas. NO son resultados de RAG ni necesitan tools.',
          '',
          'Vas a ver tres tipos de bloque:',
          '  [Hoja seleccionada]   la hoja activa con foco — prioritaria',
          '  [Hoja en canvas]      otras hojas que el usuario escribió',
          '  [Documento en canvas] PDFs/DOCXs que el usuario importó',
          '',
          '• PODÉS y DEBÉS leer todos esos bloques. NO digas "pegámelo aquí" ni',
          '  "no puedo ver el contenido" — sí podés, está literalmente abajo.',
          '• Citás el bloque por su título entrecomillado (ej: según "informe',
          '  técnico 22.403"...) — NO uses la convención [N] aquí, esos números',
          '  son sólo para extractos del SIL/transcripciones.',
          '• Si el usuario pide análisis: resumen, puntos clave, observaciones',
          '  legislativas, comparativas entre hojas — hacelo. Tenés permiso para',
          '  extrapolar y opinar profesionalmente sobre el texto provisto.',
          '• Si pide algo que requiere conectar varios bloques (ej. "compará la',
          '  hoja A con el documento B"), hacelo en una sola pasada — no le',
          '  pidas que vuelva a pegar nada.',
          '• Las tools (search_sil_corpus, search_reglamento, etc.) las usás',
          '  solo si el usuario pregunta por algo que NO está en el canvas.',
          '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        ].join('\n')
      : '';

    const scopeSystemPrompt = [
      ws ? `[Workspace actual] "${ws.title}"${ws.description ? ` — ${ws.description}` : ''}` : '',
      canvasReadingRules,
      selNode
        ? `[Hoja seleccionada] "${(selNode as Record<string,unknown>).title}":\n${selBody ?? '(sin contenido textual — puede ser una imagen, audio o documento sin extracción)'}`
        : '',
      ...hojaBlocks,
      ...assetBlocks,
      // Fallback list of titles ONLY for hojas that didn't make the
      // content cap (>8 hojas in the workspace). Lexa knows they exist
      // even if she can't read them all in one turn.
      hojaToitles.length > (hojaBlocks.length + (selNode ? 1 : 0))
        ? `[Hojas adicionales del workspace, no incluidas arriba] ${hojaToitles
            .filter((h) =>
              h.id !== selectedNodeId &&
              !hojaBlocks.some((b) => b.includes(`"${h.title}"`)),
            )
            .map((h) => `"${h.title}"`)
            .join(', ')}`
        : '',
      `Para preguntas factuales sobre legislación general que NO se refieren al canvas, usá las tools de búsqueda SIL/Reglamento/grafo igual que en el chat principal.`,
    ].filter(Boolean).join('\n\n');

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    // Meta event first (frontend reads this for the intent pill)
    res.write(`event: meta\ndata: ${JSON.stringify({ intent: 'chat', intent_confidence: classifierConfidence })}\n\n`);

    let tokensForwarded = 0;
    try {
      // Cuando el usuario eligió Atlas en el agent picker, su intent debió
      // ser build/edit_selected, no chat — pero por si llega chat con
      // agentId=atlas (e.g. Atlas en chat-prose accidental), la persona
      // de Atlas dice explícitamente "redirigí a Lexa". Acá pasamos el
      // agentId tal cual; el persona/addendum hace el resto.
      await openRouterStream({
        agent_id: agentId,
        query,
        deep_insight: deepInsight,
        model_override: TURN_CHAT_MODEL,
        scope_system_prompt: scopeSystemPrompt,
        history,
        // Note: scope_legacy_session_id stays undefined — workspace turns
        // don't activate the per-plenaria search_session_transcript tool.
        onChunk: (chunk) => {
          // Forward CerebroStreamChunk verbatim — frontend's
          // streamWorkspaceTurn parser handles {type, payload} chunks
          // (token, citation, tool_call, etc.) the same way /api/chat/stream
          // does today.
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          if (chunk.type === 'token') tokensForwarded++;
        },
      });
      req.log?.info('turn/chat_streamed', {
        tokensForwarded, model: TURN_CHAT_MODEL, deep_insight: deepInsight,
      });
    } catch (streamErr) {
      req.log?.warn('turn/chat_exception', { error: (streamErr as Error).message });
      // Surface the error inline so the assistant bubble doesn't sit empty
      res.write(`data: ${JSON.stringify({
        type: 'token',
        payload: `\n\n_[error: ${(streamErr as Error).message}]_`,
      })}\n\n`);
    }

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.write(`data: [DONE]\n\n`);
    res.end();
    return;
  }

  // ── build: delegate to runArchitect ───────────────────────────────
  if (intent === 'build') {
    try {
      const result = await runArchitect(id, query);
      res.json({ ok: true, intent: 'build', ...result });
    } catch (err) {
      res.status(502).json({ ok: false, error: (err as Error).message });
    }
    return;
  }

  // ── pptx: delegate to Gamma exporter ──────────────────────────────
  // JSON response (not SSE) — the modal-driven UX wants a single envelope
  // it can render. The frontend turns this into a card under the message.
  if (intent === 'pptx') {
    try {
      const { runWorkspacePptxExport } = await import('../services/workspacePptxExport.js');
      const result = await runWorkspacePptxExport({
        workspaceId: id,
        userId,
        force: false,
      });
      res.json({
        ok: true,
        intent: 'pptx',
        filename: result.filename,
        url: result.exportUrl,
        gammaUrl: result.gammaUrl,
        generationId: result.generationId,
        cached: result.cached,
        generatedAt: result.generatedAt,
      });
    } catch (err) {
      const code = (err as Error & { code?: string }).code ?? 'pptx_failed';
      const message = (err as Error)?.message ?? 'unknown';
      req.log?.warn('turn/pptx_failed', { workspace: id, code, error: message });
      res.status(502).json({ ok: false, intent: 'pptx', error: code, detail: message });
    }
    return;
  }

  // ── edit_selected ─────────────────────────────────────────────────
  if (intent === 'edit_selected') {
    if (!selectedNodeId) {
      res.status(400).json({ ok: false, error: 'selected_node_id_required_for_edit_selected' });
      return;
    }

    const { data: node, error: nodeErr } = await supa()
      .from('workspace_nodes')
      .select('id, title, content')
      .eq('id', selectedNodeId)
      .eq('workspace_id', id)
      .single();
    if (nodeErr || !node) { res.status(404).json({ ok: false, error: 'node_not_found' }); return; }

    const currentMd = ((node as Record<string,unknown>).content as Record<string,unknown>)?.md as string ?? '';
    const editSystem = `Sos una asistente legislativa de Costa Rica. ${query}. Devolvé SOLO el texto resultante en markdown, sin prólogo.`;

    try {
      const t0 = Date.now();
      const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${orKey}`,
          'HTTP-Referer': 'https://cl2.shift.ai',
          'X-Title': 'CL2 - Turn Edit Selected',
        },
        body: JSON.stringify({
          model: TURN_EDIT_MODEL,
          messages: [
            { role: 'system', content: editSystem },
            { role: 'user',   content: currentMd },
          ],
          max_tokens: 1500,
          temperature: 0.3,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!upstream.ok) {
        const errText = await upstream.text();
        res.status(502).json({ ok: false, error: 'edit_upstream_error', detail: errText.slice(0, 200) });
        return;
      }

      const upBody = await upstream.json() as { choices?: Array<{ message?: { content?: string } }> };
      const newText = (upBody?.choices?.[0]?.message?.content ?? '').trim();

      await supa()
        .from('workspace_nodes')
        .update({ content: { md: newText } })
        .eq('id', selectedNodeId)
        .eq('workspace_id', id);

      res.json({
        ok: true,
        intent: 'edit_selected',
        node_id: selectedNodeId,
        new_content: newText,
        model: TURN_EDIT_MODEL,
        ms: Date.now() - t0,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
    return;
  }

  // ── edit_by_match ─────────────────────────────────────────────────
  if (intent === 'edit_by_match') {
    // Use classifier's target_node_id, or fall back to first hoja_title
    const targetId = classifierTargetNodeId ?? hojaToitles[0]?.id ?? null;
    if (!targetId) {
      res.status(400).json({ ok: false, error: 'no_target_node_resolved' });
      return;
    }

    const { data: node, error: nodeErr } = await supa()
      .from('workspace_nodes')
      .select('id, title, content')
      .eq('id', targetId)
      .eq('workspace_id', id)
      .single();
    if (nodeErr || !node) { res.status(404).json({ ok: false, error: 'target_node_not_found' }); return; }

    const currentMd = ((node as Record<string,unknown>).content as Record<string,unknown>)?.md as string ?? '';
    const editSystem = `Sos una asistente legislativa de Costa Rica. ${query}. Devolvé SOLO el texto resultante en markdown, sin prólogo.`;

    try {
      const t0 = Date.now();
      const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${orKey}`,
          'HTTP-Referer': 'https://cl2.shift.ai',
          'X-Title': 'CL2 - Turn Edit By Match',
        },
        body: JSON.stringify({
          model: TURN_EDIT_MODEL,
          messages: [
            { role: 'system', content: editSystem },
            { role: 'user',   content: currentMd },
          ],
          max_tokens: 1500,
          temperature: 0.3,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!upstream.ok) {
        const errText = await upstream.text();
        res.status(502).json({ ok: false, error: 'edit_upstream_error', detail: errText.slice(0, 200) });
        return;
      }

      const upBody = await upstream.json() as { choices?: Array<{ message?: { content?: string } }> };
      const newText = (upBody?.choices?.[0]?.message?.content ?? '').trim();

      await supa()
        .from('workspace_nodes')
        .update({ content: { md: newText } })
        .eq('id', targetId)
        .eq('workspace_id', id);

      res.json({
        ok: true,
        intent: 'edit_by_match',
        node_id: targetId,
        new_content: newText,
        target_match_confidence: classifierConfidence,
        model: TURN_EDIT_MODEL,
        ms: Date.now() - t0,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
    return;
  }

  // Should never reach here
  res.status(400).json({ ok: false, error: 'unhandled_intent', intent });
});

// ═══════════════════════════════════════════════════════════════════════
// ATTACH-CONTEXT — workspace content for main chat system context
// ═══════════════════════════════════════════════════════════════════════
//
// GET /api/workspace/:id/attach-context
//
// Returns workspace title + all hojas concatenated as markdown, capped at
// 50 000 chars. Reading order: top-to-bottom by y, left-to-right by x
// (same snap-band logic as workspace export).

workspaceRouter.get('/:id/attach-context', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id } = req.params;

  try {
    const [{ data: ws, error: wsErr }, { data: nodes, error: nErr }] = await Promise.all([
      supa().from('workspaces').select('id, title, description').eq('id', id).eq('user_id', userId).single(),
      supa().from('workspace_nodes').select('id, title, subtitle, content, color, x, y').eq('workspace_id', id),
    ]);

    if (wsErr || !ws) { res.status(404).json({ ok: false, error: 'workspace_not_found' }); return; }
    if (nErr) throw new Error(nErr.message);

    // Reading order: top-to-bottom (y bands of 200px), then left-to-right
    const ordered = (nodes ?? []).slice().sort((a, b) => {
      const yA = Math.floor((a.y as number) / 200);
      const yB = Math.floor((b.y as number) / 200);
      if (yA !== yB) return yA - yB;
      return (a.x as number) - (b.x as number);
    });

    const CHAR_CAP = 50_000;
    const mdParts: string[] = [];
    let totalChars = 0;
    let truncated = false;

    for (const n of ordered) {
      const body = ((n.content as Record<string, unknown>)?.md as string) ?? '';
      const section = [
        `## ${n.title}`,
        (n.subtitle as string | undefined) ? `_${n.subtitle}_` : null,
        body.trim() || null,
        '---',
      ].filter(Boolean).join('\n') + '\n';

      if (totalChars + section.length > CHAR_CAP) {
        truncated = true;
        break;
      }

      mdParts.push(section);
      totalChars += section.length;
    }

    const full_md = mdParts.join('\n');
    const includedCount = mdParts.length;

    res.json({
      ok: true,
      workspace: { id: ws.id, title: ws.title, description: ws.description ?? '' },
      titles: ordered.slice(0, includedCount).map(n => ({
        id: n.id,
        title: n.title,
        subtitle: (n.subtitle as string | undefined) ?? '',
        color: n.color,
      })),
      full_md,
      total_chars: totalChars,
      hoja_count: includedCount,
      truncated,
    });
  } catch (err) {
    req.log?.warn('workspace/attach-context failed', { error: (err as Error).message });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// BRANDED ASSET EXPORT (carrusel / pptx / document)
// ═══════════════════════════════════════════════════════════════════════
//
// Replaces the Gamma flow with: atlasContentGenerator → htmlAssetRenderer
// → workspace_nodes insertion. The frontend gets the same shape it did
// from the Gamma path (export_url + slides preview) plus per-slide editing.
//
// Endpoints:
//   POST /:id/export-asset                          — generate
//   POST /:id/assets/:nodeId/slides/:slideIdx/edit  — chat-edit one slide
//   POST /:id/assets/:nodeId/regenerate-all         — re-run from workspace
//   GET  /:id/assets/:nodeId/history                — slide edit history

interface ExportAssetBody {
  kind?: 'carousel' | 'pptx' | 'document';
  sendToCanvas?: boolean;
  options?: {
    tono?: string;
    audiencia?: string;
    hook?: string;
    numSlides?: number;
    cta?: string;
    marca?: string;
    emojis?: boolean;
  };
}

function nodeTypeFor(kind: 'carousel' | 'pptx' | 'document'): 'carousel' | 'pptx_asset' | 'docx_asset' {
  return kind === 'carousel' ? 'carousel' : kind === 'pptx' ? 'pptx_asset' : 'docx_asset';
}

workspaceRouter.post('/:id/export-asset', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id } = req.params;
  if (!await ownedWorkspace(userId, id, res)) return;

  const body = (req.body ?? {}) as ExportAssetBody;
  // Aceptamos tanto los nombres nuevos del frontend ('pptx_asset',
  // 'docx_asset') como los originales del backend ('pptx', 'document').
  // Mapeo a la forma canónica que el resto del handler usa internamente.
  const rawKind = body.kind as string | undefined;
  const KIND_ALIASES: Record<string, 'carousel' | 'pptx' | 'document'> = {
    carousel: 'carousel',
    pptx: 'pptx',
    pptx_asset: 'pptx',
    document: 'document',
    docx: 'document',
    docx_asset: 'document',
  };
  const kind = rawKind ? KIND_ALIASES[rawKind] : undefined;
  if (!kind) {
    res.status(400).json({
      ok: false,
      error: 'invalid_kind',
      hint: 'carousel|pptx|document (recibido: ' + (rawKind ?? 'undefined') + ')',
    });
    return;
  }
  const sendToCanvas = body.sendToCanvas !== false; // default true
  const options = body.options ?? {};

  try {
    const { generateAssetContent } = await import('../services/atlasContentGenerator.js');
    const { renderAssetToPdf } = await import('../services/htmlAssetRenderer.js');

    // 1) Generate structured content via OpenRouter (anti-hallucination
    //    pre-fetches expedientes mentioned in the workspace).
    const content = await generateAssetContent({
      workspaceId: id,
      userId,
      kind,
      options,
    });

    // 2) Workspace title for filename + render context.
    const { data: ws } = await supa()
      .from('workspaces')
      .select('id, title, description')
      .eq('id', id)
      .eq('user_id', userId)
      .single();
    const wsTitle = (ws?.title as string | undefined) ?? 'Workspace';

    // 3) Pre-allocate the canvas node so we have a stable nodeId for the
    //    GCS object path. If sendToCanvas=false we still allocate but
    //    don't persist — keeps GCS prefixing predictable.
    let nodeId = `tmp-${Date.now()}`;
    let inserted: { id: string } | null = null;
    if (sendToCanvas) {
      const type = nodeTypeFor(kind);
      const titleSuffix = kind === 'carousel' ? 'Carrusel' : kind === 'pptx' ? 'Presentación' : 'Documento';

      // Find next-free canvas slot (top-right of existing nodes), same
      // pattern as the docx route uses below.
      const { data: existing } = await supa()
        .from('workspace_nodes')
        .select('x, width')
        .eq('workspace_id', id);
      const maxX = (existing ?? []).reduce(
        (m, n) => Math.max(m, ((n.x as number) ?? 0) + ((n.width as number) ?? 360)),
        0,
      );

      const r = await supa()
        .from('workspace_nodes')
        .insert({
          workspace_id: id,
          type,
          title: `${wsTitle} · ${titleSuffix}`,
          subtitle: 'Generando…',
          x: maxX > 0 ? maxX + 40 : 40,
          y: 40,
          width: 360,
          height: 200,
          content: { kind: type },
          asset_metadata: { kind: type, generating: true, source: 'manual' },
          asset_slides: content.slides,
          asset_slide_history: [],
        })
        .select('id')
        .single();
      if (r.error || !r.data) {
        // Fall back: column missing in pre-migration env. Surface a clear error.
        req.log?.warn('workspace/export-asset insert failed', { error: r.error?.message });
        res.status(500).json({ ok: false, error: 'asset_node_insert_failed', detail: r.error?.message });
        return;
      }
      inserted = r.data as { id: string };
      nodeId = inserted.id;
    }

    // 4) Render PDF via Playwright + brand template, upload to GCS.
    const render = await renderAssetToPdf({
      content,
      kind,
      userId,
      workspaceId: id,
      nodeId,
      workspaceTitle: wsTitle,
      options: {
        edition: undefined,
        footerLeft: undefined,
        footerRight: undefined,
      },
    });

    const assetMetadata = {
      kind: nodeTypeFor(kind),
      export_url: render.exportUrl,
      gcs_path: render.gcsPath,
      filename: render.filename,
      slides_count: render.slidesCount,
      generated_at: render.generatedAt,
      options,
      source: 'manual' as const,
    };

    if (inserted) {
      const { error: updErr } = await supa()
        .from('workspace_nodes')
        .update({
          subtitle: render.filename,
          asset_metadata: assetMetadata,
          // asset_slides was already set above, leave as-is.
        })
        .eq('id', inserted.id);
      if (updErr) {
        req.log?.warn('workspace/export-asset update failed', { error: updErr.message });
      }
      // Touch workspace.updated_at so the canvas list re-renders fresh.
      await supa()
        .from('workspaces')
        .update({ updated_at: render.generatedAt })
        .eq('id', id)
        .eq('user_id', userId);
    }

    req.log?.info('workspace/export-asset ok', {
      workspace: id, kind, nodeId, slides: render.slidesCount,
    });

    res.json({
      ok: true,
      node_id: inserted?.id ?? null,
      asset_metadata: assetMetadata,
      slides: content.slides.map((s) => ({
        idx: s.idx,
        kind: s.kind,
        headline: s.headline,
        eyebrow: s.eyebrow ?? null,
        body_preview: s.body ? s.body.slice(0, 240) : null,
      })),
    });
  } catch (err) {
    req.log?.warn('workspace/export-asset failed', { workspace: id, error: (err as Error).message });
    res.status(500).json({ ok: false, error: 'export_asset_failed', detail: (err as Error).message });
  }
});

// POST /:id/assets/:nodeId/slides/:slideIdx/edit
// Body: { instruction: string }
// Edits one slide via OpenRouter, persists before/after to asset_slide_history,
// then re-renders the full PDF (the cost is ~5s — acceptable for the demo
// flow, and avoids partial-PDF stitching complexity).
workspaceRouter.post('/:id/assets/:nodeId/slides/:slideIdx/edit', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id, nodeId, slideIdx } = req.params;
  if (!await ownedWorkspace(userId, id, res)) return;

  const slideIndex = Number.parseInt(slideIdx, 10);
  if (!Number.isFinite(slideIndex) || slideIndex < 1) {
    res.status(400).json({ ok: false, error: 'invalid_slide_idx' });
    return;
  }
  const instruction = String((req.body?.instruction ?? '')).trim();
  if (!instruction) {
    res.status(400).json({ ok: false, error: 'instruction_required' });
    return;
  }

  try {
    const { data: node, error: nodeErr } = await supa()
      .from('workspace_nodes')
      .select('id, type, title, asset_metadata, asset_slides, asset_slide_history')
      .eq('id', nodeId)
      .eq('workspace_id', id)
      .single();
    if (nodeErr || !node) {
      res.status(404).json({ ok: false, error: 'asset_node_not_found' });
      return;
    }
    const supportedTypes = ['carousel', 'pptx_asset', 'docx_asset'];
    if (!supportedTypes.includes(node.type as string)) {
      res.status(400).json({ ok: false, error: 'not_an_asset_node' });
      return;
    }

    const slides = (node.asset_slides as Array<Record<string, unknown>>) ?? [];
    const idxInArray = slides.findIndex((s) => Number(s.idx) === slideIndex);
    if (idxInArray < 0) {
      res.status(404).json({ ok: false, error: 'slide_not_found', hint: `slide_idx=${slideIndex}` });
      return;
    }
    const beforeSlide = slides[idxInArray];

    const { editSingleSlide } = await import('../services/atlasContentGenerator.js');
    const assetKind: 'carousel' | 'pptx' | 'document' =
      node.type === 'carousel' ? 'carousel' : node.type === 'pptx_asset' ? 'pptx' : 'document';

    const editedSlide = await editSingleSlide({
      slide: beforeSlide as unknown as import('../services/atlasContentGenerator.js').AssetSlide,
      instruction,
      assetKind,
      workspaceTitle: String(node.title ?? 'Workspace'),
    });

    const updatedSlides = slides.map((s, i) => (i === idxInArray ? (editedSlide as unknown as Record<string, unknown>) : s));
    const history = (node.asset_slide_history as Array<Record<string, unknown>>) ?? [];
    history.push({
      slide_idx: slideIndex,
      before: beforeSlide,
      after: editedSlide,
      instruction,
      edited_at: new Date().toISOString(),
      edited_by_user_id: userId,
    });

    // Re-render the whole PDF with the new slides. We deliberately rebuild
    // a minimal AssetContent from existing metadata + the (now-updated)
    // slide array — we don't re-call the LLM, the slide is already final.
    const meta = (node.asset_metadata as Record<string, unknown>) ?? {};
    const { renderAssetToPdf } = await import('../services/htmlAssetRenderer.js');
    const { data: ws } = await supa()
      .from('workspaces')
      .select('title, description')
      .eq('id', id)
      .single();
    const render = await renderAssetToPdf({
      content: {
        title: String(ws?.title ?? 'Workspace'),
        subtitle: typeof ws?.description === 'string' ? ws.description : undefined,
        slides: updatedSlides as unknown as import('../services/atlasContentGenerator.js').AssetSlide[],
      },
      kind: assetKind,
      userId,
      workspaceId: id,
      nodeId,
      workspaceTitle: String(node.title ?? 'Workspace'),
    });

    const newMeta = {
      ...meta,
      export_url: render.exportUrl,
      gcs_path: render.gcsPath,
      filename: render.filename,
      slides_count: render.slidesCount,
      generated_at: render.generatedAt,
    };

    const { error: updErr } = await supa()
      .from('workspace_nodes')
      .update({
        asset_metadata: newMeta,
        asset_slides: updatedSlides,
        asset_slide_history: history,
      })
      .eq('id', nodeId);
    if (updErr) throw new Error(updErr.message);

    res.json({
      ok: true,
      node_id: nodeId,
      slide_idx: slideIndex,
      slide: editedSlide,
      asset_metadata: newMeta,
    });
  } catch (err) {
    req.log?.warn('workspace/assets/slide-edit failed', { workspace: id, nodeId, error: (err as Error).message });
    res.status(500).json({ ok: false, error: 'slide_edit_failed', detail: (err as Error).message });
  }
});

// POST /:id/assets/:nodeId/regenerate-all
// Body: { options? }
// Re-runs the full LLM pipeline against the *current* workspace markdown,
// preserving the history (we append a "regenerate-all" marker but DON'T
// wipe history). Used when the user explicitly wants to start over.
workspaceRouter.post('/:id/assets/:nodeId/regenerate-all', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id, nodeId } = req.params;
  if (!await ownedWorkspace(userId, id, res)) return;

  const options = (req.body?.options ?? {}) as ExportAssetBody['options'];

  try {
    const { data: node, error: nodeErr } = await supa()
      .from('workspace_nodes')
      .select('id, type, title, asset_metadata, asset_slide_history')
      .eq('id', nodeId)
      .eq('workspace_id', id)
      .single();
    if (nodeErr || !node) {
      res.status(404).json({ ok: false, error: 'asset_node_not_found' });
      return;
    }
    const assetKind: 'carousel' | 'pptx' | 'document' =
      node.type === 'carousel' ? 'carousel' : node.type === 'pptx_asset' ? 'pptx' : 'document';

    const { generateAssetContent } = await import('../services/atlasContentGenerator.js');
    const { renderAssetToPdf } = await import('../services/htmlAssetRenderer.js');

    const content = await generateAssetContent({
      workspaceId: id,
      userId,
      kind: assetKind,
      options,
    });

    const render = await renderAssetToPdf({
      content,
      kind: assetKind,
      userId,
      workspaceId: id,
      nodeId,
      workspaceTitle: String(node.title ?? 'Workspace'),
    });

    const history = (node.asset_slide_history as Array<Record<string, unknown>>) ?? [];
    history.push({
      slide_idx: -1,
      before: null,
      after: null,
      instruction: '__regenerate_all__',
      edited_at: render.generatedAt,
      edited_by_user_id: userId,
    });

    const newMeta = {
      kind: node.type,
      export_url: render.exportUrl,
      gcs_path: render.gcsPath,
      filename: render.filename,
      slides_count: render.slidesCount,
      generated_at: render.generatedAt,
      options: options ?? {},
      source: 'manual' as const,
    };

    const { error: updErr } = await supa()
      .from('workspace_nodes')
      .update({
        asset_metadata: newMeta,
        asset_slides: content.slides,
        asset_slide_history: history,
      })
      .eq('id', nodeId);
    if (updErr) throw new Error(updErr.message);

    res.json({
      ok: true,
      node_id: nodeId,
      asset_metadata: newMeta,
      slides: content.slides.map((s) => ({
        idx: s.idx,
        kind: s.kind,
        headline: s.headline,
        eyebrow: s.eyebrow ?? null,
        body_preview: s.body ? s.body.slice(0, 240) : null,
      })),
    });
  } catch (err) {
    req.log?.warn('workspace/assets/regenerate-all failed', { workspace: id, nodeId, error: (err as Error).message });
    res.status(500).json({ ok: false, error: 'regenerate_all_failed', detail: (err as Error).message });
  }
});

// GET /:id/assets/:nodeId/history
workspaceRouter.get('/:id/assets/:nodeId/history', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id, nodeId } = req.params;
  if (!await ownedWorkspace(userId, id, res)) return;

  try {
    const { data: node, error } = await supa()
      .from('workspace_nodes')
      .select('id, type, asset_slide_history')
      .eq('id', nodeId)
      .eq('workspace_id', id)
      .single();
    if (error || !node) {
      res.status(404).json({ ok: false, error: 'asset_node_not_found' });
      return;
    }
    res.json({
      ok: true,
      node_id: nodeId,
      history: (node.asset_slide_history as unknown[]) ?? [],
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// DOCX ASSET EXPORT
// ═══════════════════════════════════════════════════════════════════════
//
// POST /api/workspace/:id/export-docx
// body: {
//   options?: { tono?: string; audiencia?: string; marca?: string }
//   sendToCanvas?: boolean   // default true — inserts a docx_asset node
// }
//
// Pipeline:
//   1. Load workspace hojas → build an AssetContent (kind='document') from them.
//   2. Call renderDocxAsset → buffer + GCS signed URL.
//   3. If sendToCanvas, insert a workspace_node with type='docx_asset'.
//   4. Return { node_id, asset_metadata, slides }.
//
// The AssetContent fixture (atlasContentGenerator stub) derives each hoja
// as a slide so the AssetDetailPanel can show sections without re-fetching.
workspaceRouter.post('/:id/export-docx', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id } = req.params;
  if (!await ownedWorkspace(userId, id, res)) return;

  const sendToCanvas: boolean = req.body?.sendToCanvas !== false; // default true
  const options: { tono?: string; audiencia?: string; marca?: string } =
    req.body?.options ?? {};

  try {
    // ── Load workspace + hojas ──────────────────────────────────────
    type WsRow = { id: string; title: string; description: string | null };
    const { data: ws, error: wsErr } = await supa()
      .from('workspaces')
      .select('id, title, description')
      .eq('id', id)
      .eq('user_id', userId)
      .single();
    if (wsErr || !ws) { res.status(404).json({ ok: false, error: 'workspace_not_found' }); return; }

    const { data: nodes, error: nErr } = await supa()
      .from('workspace_nodes')
      .select('id, title, subtitle, content, x, y')
      .eq('workspace_id', id);
    if (nErr) throw new Error(`load_nodes_failed: ${nErr.message}`);

    // Reading order: top-to-bottom (y bands 200px), left-to-right
    const ordered = ((nodes ?? []) as Array<{
      id: string; title: string; subtitle: string | null;
      content: Record<string, unknown> | null; x: number; y: number;
    }>).slice().sort((a, b) => {
      const yA = Math.floor(a.y / 200);
      const yB = Math.floor(b.y / 200);
      if (yA !== yB) return yA - yB;
      return a.x - b.x;
    });

    // ── Build AssetContent from hojas ──────────────────────────────
    // Cover slide = workspace title. Each hoja becomes a 'content' or
    // 'section' slide based on its position (first hoja → section,
    // rest → content). Quotes (body starting with ">") → quote slides.
    const { AssetContent: _unused, ..._ } = { AssetContent: null }; void _unused; void _;

    type AssetSlideLocal = {
      idx: number;
      kind: 'cover' | 'section' | 'content' | 'quote' | 'cta' | 'stats' | 'list' | 'alert' | 'comparison';
      eyebrow?: string;
      headline: string;
      body?: string;
      items?: Array<{ label: string; value: string; sub?: string }>;
      columns?: Array<{ head: string; title: string; bullets: string[] }>;
      alert?: { kind: 'recommendation' | 'warning' | 'note'; title: string; text: string };
      meta?: { footerLeft?: string; footerRight?: string };
    };

    const slides: AssetSlideLocal[] = [];

    // Slide 0: cover
    slides.push({
      idx: 0,
      kind: 'cover',
      headline: (ws as WsRow).title,
      body: (ws as WsRow).description ?? undefined,
    });

    // Subsequent slides from hojas
    ordered.forEach((n, i) => {
      const md = (n.content?.md as string) ?? '';
      const isFirst = i === 0;
      // Detect quote-like body (starts with "> ")
      const isQuote = md.trim().startsWith('> ');
      const bodyText = isQuote ? md.trim().replace(/^> /gm, '') : md.trim();

      slides.push({
        idx: i + 1,
        kind: isQuote ? 'quote' : (isFirst ? 'section' : 'content'),
        eyebrow: n.subtitle ?? undefined,
        headline: n.title as string,
        body: bodyText || undefined,
      });
    });

    const assetContent = {
      title: (ws as WsRow).title,
      subtitle: (ws as WsRow).description ?? undefined,
      slides,
    };

    // ── Render docx ────────────────────────────────────────────────
    const { renderDocxAsset } = await import('../services/docxAssetExport.js');
    const result = await renderDocxAsset({
      content: assetContent,
      options,
      userId,
      workspaceId: id,
    });

    // ── Insert canvas node if requested ───────────────────────────
    let nodeId: string | null = null;

    if (sendToCanvas) {
      // Asset metadata shape surfaced to AssetDetailPanel
      const assetMetadata = {
        export_url: result.export_url,
        filename: result.filename,
        size_bytes: result.size_bytes,
        generated_at: result.generated_at,
        gcs_path: result.gcs_path,
        tono: options.tono ?? null,
        audiencia: options.audiencia ?? null,
        marca: options.marca ?? null,
      };

      // Pseudo-slides: each slide of the document becomes a "section"
      // so the frontend AssetDetailPanel can render a list of sections.
      const assetSlides = slides.map((s) => ({
        idx: s.idx,
        kind: s.kind,
        headline: s.headline,
        body: s.body ? s.body.slice(0, 500) : undefined,
        eyebrow: s.eyebrow,
      }));

      // Canvas position: next available slot (top-right of existing nodes)
      const maxX = Math.max(0, ...(ordered.map((n) => n.x + 400)));
      const canvasX = maxX > 0 ? maxX + 40 : 40;
      const canvasY = 40;

      const { data: insertedNode, error: insertErr } = await supa()
        .from('workspace_nodes')
        .insert({
          workspace_id: id,
          user_id: userId,
          type: 'docx_asset',
          title: `${(ws as WsRow).title} · Documento`,
          subtitle: result.filename,
          x: canvasX,
          y: canvasY,
          width: 360,
          height: 200,
          content: {
            kind: 'docx_asset',
            asset_metadata: assetMetadata,
            asset_slides: assetSlides,
          },
        })
        .select('id')
        .single();

      if (insertErr) {
        // Non-fatal: the docx was generated — just skip canvas insertion.
        req.log?.warn('workspace/export-docx canvas insert failed', {
          workspace: id,
          error: insertErr.message,
        });
      } else {
        nodeId = insertedNode?.id ?? null;
      }

      // Touch workspace updated_at
      await supa()
        .from('workspaces')
        .update({ updated_at: result.generated_at })
        .eq('id', id)
        .eq('user_id', userId);
    }

    req.log?.info('workspace/export-docx ok', {
      workspace: id,
      slides: slides.length,
      bytes: result.size_bytes,
      nodeId,
    });

    res.json({
      ok: true,
      node_id: nodeId,
      asset_metadata: {
        export_url: result.export_url,
        filename: result.filename,
        size_bytes: result.size_bytes,
        generated_at: result.generated_at,
        gcs_path: result.gcs_path,
        tono: options.tono ?? null,
        audiencia: options.audiencia ?? null,
        marca: options.marca ?? null,
      },
      slides: slides.map((s) => ({
        idx: s.idx,
        kind: s.kind,
        headline: s.headline,
        eyebrow: s.eyebrow ?? null,
        body_preview: s.body ? s.body.slice(0, 200) : null,
      })),
    });
  } catch (err) {
    req.log?.warn('workspace/export-docx failed', { workspace: id, error: (err as Error).message });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Citations ────────────────────────────────────────────────────────

// POST /api/workspace/citations — save chunk to user's inbox
workspaceRouter.post('/citations', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { chunk_id, source_label, excerpt, note, node_id } = req.body ?? {};
  if (!chunk_id) { res.status(400).json({ ok: false, error: 'chunk_id_required' }); return; }

  try {
    const { data, error } = await supa()
      .from('workspace_citations')
      .upsert(
        { user_id: userId, chunk_id, source_label, excerpt, note: note ?? '', node_id: node_id ?? null },
        { onConflict: 'user_id,chunk_id', ignoreDuplicates: false },
      )
      .select('id, chunk_id, source_label, excerpt, created_at')
      .single();
    if (error) throw new Error(error.message);
    res.status(201).json({ ok: true, citation: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});
