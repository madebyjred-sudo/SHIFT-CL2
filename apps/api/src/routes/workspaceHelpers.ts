/**
 * workspaceHelpers — funciones reusables para crear workspaces desde tools
 * de agentes (e.g. Atlas `create_workspace` tool) sin tener que ir por el
 * endpoint HTTP. Las funciones acá comparten lógica con `routes/workspace.ts`
 * pero quedan en un módulo aparte para que el dispatcher de openRouterClient
 * pueda importarlas sin circulares.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase env missing for workspaceHelpers');
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export interface CreateWorkspaceArgs {
  userId: string;
  title: string;
  description?: string | null;
  seedSources?: Array<{ type: 'sesion' | 'expediente'; id: string }>;
}

export interface CreateWorkspaceResult {
  workspace_id: string;
  seeds_imported: number;
  seeds_failed: number;
}

/**
 * Crea un workspace + opcionalmente lo populá con seed sources (sesiones,
 * expedientes). Cada seed se inserta como `workspace_node` tipo 'hoja' con
 * un placeholder básico — el contenido completo (transcripts, votaciones,
 * etc.) se carga cuando el usuario abre el workspace y le pide a Atlas
 * que lo expanda.
 *
 * Diseño:
 *   • Idempotencia: si dos calls concurrentes con misma user+title llegan,
 *     ambos crean workspaces independientes — no buscamos por nombre.
 *   • Falla parcial OK: si un seed falla (sesión no existe, etc.), el
 *     workspace queda creado con los seeds que sí entraron. La función
 *     reporta counts pero no rompe.
 */
export async function createWorkspaceForUser(
  args: CreateWorkspaceArgs,
): Promise<CreateWorkspaceResult> {
  const { userId, title, description, seedSources = [] } = args;

  // 1) Crear el workspace.
  const { data: ws, error: wsErr } = await supa()
    .from('workspaces')
    .insert({
      user_id: userId,
      title: title.slice(0, 200),
      description: (description ?? '').slice(0, 1000),
    })
    .select('id')
    .single();
  if (wsErr || !ws) {
    throw new Error(`create_workspace_failed: ${wsErr?.message ?? 'unknown'}`);
  }
  const workspaceId = (ws as { id: string }).id;

  // 2) Para cada seed, construir un node con título descriptivo + content
  //    inicial (resumen si es sesión, metadata si es expediente). NO bajamos
  //    el transcript completo — eso bloatea el canvas; el user puede pedirlo
  //    explícitamente más tarde.
  let imported = 0;
  let failed = 0;
  const SOURCE_NODE_W = 640;
  const SOURCE_NODE_H = 420;
  const SOURCE_NODE_GAP = 32;
  const COLS = 2;

  for (let i = 0; i < seedSources.length; i++) {
    const seed = seedSources[i];
    if (!seed) continue;
    const slot = i;
    const col = slot % COLS;
    const row = Math.floor(slot / COLS);
    const x = col * (SOURCE_NODE_W + SOURCE_NODE_GAP) + 80;
    const y = row * (SOURCE_NODE_H + SOURCE_NODE_GAP) + 80;

    try {
      let nodeTitle = '';
      let nodeSubtitle = '';
      let bodyHtml = '';
      let nodeColor: 'ink' | 'burgundy' = 'ink';

      if (seed.type === 'sesion') {
        nodeColor = 'ink';
        if (UUID_REGEX.test(seed.id)) {
          // Sesión nueva (Supabase pipeline)
          const { data: s } = await supa()
            .from('sessions')
            .select('id, youtube_video_id, fecha, metadata')
            .eq('id', seed.id)
            .maybeSingle();
          if (!s) {
            failed++;
            continue;
          }
          const meta = ((s as { metadata?: Record<string, unknown> }).metadata ?? {}) as {
            raw_title?: string;
            sesion_label?: string;
            resumen?: { ejecutivo?: string };
          };
          nodeTitle = meta.raw_title || meta.sesion_label || `Sesión ${(s as { id: string }).id.slice(0, 8)}`;
          const fecha = (s as { fecha?: string | null }).fecha ?? '';
          const ytId = (s as { youtube_video_id?: string | null }).youtube_video_id;
          nodeSubtitle = fecha;
          bodyHtml = `<h2>${escapeHtml(nodeTitle)}</h2>`;
          if (fecha) bodyHtml += `<p><em>${escapeHtml(fecha)}</em></p>`;
          if (meta.resumen?.ejecutivo) {
            bodyHtml += `<h3>Resumen ejecutivo</h3><p>${escapeHtml(meta.resumen.ejecutivo)}</p>`;
          }
          if (ytId) {
            bodyHtml += `<p><em>Video original: <a href="https://www.youtube.com/watch?v=${ytId}">YouTube</a></em></p>`;
          }
          bodyHtml += `<hr><p><em>Pedile a Atlas que expanda con la transcripción completa o los acuerdos cuando lo necesites.</em></p>`;
        } else {
          // Sesión legacy (int id)
          const numId = Number(seed.id);
          if (!Number.isFinite(numId) || numId <= 0) {
            failed++;
            continue;
          }
          nodeTitle = `Sesión #${numId}`;
          nodeSubtitle = 'Sesión legislativa';
          bodyHtml = `<h2>Sesión #${numId}</h2><p><em>Importada desde el archivo histórico.</em></p>`;
        }
      } else if (seed.type === 'expediente') {
        nodeColor = 'burgundy';
        nodeTitle = `Expediente ${seed.id}`;
        nodeSubtitle = 'Asamblea Legislativa';
        bodyHtml = `<h2>Expediente ${escapeHtml(seed.id)}</h2><p><em>Pedile a Atlas que cargue el dictamen, estado, proponentes y comisión asignada.</em></p>`;
      } else {
        failed++;
        continue;
      }

      const { error: insErr } = await supa()
        .from('workspace_nodes')
        .insert({
          workspace_id: workspaceId,
          type: 'hoja',
          x,
          y,
          width: SOURCE_NODE_W,
          height: SOURCE_NODE_H,
          title: nodeTitle.slice(0, 200),
          subtitle: nodeSubtitle.slice(0, 200),
          content: { md: bodyHtml, source_label: `${seed.type}:${seed.id}` },
          color: nodeColor,
        });
      if (insErr) {
        failed++;
        continue;
      }
      imported++;
    } catch {
      failed++;
    }
  }

  return { workspace_id: workspaceId, seeds_imported: imported, seeds_failed: failed };
}
