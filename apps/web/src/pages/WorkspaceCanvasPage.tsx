/**
 * WorkspaceCanvasPage — /hojas/:id
 *
 * Split layout:
 *   Left  30% — LexaContextPanel (chat, context-aware of selected node)
 *   Right 70% — ReactFlow canvas with HojaNode components
 *
 * Features:
 *   • Infinite zoomable canvas, mini-map, keyboard shortcuts
 *   • Add hoja (button + double-click canvas)
 *   • Select hoja → Lexa panel gets its content as context
 *   • Lexa answer → new HojaNode appears at next free position
 *   • Node delete via HojaNode header or Backspace/Delete key
 *   • Auto-layout positions new nodes on a grid avoiding overlaps
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, Background, BackgroundVariant, Controls, MiniMap, Panel,
  ReactFlowProvider, useNodesState, useReactFlow,
  type Node, type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  ArrowLeft, Copy, Headphones, Plus, Layers, Sparkles, Trash2, Upload, ZoomIn, Presentation,
} from 'lucide-react';
import { TopDock } from '@/components/top-dock';
import { HojaNode } from '@/components/hoja/HojaNode';
import { AssetNode } from '@/components/hoja/AssetNode';
import { LexaContextPanel } from '@/components/hoja/LexaContextPanel'; // kept for rollback
import { HojaFormatMenu } from '@/components/hoja/HojaFormatMenu';
import { AnimatedAiInput } from '@/components/animated-ai-input';
import { Sidebar } from '@/components/sidebar';
import { History } from 'lucide-react';
import { useChat } from '@/lib/chat-context';
import { LexaQuickHojaModal } from '@/components/hoja/LexaQuickHojaModal';
import { PodcastModal } from '@/components/podcasts/PodcastModal';
import { BoardAudioStrip } from '@/components/podcasts/BoardAudioStrip';
import { useContextMenu, type ContextMenuItem } from '@/components/ui/context-menu';
import { navigate } from '@/lib/router';
import { cn } from '@/lib/utils';
import {
  listNodes, createNode, updateNode, deleteNode, getNode, importAsset,
  type WorkspaceNode,
} from '@/services/workspaceApi';
import { updateWorkspace, exportWorkspace, type PptxExportResult, type PptxOptions } from '@/services/workspaceApi';
import { PptxResultModal } from '@/components/workspace/PptxResultModal';
import { PptxOptionsModal } from '@/components/workspace/PptxOptionsModal';
import { supabase } from '@/lib/supabase';

// ─── Node type registration ───────────────────────────────────────────
// hoja → rich-text TipTap node (the default workspace primitive)
// image / audio / document → imported asset nodes (single AssetNode handles
//                            all three via type-aware render branch)
const NODE_TYPES = {
  hoja: HojaNode,
  image: AssetNode,
  audio: AssetNode,
  document: AssetNode,
} as const;

// ─── Grid layout helper ───────────────────────────────────────────────
const GRID_COLS = 3;
const NODE_W = 660;
const NODE_H = 440;
const GAP = 48;

function gridPosition(index: number): { x: number; y: number } {
  const col = index % GRID_COLS;
  const row = Math.floor(index / GRID_COLS);
  return { x: col * (NODE_W + GAP) + 80, y: row * (NODE_H + GAP) + 80 };
}

// ─── Map API node → ReactFlow node ───────────────────────────────────
// CRITICAL: pass through n.type so document/image/audio assets render
// with AssetNode (read-only metadata) instead of HojaNode (TipTap
// editor). Hardcoding 'hoja' here was destroying uploaded files —
// TipTap's autosave clobbered the asset's {url, path, mime} with
// an empty `<p>` paragraph on first keystroke.
function toRFNode(n: WorkspaceNode, workspaceId: string, callbacks: {
  onDelete: (id: string) => void;
  onSelect: (id: string) => void;
}): Node {
  // Asset types route to AssetNode; everything else (hoja, note, cite,
  // expediente_ref) renders as HojaNode. Defensive lowercasing in case
  // older rows have inconsistent casing.
  const t = (n.type ?? 'hoja').toLowerCase();
  const rfType: 'hoja' | 'image' | 'audio' | 'document' =
    t === 'image' || t === 'audio' || t === 'document'
      ? (t as 'image' | 'audio' | 'document')
      : 'hoja';
  return {
    id: n.id,
    type: rfType,
    position: { x: n.x, y: n.y },
    style: { width: n.width, height: n.height },
    data: {
      ...n,
      workspaceId,
      onDelete: callbacks.onDelete,
      onSelect: callbacks.onSelect,
    },
    selected: false,
    draggable: true,
  };
}

// ─── Inner canvas (needs ReactFlow context) ───────────────────────────
function CanvasInner({
  workspaceId,
  title,
  onTitleChange,
  workspaceUpdatedAt,
}: {
  workspaceId: string;
  title: string;
  onTitleChange: (t: string) => void;
  workspaceUpdatedAt?: string;
}) {
  const { fitView, screenToFlowPosition } = useReactFlow();
  // Explicit Node generic — without it, useNodesState infers `never[]` from
  // the empty initial array and tsc rejects every setNodes((ns) => Node[])
  // call downstream. (Doesn't matter under `tsx watch` which is permissive.)
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNodeFull, setSelectedNodeFull] = useState<WorkspaceNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title);
  const [podcastOpen, setPodcastOpen] = useState(false);
  // Right-click → context menu surface. The fileInputRef is reused
  // across canvas + node menus so we don't mount multiple <input
  // type="file"> elements. lexaQuickOpen drives the "Pedile a Lexa una
  // hoja" affordance; we anchor it at the right-click position so it
  // feels in-context and the resulting node lands where the user clicked.
  // podcastNode tracks "generate podcast of THIS hoja" — separate from
  // the workspace-level podcastOpen so the two flows don't collide.
  const ctxMenu = useContextMenu();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [lexaQuickOpen, setLexaQuickOpen] = useState(false);
  const [pendingClickFlow, setPendingClickFlow] = useState<{ x: number; y: number } | null>(null);
  const [podcastNode, setPodcastNode] = useState<{ id: string; title: string } | null>(null);

  // Pptx flow — same modal the workspace card uses, just opened from the
  // canvas toolbar. The button sits NEXT to the podcast button so the
  // "presentation as artifact" affordance is visually parallel to the
  // "podcast as artifact" one.
  //
  // Two modals stack here:
  //   1. PptxOptionsModal — pre-generation form (tono, audiencia,
  //      propósito, marca). Pre-fills with whatever was used last time.
  //   2. PptxResultModal — loading / ready / error after generation.
  //
  // The button click opens (1); submitting (1) closes it and opens (2).
  // "Generar de nuevo" inside (2) re-opens (1) so the user can tweak
  // the options instead of regenerating with the same prompt.
  const [pptxOptionsOpen, setPptxOptionsOpen] = useState(false);
  const [cachedPptxOptions, setCachedPptxOptions] = useState<PptxOptions | undefined>(undefined);
  const [pptxModal, setPptxModal] = useState<{
    open: boolean;
    state: 'loading' | 'ready' | 'error';
    result?: PptxExportResult;
    errorMessage?: string;
    errorCode?: string;
  } | null>(null);

  // The actual generator call. Always reaches the backend with the
  // options we just collected from the form.
  const generatePptx = useCallback(async (options: PptxOptions, force: boolean) => {
    setPptxOptionsOpen(false);
    setPptxModal({ open: true, state: 'loading' });
    try {
      const result = (await exportWorkspace(workspaceId, 'pptx', title, {
        force,
        options: Object.keys(options).length > 0 ? options : undefined,
      })) as PptxExportResult;
      setPptxModal({ open: true, state: 'ready', result });
      setCachedPptxOptions(options);
    } catch (err) {
      const e = err as Error & { code?: string };
      setPptxModal({ open: true, state: 'error', errorMessage: e.message, errorCode: e.code });
    }
  }, [workspaceId, title]);

  // Chat-panel width (resizable splitter). Min = 340 (the previous
  // fixed xl size); Max = 340 × 1.618 ≈ 550. Persists per-user via
  // localStorage so the user's preferred layout survives reloads.
  const CHAT_MIN = 340;
  const CHAT_MAX = Math.round(CHAT_MIN * 1.618);
  const [chatWidth, setChatWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return CHAT_MIN;
    const stored = Number(localStorage.getItem('cl2-chat-width'));
    if (!Number.isFinite(stored) || stored < CHAT_MIN) return CHAT_MIN;
    return Math.min(stored, CHAT_MAX);
  });
  // Persist on every change (debounced via the next tick — user
  // dragging fires this many times per second; localStorage write is
  // cheap so we don't bother with throttling).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('cl2-chat-width', String(chatWidth));
  }, [chatWidth]);
  // bumpRefresh = changes whenever the strip should re-poll for a new
  // podcast row (e.g. right after we kick a new generation from the
  // modal). We pass a key derived from this into BoardAudioStrip so it
  // refetches its source list immediately.
  const [stripBump, setStripBump] = useState(0);
  const positionSaveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const handleDelete = useCallback(async (nodeId: string) => {
    setNodes((ns) => ns.filter((n) => n.id !== nodeId));
    if (selectedNodeId === nodeId) setSelectedNodeId(null);
    await deleteNode(workspaceId, nodeId).catch(() => null);
  }, [workspaceId, selectedNodeId, setNodes]);

  const handleSelect = useCallback(async (nodeId: string) => {
    setSelectedNodeId(nodeId);
    // Fetch full content (lazy — not included in list response)
    const full = await getNode(workspaceId, nodeId).catch(() => null);
    if (full) setSelectedNodeFull(full);
  }, [workspaceId]);

  // ── Workspace-scoped chat sessions ──────────────────────────────
  // Each workspace gets its OWN chat threads, separate from the main
  // sidebar and from other workspaces. On mount we restore the most
  // recent thread (or create a fresh one). The "Nuevo chat" button
  // spawns additional threads; the chat-history drawer below shows
  // every thread for THIS workspace only (filter in sidebar.tsx).
  const {
    selectOrCreateWorkspaceSession,
    startNewWorkspaceSession,
    setCurrentSessionId,
  } = useChat();
  const [chatHistoryOpen, setChatHistoryOpen] = useState(false);
  useEffect(() => {
    selectOrCreateWorkspaceSession(workspaceId, title);
    return () => {
      setCurrentSessionId(null);
    };
    // We intentionally only re-bind on workspaceId — title changes
    // shouldn't churn the session. The helper is stable enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // ── Load nodes from API ──────────────────────────────────────────
  // withContent=true so HojaNode editors paint bodies on first render.
  // Without this flag the list endpoint strips `content` for perf, and
  // refreshing the page would show every hoja as empty even though the
  // markdown is persisted in the DB.
  useEffect(() => {
    listNodes(workspaceId, { withContent: true })
      .then((apiNodes) => {
        const rfNodes = apiNodes.map((n) => toRFNode(n, workspaceId, { onDelete: handleDelete, onSelect: handleSelect }));
        setNodes(rfNodes);
        setTimeout(() => fitView({ padding: 0.2, duration: 500 }), 100);
      })
      .finally(() => setLoading(false));
  }, [workspaceId, fitView, setNodes, handleDelete, handleSelect]);

  // ── Sync callbacks into node data when they change ───────────────
  useEffect(() => {
    setNodes((ns) => ns.map((n) => ({
      ...n,
      data: { ...n.data, onDelete: handleDelete, onSelect: handleSelect },
    })));
  }, [handleDelete, handleSelect, setNodes]);

  // ── Handle node position changes (save on drag end) ───────────────
  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    onNodesChange(changes);
    // Persist position on drag end
    for (const c of changes) {
      if (c.type === 'position' && !c.dragging && c.position) {
        const { id, position } = c;
        if (positionSaveTimers.current[id]) clearTimeout(positionSaveTimers.current[id]);
        positionSaveTimers.current[id] = setTimeout(() => {
          updateNode(workspaceId, id, { x: position.x, y: position.y }).catch(() => null);
        }, 300);
      }
    }
  }, [onNodesChange, workspaceId]);

  // ── Keyboard: Delete/Backspace removes selected ───────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement).contentEditable === 'true') return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedNodeId) {
        handleDelete(selectedNodeId);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedNodeId, handleDelete]);

  // ── Add new hoja ─────────────────────────────────────────────────
  const handleAddHoja = useCallback(async (pos?: { x: number; y: number }) => {
    const position = pos ?? gridPosition(nodes.length);
    try {
      const apiNode = await createNode(workspaceId, {
        type: 'hoja',
        title: 'Sin título',
        x: position.x, y: position.y,
        width: NODE_W, height: NODE_H,
      });
      const rfNode = toRFNode(apiNode, workspaceId, { onDelete: handleDelete, onSelect: handleSelect });
      setNodes((ns) => [...ns, rfNode]);
      setSelectedNodeId(apiNode.id);
      setTimeout(() => fitView({ padding: 0.15, duration: 400 }), 50);
    } catch { /* graceful — node didn't save, don't add to canvas */ }
  }, [workspaceId, nodes.length, setNodes, fitView, handleDelete, handleSelect]);

  // ── Materialize a Lexa-authored hoja at a specific canvas pos ─────
  // Bridge for right-click → "Pedile a Lexa una hoja". The modal does
  // the LLM call; we only handle node creation here so the file stays
  // narrow on its responsibility.
  const handleLexaQuickCommit = useCallback(
    async ({ title: hojaTitle, md }: { title: string; md: string }) => {
      const pos = pendingClickFlow ?? gridPosition(nodes.length);
      const apiNode = await createNode(workspaceId, {
        type: 'hoja',
        title: hojaTitle || 'Hoja de Lexa',
        x: pos.x, y: pos.y,
        width: NODE_W, height: NODE_H,
        content: { md },
      }).catch(() => null);
      if (!apiNode) return;
      const rfNode = toRFNode(apiNode, workspaceId, { onDelete: handleDelete, onSelect: handleSelect });
      setNodes((ns) => [...ns, rfNode]);
      setSelectedNodeId(apiNode.id);
      setTimeout(() => fitView({ padding: 0.15, duration: 400 }), 50);
    },
    [workspaceId, nodes.length, setNodes, fitView, handleDelete, handleSelect, pendingClickFlow],
  );

  // ── File picker → asset node at a specific canvas pos ─────────────
  // Same pattern as drag-drop import (which the canvas already supports
  // elsewhere) but triggered from right-click. We open a hidden file
  // input and upload via importAsset; the server resolves type from
  // mime and returns the new asset node.
  const handleFilesPicked = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const basePos = pendingClickFlow ?? gridPosition(nodes.length);
      // For multi-select, stagger 24px so the nodes don't stack pixel-perfect.
      let i = 0;
      for (const file of Array.from(files)) {
        const offset = i * 24;
        const apiNode = await importAsset(workspaceId, file, {
          x: basePos.x + offset,
          y: basePos.y + offset,
        }).catch(() => null);
        if (apiNode) {
          const rfNode = toRFNode(apiNode, workspaceId, { onDelete: handleDelete, onSelect: handleSelect });
          setNodes((ns) => [...ns, rfNode]);
        }
        i++;
      }
      setTimeout(() => fitView({ padding: 0.15, duration: 400 }), 60);
    },
    [workspaceId, nodes.length, setNodes, fitView, handleDelete, handleSelect, pendingClickFlow],
  );

  // ── Double-click canvas → add hoja at that position ──────────────
  const handlePaneDoubleClick = useCallback((e: React.MouseEvent) => {
    const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    handleAddHoja({ x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 });
  }, [screenToFlowPosition, handleAddHoja]);

  // ── Right-click canvas → context menu ────────────────────────────
  // Compute the FLOW position once (in-canvas coords used by node
  // creation) and stash it via pendingClickFlow. Items that need to
  // know "where the user clicked" read it; the resulting modal/upload
  // still has the anchor after the menu closes.
  const handlePaneContextMenu = useCallback(
    (e: React.MouseEvent | MouseEvent) => {
      e.preventDefault();
      const ev = e as React.MouseEvent;
      const flow = screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
      const targetPos = { x: flow.x - NODE_W / 2, y: flow.y - NODE_H / 2 };
      setPendingClickFlow(targetPos);

      const items: ContextMenuItem[] = [
        { kind: 'header', label: 'Crear acá' },
        {
          label: 'Crear hoja',
          icon: <Plus size={14} />,
          shortcut: 'Doble clic',
          onSelect: () => handleAddHoja(targetPos),
        },
        {
          label: 'Subir archivo',
          icon: <Upload size={14} />,
          onSelect: () => fileInputRef.current?.click(),
        },
        { kind: 'separator' },
        {
          label: 'Pedile a Lexa una hoja',
          icon: <Sparkles size={14} />,
          onSelect: () => setLexaQuickOpen(true),
        },
      ];
      ctxMenu.open(ev.clientX, ev.clientY, items);
    },
    [screenToFlowPosition, handleAddHoja, ctxMenu.open],
  );

  // ── Right-click node → node-specific context menu ────────────────
  // ReactFlow fires this BEFORE the global contextmenu listener, with
  // the matching node already resolved. We don't preventDefault on
  // 'contextmenu' anywhere else, so the menu opens reliably.
  //
  // Items kept tight on purpose — duplicate / podcast / delete covers
  // 90% of node ops; deeper actions (color, resize, lock) live in the
  // node header chrome (managed by the other agent's HojaNode work).
  const handleNodeContextMenu = useCallback(
    (e: React.MouseEvent, node: Node) => {
      e.preventDefault();
      const id = node.id;
      const data = (node.data ?? {}) as { title?: string };
      const nodeTitle = (data.title ?? '').trim() || 'hoja sin título';

      const items: ContextMenuItem[] = [
        { kind: 'header', label: nodeTitle.slice(0, 32) + (nodeTitle.length > 32 ? '…' : '') },
        {
          label: 'Duplicar hoja',
          icon: <Copy size={14} />,
          onSelect: async () => {
            const full = await getNode(workspaceId, id).catch(() => null);
            if (!full) return;
            // Drop a copy 32px down-right so the user sees both.
            const dup = await createNode(workspaceId, {
              type: full.type,
              title: full.title ? `${full.title} (copia)` : 'Sin título',
              subtitle: full.subtitle ?? undefined,
              color: full.color,
              x: full.x + 32,
              y: full.y + 32,
              width: full.width,
              height: full.height,
              content: { md: full.content?.md ?? '' },
            }).catch(() => null);
            if (!dup) return;
            const rfNode = toRFNode(dup, workspaceId, { onDelete: handleDelete, onSelect: handleSelect });
            setNodes((ns) => [...ns, rfNode]);
          },
        },
        {
          label: 'Generar podcast de esta hoja',
          icon: <Headphones size={14} />,
          onSelect: () => setPodcastNode({ id, title: nodeTitle }),
        },
        { kind: 'separator' },
        {
          label: 'Eliminar hoja',
          icon: <Trash2 size={14} />,
          shortcut: 'Supr',
          destructive: true,
          onSelect: () => void handleDelete(id),
        },
      ];
      ctxMenu.open(e.clientX, e.clientY, items);
    },
    [workspaceId, ctxMenu.open, handleDelete, handleSelect, setNodes],
  );

  // ── Document-level capture-phase contextmenu listener ────────────
  // Earlier attempts (React onContextMenu, ref-scoped capture listener)
  // didn't fire on the user's setup. Moving the listener to `document`
  // in CAPTURE phase is the most aggressive interception possible — it
  // fires BEFORE every other listener, including xyflow's internal
  // contextmenu suppressor. We then filter by checking if the target
  // is inside our canvas root via `.closest('.react-flow')`; clicks
  // outside the canvas (top dock, sidebar, modals) are ignored.
  useEffect(() => {
    const handler = (ev: MouseEvent) => {
      const tgt = ev.target as HTMLElement | null;
      // eslint-disable-next-line no-console
      console.log('[ctx]', tgt?.className, 'inCanvas:', !!tgt?.closest('.react-flow'));
      if (!tgt) return;
      const inCanvas = tgt.closest('.react-flow');
      if (!inCanvas) return;
      ev.preventDefault();
      ev.stopPropagation();
      const nodeEl = tgt.closest('.react-flow__node') as HTMLElement | null;
      if (nodeEl) {
        const id = nodeEl.getAttribute('data-id') ?? '';
        const rfNode = nodes.find((n) => (n as Node).id === id) as unknown as Node | undefined;
        if (rfNode) {
          // eslint-disable-next-line no-console
          console.log('[ctx] → node menu', id);
          handleNodeContextMenu(ev as unknown as React.MouseEvent, rfNode);
          return;
        }
      }
      // eslint-disable-next-line no-console
      console.log('[ctx] → pane menu');
      handlePaneContextMenu(ev as unknown as React.MouseEvent);
    };
    document.addEventListener('contextmenu', handler, true);
    return () => document.removeEventListener('contextmenu', handler, true);
  }, [nodes, handleNodeContextMenu, handlePaneContextMenu]);

  // ── Stop ReactFlow drag inside hoja editors ──────────────────────
  // ReactFlow uses pointerdown to start node drags. The body of a
  // hoja is a TipTap .ProseMirror contenteditable inside the node —
  // clicking it should focus the editor, not initiate a drag.
  // HojaNode's existing onMouseDown stopPropagation is insufficient
  // because xyflow v12's d3-drag listens on POINTER events, not
  // MOUSE events. We intercept pointerdown at document level in
  // capture phase (fires before xyflow's own listener) and stop
  // propagation when the target is inside any .ProseMirror.
  //
  // Side benefit: same fix lets the user select text inside hojas
  // without accidentally dragging the node.
  useEffect(() => {
    const handler = (ev: PointerEvent) => {
      const tgt = ev.target as HTMLElement | null;
      if (!tgt) return;
      if (tgt.closest('.ProseMirror')) {
        ev.stopPropagation();
      }
    };
    document.addEventListener('pointerdown', handler, true);
    return () => document.removeEventListener('pointerdown', handler, true);
  }, []);

  // ── Next node position for Lexa panel ────────────────────────────
  const nextNodePosition = useCallback(() => gridPosition(nodes.length), [nodes.length]);

  // ── New node from Lexa panel ──────────────────────────────────────
  const handleNodeCreated = useCallback(async (nodeId: string) => {
    const apiNode = await getNode(workspaceId, nodeId).catch(() => null);
    if (!apiNode) return;
    const rfNode = toRFNode(apiNode, workspaceId, { onDelete: handleDelete, onSelect: handleSelect });
    setNodes((ns) => [...ns, rfNode]);
    setSelectedNodeId(nodeId);
    setTimeout(() => fitView({ padding: 0.15, duration: 400 }), 50);
  }, [workspaceId, setNodes, fitView, handleDelete, handleSelect]);

  // ── Batch from Arquitecta — materialize 3-6 nodes with stagger ────
  // The /architect endpoint already created the rows in DB and returned
  // them with full content; we just hydrate ReactFlow nodes and animate
  // their entrance by inserting them with a small per-index delay.
  const handleNodesGenerated = useCallback(async (apiNodes: WorkspaceNode[]) => {
    for (let i = 0; i < apiNodes.length; i++) {
      const n = apiNodes[i];
      const rfNode = toRFNode(n, workspaceId, { onDelete: handleDelete, onSelect: handleSelect });
      // Stagger: 120ms between each → ~720ms for 6 hojas. Feels composed.
      setTimeout(() => {
        setNodes((ns) => [...ns, rfNode]);
      }, i * 120);
    }
    // Fit view after the last node lands
    setTimeout(() => fitView({ padding: 0.18, duration: 600 }), apiNodes.length * 120 + 100);
  }, [workspaceId, setNodes, fitView, handleDelete, handleSelect]);

  // ── Title edit ────────────────────────────────────────────────────
  const commitTitle = () => {
    if (draftTitle.trim() && draftTitle !== title) {
      onTitleChange(draftTitle.trim());
    }
    setEditingTitle(false);
  };

  // Bridge the selection menu's "Hoja nueva con esto" button to our
  // existing createNode helper. Spawns a new hoja whose body is the
  // selected text, positioned at the next free grid slot.
  const handleCreateHojaFromSelection = useCallback(async (text: string) => {
    const pos = gridPosition(nodes.length);
    const node = await createNode(workspaceId, {
      type: 'hoja',
      title: text.slice(0, 60) + (text.length > 60 ? '…' : ''),
      content: { md: text },
      x: pos.x, y: pos.y,
      width: NODE_W, height: NODE_H,
    }).catch(() => null);
    if (!node) return;
    const rfNode = toRFNode(node, workspaceId, { onDelete: handleDelete, onSelect: handleSelect });
    setNodes((ns) => [...ns, rfNode]);
    setTimeout(() => fitView({ padding: 0.15, duration: 400 }), 50);
  }, [workspaceId, nodes.length, setNodes, fitView, handleDelete, handleSelect]);

  return (
    <div className="flex h-full">
      {/* Single consolidated docx-style toolbar — format buttons +
          Lexa AI actions in one row. Replaces the old two-menu layout
          (HojaSelectionMenu above + HojaFormatMenu below) which fought
          each other on outside-click handlers. */}
      <HojaFormatMenu
        workspaceId={workspaceId}
        onCreateHojaFromSelection={handleCreateHojaFromSelection}
      />

      {/* ── Chat Panel (AnimatedAiInput, workspace scope) ──────── */}
      {/* Width controlled by chatWidth state; resizable via the
          splitter handle to the right. min = 340 (default), max =
          golden-ratio wider (≈550px). */}
      <div
        className="shrink-0 h-full border-r border-black/8 dark:border-white/6 overflow-hidden flex flex-col"
        style={{ width: chatWidth }}
      >
        {/* Header — per-workspace chat controls. "Nuevo chat" spawns a
            fresh thread (the prior one stays accessible from history).
            "Historial" toggles a drawer of THIS workspace's past chats. */}
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-black/6 dark:border-white/6 shrink-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-cl2-burgundy/70 dark:text-cl2-burgundy/80">
              Lexa · {title.slice(0, 22)}{title.length > 22 ? '…' : ''}
            </span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => setChatHistoryOpen(true)}
              className="h-7 w-7 flex items-center justify-center rounded-md text-[#0e1745]/55 dark:text-white/55 hover:bg-black/5 dark:hover:bg-white/8 hover:text-[#0e1745] dark:hover:text-white transition-colors"
              title="Historial de chats en este workspace"
              aria-label="Historial de chats"
            >
              <History className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => startNewWorkspaceSession(workspaceId, title)}
              className="h-7 px-2 flex items-center gap-1 rounded-md text-[11px] font-semibold text-white bg-cl2-burgundy hover:bg-cl2-burgundy/90 transition-colors"
              title="Nuevo chat en este workspace"
              aria-label="Nuevo chat"
            >
              <Plus className="w-3 h-3" />
              Nuevo
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0">
        <AnimatedAiInput
          scope={{
            kind: 'workspace',
            workspace_id: workspaceId,
            workspace_title: title,
            selected_node_id: selectedNodeId,
          }}
          hojaTitles={nodes.map((n) => ({
            id: n.id,
            title: (n.data?.title as string) ?? '',
            subtitle: (n.data?.subtitle as string) ?? null,
          }))}
          onClearSelection={() => setSelectedNodeId(null)}
          onWorkspaceAction={async (action) => {
            if (action.intent === 'build' && action.nodes) {
              await handleNodesGenerated(action.nodes);
            } else if (action.node_id && action.new_content) {
              const fresh = await getNode(workspaceId, action.node_id).catch(() => null);
              if (fresh) {
                setNodes((ns) =>
                  ns.map((n) =>
                    n.id === action.node_id
                      ? toRFNode(fresh, workspaceId, {
                          onDelete: handleDelete,
                          onSelect: handleSelect,
                        })
                      : n,
                  ),
                );
                // Brief highlight — fly camera to the updated node
                setTimeout(() => fitView({ padding: 0.2, duration: 600 }), 50);
              }
            }
          }}
        />
        </div>
      </div>

      {/* ── Workspace chat-history drawer ──────────────────────── */}
      {/* Shows ONLY this workspace's chats (sidebar.tsx filters by
          currentWorkspaceId). Click any to switch threads; "+" inside
          the sidebar also creates a new workspace chat (handleNewChat
          in sidebar branches on currentWorkspaceId). */}
      <Sidebar
        open={chatHistoryOpen}
        onClose={() => setChatHistoryOpen(false)}
        variant="drawer"
        side="left"
      />

      {/* ── Splitter handle ─────────────────────────────────────── */}
      {/* 4px-wide vertical strip between chat and canvas. Captures
          pointer drag and updates chatWidth in real time, clamped to
          [CHAT_MIN, CHAT_MAX]. The 8px hover region (via padding +
          inset bg) makes the handle easier to grab without taking
          extra horizontal space. */}
      <ChatSplitter
        min={CHAT_MIN}
        max={CHAT_MAX}
        width={chatWidth}
        onChange={setChatWidth}
      />

      {/* ── Canvas ─────────────────────────────────────────────── */}
      <div className="flex-1 relative h-full">
        {loading && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-gray-50/80 dark:bg-mesh/80 backdrop-blur-sm">
            <div className="h-10 w-10 rounded-full border-2 border-cl2-accent/20 border-t-cl2-accent animate-spin" />
          </div>
        )}

        <ReactFlow
          nodes={nodes}
          edges={[]}
          onNodesChange={handleNodesChange}
          nodeTypes={NODE_TYPES}
          onPaneClick={() => setSelectedNodeId(null)}
          onNodeClick={(_, node) => handleSelect(node.id)}
          // @ts-expect-error — onPaneDoubleClick is supported at runtime
          // by xyflow but missing from this version's prop types.
          onPaneDoubleClick={handlePaneDoubleClick}
          // Right-click is handled at document level via a capture-
          // phase listener (see useEffect above). The xyflow props
          // weren't firing reliably on this build, so we bypass them.
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.15}
          maxZoom={2}
          panOnScroll
          selectionOnDrag
          className="bg-gray-50 dark:bg-[#111] [&_.react-flow__background]:opacity-40"
        >
          {/* Dot grid background — CL2 style */}
          <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} color="rgba(14,23,69,0.12)" className="dark:[color:rgba(255,255,255,0.06)]" />

          {/* Mini-map */}
          <MiniMap
            nodeColor={() => 'rgba(249,53,73,0.2)'}
            maskColor="rgba(14,23,69,0.04)"
            className="!border-black/8 dark:!border-white/8 !rounded-xl !shadow-lg !bg-white dark:!bg-[#1c1c1c]"
          />

          {/* Controls */}
          <Controls showInteractive={false} className="!border-black/8 dark:!border-white/8 !rounded-xl !shadow-sm !bg-white dark:!bg-[#1c1c1c] [&>button]:!border-none [&>button]:!text-[#0e1745] dark:[&>button]:!text-white" />

          {/* Top toolbar panel */}
          <Panel position="top-left" className="m-3">
            <div className="flex items-center gap-2">
              {/* Back */}
              <button
                onClick={() => navigate('/hojas')}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white dark:bg-[#1c1c1c] border border-black/8 dark:border-white/8 shadow-sm text-[13px] font-medium text-[#0e1745]/70 dark:text-white/70 hover:text-[#0e1745] dark:hover:text-white transition-colors"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>

              {/* Workspace title */}
              {editingTitle ? (
                <input
                  autoFocus
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  onBlur={commitTitle}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitTitle(); if (e.key === 'Escape') setEditingTitle(false); }}
                  className="px-3 py-2 rounded-xl bg-white dark:bg-[#1c1c1c] border border-cl2-accent/40 shadow-sm font-display text-[15px] font-semibold text-[#0e1745] dark:text-white focus:outline-none w-48"
                />
              ) : (
                <button
                  onClick={() => { setEditingTitle(true); setDraftTitle(title); }}
                  className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white dark:bg-[#1c1c1c] border border-black/8 dark:border-white/8 shadow-sm"
                >
                  <Layers className="w-4 h-4 text-cl2-burgundy" />
                  <span className="font-display text-[15px] font-semibold text-[#0e1745] dark:text-white max-w-[160px] truncate">{title}</span>
                </button>
              )}
            </div>
          </Panel>

          {/* Toolbar — Audio del board strip / Audio del board btn /
              Voz / Nueva hoja */}
          <Panel position="top-right" className="m-3">
            <div className="flex items-center gap-2 max-w-[min(70vw,560px)]">
              {/* Audio strip (renders only when a podcast exists for this board) */}
              <div key={stripBump} className="flex-1 min-w-0">
                <BoardAudioStrip
                  workspaceId={workspaceId}
                  workspaceUpdatedAt={workspaceUpdatedAt}
                  onRequestRegenerate={() => setPodcastOpen(true)}
                />
              </div>

              {/* "Audio del board" button — only visible when no strip showing */}
              <BoardAudioCTA workspaceId={workspaceId} onClick={() => setPodcastOpen(true)} />

              {/* "Presentación" — opens the options panel first so the
                  user can tell Gamma the tono / audiencia / propósito /
                  marca. Submitting the options panel kicks the actual
                  generation (which then surfaces in PptxResultModal). */}
              <button
                onClick={() => setPptxOptionsOpen(true)}
                disabled={pptxModal?.state === 'loading'}
                title="Generar presentación con Gamma"
                className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-white dark:bg-[#1c1c1c] border border-cl2-burgundy/20 dark:border-cl2-burgundy/30 shadow-sm text-[13px] font-medium text-cl2-burgundy dark:text-cl2-burgundy/90 hover:bg-cl2-burgundy/[0.04] dark:hover:bg-cl2-burgundy/[0.10] transition-colors disabled:opacity-60 disabled:cursor-wait"
              >
                <Presentation className="w-4 h-4" />
                <span className="hidden md:inline">
                  {pptxModal?.state === 'loading' ? 'Generando…' : 'Presentación'}
                </span>
              </button>

              {/* Nueva hoja (manual) — voice path moved into the
                  right-click "Pedile a Lexa" + the chat panel mic. */}
              <button
                onClick={() => handleAddHoja()}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-cl2-accent text-white text-[13px] font-semibold hover:bg-cl2-accent-hover transition-colors shadow-sm shadow-cl2-accent/25"
              >
                <Plus className="w-4 h-4" />
                <span className="hidden md:inline">Nueva hoja</span>
              </button>
            </div>
          </Panel>

          {/* Double-click hint */}
          {nodes.length === 0 && !loading && (
            <Panel position="bottom-center" className="mb-10">
              <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/80 dark:bg-[#1c1c1c]/80 backdrop-blur border border-black/8 dark:border-white/8 shadow-sm">
                <ZoomIn className="w-4 h-4 text-[#0e1745]/40 dark:text-white/40" />
                <span className="text-[12px] text-[#0e1745]/55 dark:text-white/50">
                  Doble clic para crear hoja · Click derecho para subir archivo o pedirle a Lexa
                </span>
              </div>
            </Panel>
          )}
        </ReactFlow>
      </div>

      {/* ── Hidden file input — driven by right-click "Subir archivo" ─ */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,audio/*,application/pdf,.docx,.md,.txt"
        className="hidden"
        onChange={(e) => {
          const files = e.target.files;
          void handleFilesPicked(files);
          // Reset so the same file re-selected fires onChange again.
          e.currentTarget.value = '';
        }}
      />

      {/* ── Lexa quick-hoja modal (right-click → "Pedile a Lexa") ─── */}
      <LexaQuickHojaModal
        open={lexaQuickOpen}
        onClose={() => setLexaQuickOpen(false)}
        workspaceId={workspaceId}
        anchor={
          // Modal anchor is in screen coords; we don't have that
          // anymore (pendingClickFlow is in flow coords). Falling back
          // to centered is fine — the resulting node DOES land at the
          // click position via pendingClickFlow.
          null
        }
        onResult={handleLexaQuickCommit}
      />

      {/* ── Context menu portal ───────────────────────────────────── */}
      {ctxMenu.element}

      {/* ── PPTX options modal (pre-generation form) ──────────────── */}
      <PptxOptionsModal
        open={pptxOptionsOpen}
        onClose={() => setPptxOptionsOpen(false)}
        onSubmit={(opts) => void generatePptx(opts, /*force*/ false)}
        initial={cachedPptxOptions}
        workspaceTitle={title}
      />

      {/* ── PPTX result modal (board → Gamma deck) ────────────────── */}
      {pptxModal && (
        <PptxResultModal
          open={pptxModal.open}
          onClose={() => setPptxModal(null)}
          state={pptxModal.state}
          result={pptxModal.result}
          errorMessage={pptxModal.errorMessage}
          errorCode={pptxModal.errorCode}
          workspaceTitle={title}
          onRegenerate={() => {
            // Re-open the options modal so the user can tweak before regenerating.
            setPptxModal(null);
            setPptxOptionsOpen(true);
          }}
        />
      )}

      {/* ── Podcast modal (board → audio) ───────────────────────── */}
      <PodcastModal
        open={podcastOpen}
        onClose={() => {
          setPodcastOpen(false);
          // After the modal closes, bump the strip so it picks up the
          // newly-queued or newly-ready podcast immediately.
          setStripBump((n) => n + 1);
        }}
        source_type="hoja_workspace"
        source_id={workspaceId}
        source_title={title}
      />

      {/* ── Podcast modal (single hoja node) ─────────────────────── */}
      {/* Mounted only when a node was right-clicked → "Generar
          podcast de esta hoja". Separate instance from the workspace
          one so the two flows can be open independently and don't
          contaminate each other's source params. */}
      <PodcastModal
        open={podcastNode !== null}
        onClose={() => setPodcastNode(null)}
        source_type="hoja_node"
        source_id={podcastNode?.id ?? ''}
        source_title={podcastNode?.title}
      />
    </div>
  );
}

