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
  ArrowLeft, Headphones, Mic, Plus, Layers, ZoomIn,
} from 'lucide-react';
import { TopDock } from '@/components/top-dock';
import { HojaNode } from '@/components/hoja/HojaNode';
import { LexaContextPanel } from '@/components/hoja/LexaContextPanel';
import { HojaSelectionMenu } from '@/components/hoja/HojaSelectionMenu';
import { VoiceCaptureModal } from '@/components/hoja/VoiceCaptureModal';
import { PodcastModal } from '@/components/podcasts/PodcastModal';
import { BoardAudioStrip } from '@/components/podcasts/BoardAudioStrip';
import { navigate } from '@/lib/router';
import { cn } from '@/lib/utils';
import {
  listNodes, createNode, updateNode, deleteNode, getNode,
  type WorkspaceNode,
} from '@/services/workspaceApi';
import { updateWorkspace } from '@/services/workspaceApi';
import { supabase } from '@/lib/supabase';

// ─── Node type registration ───────────────────────────────────────────
const NODE_TYPES = { hoja: HojaNode } as const;

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
function toRFNode(n: WorkspaceNode, workspaceId: string, callbacks: {
  onDelete: (id: string) => void;
  onSelect: (id: string) => void;
}): Node {
  return {
    id: n.id,
    type: 'hoja',
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
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNodeFull, setSelectedNodeFull] = useState<WorkspaceNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [podcastOpen, setPodcastOpen] = useState(false);
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

  // ── Load nodes from API ──────────────────────────────────────────
  useEffect(() => {
    listNodes(workspaceId)
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

  // ── Voice → new hoja ─────────────────────────────────────────────
  // VoiceCaptureModal posts a transcript; we materialize a node with
  // it as the body and the derived first-sentence title. Position uses
  // the same grid logic as handleAddHoja.
  const handleVoiceCommit = useCallback(async ({ title: voiceTitle, md }: { title: string; md: string }) => {
    const position = gridPosition(nodes.length);
    const apiNode = await createNode(workspaceId, {
      type: 'hoja',
      title: voiceTitle || 'Nota por voz',
      x: position.x, y: position.y,
      width: NODE_W, height: NODE_H,
      content: { md },
    });
    const rfNode = toRFNode(apiNode, workspaceId, { onDelete: handleDelete, onSelect: handleSelect });
    setNodes((ns) => [...ns, rfNode]);
    setSelectedNodeId(apiNode.id);
    setTimeout(() => fitView({ padding: 0.15, duration: 400 }), 50);
  }, [workspaceId, nodes.length, setNodes, fitView, handleDelete, handleSelect]);

  // ── Double-click canvas → add hoja at that position ──────────────
  const handlePaneDoubleClick = useCallback((e: React.MouseEvent) => {
    const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    handleAddHoja({ x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 });
  }, [screenToFlowPosition, handleAddHoja]);

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
      {/* Global floating selection menu — Alt+select / ⌘K shortcuts.
          Mounted once, listens to document.selectionchange globally. */}
      <HojaSelectionMenu
        workspaceId={workspaceId}
        onCreateHojaFromSelection={handleCreateHojaFromSelection}
      />

      {/* ── Lexa Panel ─────────────────────────────────────────── */}
      <div className="w-[300px] xl:w-[340px] shrink-0 h-full border-r border-black/8 dark:border-white/6 overflow-hidden">
        <LexaContextPanel
          workspaceId={workspaceId}
          selectedNode={selectedNodeFull}
          onNodeCreated={handleNodeCreated}
          onNodesGenerated={handleNodesGenerated}
          nextNodePosition={nextNodePosition}
        />
      </div>

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
          onPaneDoubleClick={handlePaneDoubleClick}
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

              {/* Voice → new hoja */}
              <button
                onClick={() => setVoiceOpen(true)}
                title="Nueva hoja por voz"
                className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-white dark:bg-[#1c1c1c] border border-black/8 dark:border-white/8 shadow-sm text-[13px] font-medium text-cl2-burgundy dark:text-[#d8a4ad] hover:bg-cl2-burgundy/[0.04] dark:hover:bg-cl2-accent/[0.08] transition-colors"
              >
                <Mic className="w-4 h-4" />
                <span className="hidden md:inline">Voz</span>
              </button>

              {/* Nueva hoja (manual) */}
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
                  Doble clic en el canvas para crear una hoja · O usá el botón "Nueva hoja"
                </span>
              </div>
            </Panel>
          )}
        </ReactFlow>
      </div>

      {/* ── Voice capture modal (new hoja by voice) ─────────────── */}
      <VoiceCaptureModal
        open={voiceOpen}
        onClose={() => setVoiceOpen(false)}
        onCommit={async (data) => {
          await handleVoiceCommit(data);
        }}
        mode="new"
      />

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