/**
 * Vertical drag handle between the chat panel and the canvas. 4px
 * visual width but a wider invisible hit-area (8px on each side via
 * `-mx-1` + padding) so the user doesn't have to thread the needle.
 *
 * Pointer-capture pattern: on pointerdown we lock the move/up
 * listeners onto the handle element so drag continues even when the
 * cursor leaves the strip. Body cursor + user-select get globally
 * overridden during drag so the canvas doesn't text-select hojas
 * accidentally.
 */
function ChatSplitter({
  min,
  max,
  width,
  onChange,
}: {
  min: number;
  max: number;
  width: number;
  onChange: (w: number) => void;
}) {
  const draggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWRef = useRef(width);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    draggingRef.current = true;
    startXRef.current = e.clientX;
    startWRef.current = width;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [width]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const dx = e.clientX - startXRef.current;
    const next = Math.max(min, Math.min(max, startWRef.current + dx));
    onChange(next);
  }, [min, max, onChange]);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => onChange(min)}
      title="Arrastrá para ensanchar · Doble clic para restaurar"
      className="group relative h-full w-1 shrink-0 cursor-col-resize select-none touch-none"
    >
      {/* Visible 1px line + wider invisible hit area via the parent's
          w-1 box. Hover/active state highlights the line subtly so
          the handle is discoverable without being noisy. */}
      <span
        className="absolute inset-y-0 left-0 right-0 mx-auto w-px bg-[#0e1745]/[0.08] dark:bg-white/[0.08] group-hover:bg-cl2-burgundy/40 group-hover:w-[2px] transition-all"
        aria-hidden
      />
    </div>
  );
}

/**
 * Renders the "Audio del board" button only when there is NO podcast
 * yet for this workspace. Once a podcast exists, BoardAudioStrip takes
 * over the visual real estate and the strip itself owns "regenerar".
 */
function BoardAudioCTA({
  workspaceId,
  onClick,
}: {
  workspaceId: string;
  onClick: () => void;
}) {
  const [hasAny, setHasAny] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    import('@/services/podcastsApi').then(({ listPodcastsBySource }) => {
      listPodcastsBySource('hoja_workspace', workspaceId)
        .then((items) => {
          if (alive) setHasAny(items.length > 0);
        })
        .catch(() => {
          if (alive) setHasAny(false);
        });
    });
    return () => { alive = false; };
  }, [workspaceId]);
  if (hasAny !== false) return null;
  return (
    <button
      onClick={onClick}
      title="Audio del board — narrado por Lexa"
      className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-white dark:bg-[#1c1c1c] border border-cl2-burgundy/20 dark:border-cl2-accent/30 shadow-sm text-[13px] font-medium text-cl2-burgundy dark:text-cl2-accent-soft hover:bg-cl2-burgundy/[0.04] dark:hover:bg-cl2-accent/[0.08] transition-colors"
    >
      <Headphones className="w-4 h-4" />
      <span className="hidden md:inline">Audio del board</span>
    </button>
  );
}

// ─── Page wrapper (provides ReactFlow context) ────────────────────────
export function WorkspaceCanvasPage({ id }: { id: string }) {
  const [title, setTitle] = useState('Cargando…');
  // updated_at drives the BoardAudioStrip's "stale" badge — the user
  // sees a hint when the board was edited after the most recent podcast
  // finished. Bumped locally on title edits to avoid a refetch.
  const [updatedAt, setUpdatedAt] = useState<string | undefined>(undefined);

  useEffect(() => {
    // Load workspace title + updated_at.
    supabase.auth.getSession().then(({ data }) => {
      const token = data?.session?.access_token;
      if (!token) return;
      fetch(`/api/workspace?archived=1`, { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => r.json())
        .then((body: { items?: Array<{ id: string; title: string; updated_at?: string }> }) => {
          const ws = body.items?.find((w) => w.id === id);
          if (ws) {
            setTitle(ws.title);
            setUpdatedAt(ws.updated_at);
          }
        })
        .catch(() => null);
    });
  }, [id]);

  const handleTitleChange = useCallback(async (newTitle: string) => {
    setTitle(newTitle);
    setUpdatedAt(new Date().toISOString());
    await updateWorkspace(id, { title: newTitle }).catch(() => null);
  }, [id]);

  return (
    <div className="h-screen flex flex-col bg-gray-50 dark:bg-mesh overflow-hidden">
      <ReactFlowProvider>
        <CanvasInner
          workspaceId={id}
          title={title}
          onTitleChange={handleTitleChange}
          workspaceUpdatedAt={updatedAt}
        />
      </ReactFlowProvider>
    </div>
  );
}
// Sun Apr 26 21:01:31 -05 2026
