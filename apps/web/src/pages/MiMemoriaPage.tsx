/**
 * Mi memoria — Track 0b (refined 2026-05-11)
 *
 * Página de gestión manual de la neurona personal. Diseño:
 *   - Las rutas crudas (`/memories/perfil/cargo.md`) NO se muestran al
 *     user; el prefijo `/memories/` se oculta y los path components se
 *     convierten en folders + título amigable.
 *   - El flujo normal es que la neurona se llene sola (wizard
 *     onboarding write-through + agentes durante chat post-Track A).
 *     Esta página es fallback / power-user — el copy hero lo dice.
 *
 * Backend: 5 endpoints `/api/neuron/*` (Cerebro proxy). user_id viene
 * del JWT server-side — el SPA nunca elige whose memory leer.
 */
import { useEffect, useMemo, useState, useCallback, type DragEvent } from 'react';
import {
  BookHeart, ChevronDown, ChevronRight, FilePlus, Folder,
  FolderOpen, FolderPlus, History, MoveRight, Save, Trash2, X, AlertCircle,
} from 'lucide-react';
import {
  listMyMemory,
  readMyMemoryFile,
  writeMyMemoryFile,
  deleteMyMemoryFile,
  getMyMemoryHistory,
  type NeuronFileMeta,
  type NeuronHistoryEntry,
} from '@/services/neuronApi';

// ─── Helpers ────────────────────────────────────────────────────────

function bytesToKb(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

function relativeTime(iso: string): string {
  try {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const min = Math.floor(diff / 60_000);
    if (min < 1) return 'hace un instante';
    if (min < 60) return `hace ${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `hace ${h} h`;
    const days = Math.floor(h / 24);
    if (days < 30) return `hace ${days} d`;
    return d.toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}

const MEMORIES_PREFIX = '/memories/';

/** Convierte un slug de path (ej. "cargo", "punto-medio") a título
 *  amigable Title Case con espacios y acentos básicos preservados. */
function slugToTitle(slug: string): string {
  const cleaned = slug.replace(/\.(md|txt|json)$/i, '').replace(/-/g, ' ').replace(/_/g, ' ');
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/** Quita /memories/ del display path. Para mostrar al user. */
function displayPath(raw: string): string {
  return raw.startsWith(MEMORIES_PREFIX) ? raw.slice(MEMORIES_PREFIX.length) : raw;
}

/** Etiqueta para el último segmento de un path (el "nombre del archivo"). */
function fileLabel(raw: string): string {
  const tail = raw.split('/').pop() ?? raw;
  return slugToTitle(tail);
}

/** Agrupa los archivos por su carpeta inmediata bajo /memories/.
 *
 * Ejemplos:
 *   /memories/bienvenida.md            → grupo "" (root)
 *   /memories/perfil/cargo.md          → grupo "perfil"
 *   /memories/perfil/temas.md          → grupo "perfil"
 *   /memories/clientes/acme/notes.md   → grupo "clientes" (deja "acme/notes" como subpath)
 *
 * Conservamos la lista plana al final con su grupo asignado — el
 * tree-rendering completo (subfolders profundas) es overkill para v1;
 * los users no anidan más de 2 niveles realistamente. */
interface GroupedFile {
  meta: NeuronFileMeta;
  group: string; // "" para root, sino "perfil", "clientes", etc.
  shortName: string; // último segmento sin extensión
}
function groupFiles(files: NeuronFileMeta[]): Map<string, GroupedFile[]> {
  const groups = new Map<string, GroupedFile[]>();
  for (const f of files) {
    const rel = displayPath(f.path); // sin /memories/
    const segments = rel.split('/').filter(Boolean);
    const group = segments.length > 1 ? segments[0] : '';
    const shortName = segments[segments.length - 1] ?? rel;
    const entry: GroupedFile = { meta: f, group, shortName };
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(entry);
  }
  // Sort entries within each group by updated_at desc
  for (const arr of groups.values()) {
    arr.sort((a, b) => b.meta.updated_at.localeCompare(a.meta.updated_at));
  }
  return groups;
}

/** Orden visual de grupos: root files primero, después orden alfabético. */
function sortedGroupKeys(groups: Map<string, GroupedFile[]>): string[] {
  const keys = Array.from(groups.keys());
  keys.sort((a, b) => {
    if (a === '' && b !== '') return -1;
    if (b === '' && a !== '') return 1;
    return a.localeCompare(b);
  });
  return keys;
}

interface OpenFile {
  path: string;
  content: string;
  dirty: boolean;
  saving: boolean;
  error: string | null;
}

// ─── Path slugifier ──────────────────────────────────────────────────
// Mismo helper para create + move + DnD. Cada segmento del path se
// slugifica por separado preservando el separador "/". Acentos se
// pierden a su equivalente ASCII (no usamos UTF-8 raw en filesystem-
// style paths para evitar surpresas con URL encoding upstream).
function slugifySegment(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[áàä]/g, 'a').replace(/[éèë]/g, 'e').replace(/[íìï]/g, 'i')
    .replace(/[óòö]/g, 'o').replace(/[úùü]/g, 'u').replace(/ñ/g, 'n')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function buildPath(folder: string, title: string): string {
  const folderSlug = folder.trim() ? slugifySegment(folder) : '';
  const titleSlug = slugifySegment(title) || 'nota';
  return folderSlug ? `/memories/${folderSlug}/${titleSlug}.md` : `/memories/${titleSlug}.md`;
}

// ─── PathPickerModal ─────────────────────────────────────────────────
// Modal reusable para CREATE y MOVE. Dropdown con carpetas existentes,
// opción "Sin carpeta" (root), y opción "Nueva carpeta…" que expande un
// input inline. El campo "Título" es siempre visible (para CREATE) o
// pre-fillado y opcional-de-cambiar (para MOVE).
interface PathPickerProps {
  open: boolean;
  mode: 'create' | 'move';
  initialFolder?: string; // grupo actual (vacío = root)
  initialTitle?: string;
  existingFolders: string[];
  onCancel: () => void;
  onConfirm: (folder: string, title: string) => void;
}

function PathPickerModal({
  open, mode, initialFolder = '', initialTitle = '',
  existingFolders, onCancel, onConfirm,
}: PathPickerProps) {
  // Estado del select: nombre del folder, '' para root, '__new__' para crear
  const NEW_FOLDER_SENTINEL = '__new__';
  const initialSelect = initialFolder && existingFolders.includes(initialFolder)
    ? initialFolder
    : (initialFolder ? NEW_FOLDER_SENTINEL : '');
  const [folderSelect, setFolderSelect] = useState(initialSelect);
  const [newFolderName, setNewFolderName] = useState(
    initialFolder && !existingFolders.includes(initialFolder) ? initialFolder : '',
  );
  const [title, setTitle] = useState(initialTitle);

  // Re-sync when modal opens with different initial values
  useEffect(() => {
    if (open) {
      const sel = initialFolder && existingFolders.includes(initialFolder)
        ? initialFolder
        : (initialFolder ? NEW_FOLDER_SENTINEL : '');
      setFolderSelect(sel);
      setNewFolderName(initialFolder && !existingFolders.includes(initialFolder) ? initialFolder : '');
      setTitle(initialTitle);
    }
  }, [open, initialFolder, initialTitle, existingFolders]);

  if (!open) return null;

  const resolvedFolder = folderSelect === NEW_FOLDER_SENTINEL
    ? newFolderName.trim()
    : folderSelect;
  const canSubmit = (mode === 'create' ? title.trim().length > 0 : true)
    && (folderSelect !== NEW_FOLDER_SENTINEL || newFolderName.trim().length > 0);

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-6">
      <div className="bg-cl2-bg border border-white/10 rounded-md w-full max-w-md overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/5">
          <h3 className="font-display text-lg">
            {mode === 'create' ? 'Nueva nota' : 'Mover a otra carpeta'}
          </h3>
          <button onClick={onCancel} className="text-cl2-ink/60 hover:text-cl2-ink">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-5 py-4 space-y-4">
          {mode === 'create' && (
            <div>
              <label className="block text-[11px] uppercase tracking-wider text-cl2-ink/50 mb-1.5">
                Título de la nota
              </label>
              <input
                type="text"
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="ej: notas reunión con Acme"
                className="w-full px-3 py-2 bg-white/[0.03] border border-white/10 rounded-md text-[13px] text-cl2-ink focus:outline-none focus:border-cl2-burgundy/50 focus:bg-white/[0.05]"
              />
            </div>
          )}
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-cl2-ink/50 mb-1.5">
              Carpeta
            </label>
            <select
              value={folderSelect}
              onChange={(e) => setFolderSelect(e.target.value)}
              className="w-full px-3 py-2 bg-white/[0.03] border border-white/10 rounded-md text-[13px] text-cl2-ink focus:outline-none focus:border-cl2-burgundy/50"
            >
              <option value="">Sin carpeta (raíz)</option>
              {existingFolders.map((f) => (
                <option key={f} value={f}>{slugToTitle(f)}</option>
              ))}
              <option value={NEW_FOLDER_SENTINEL}>+ Nueva carpeta…</option>
            </select>
            {folderSelect === NEW_FOLDER_SENTINEL && (
              <input
                type="text"
                autoFocus
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder="ej: clientes, proyectos, ideas"
                className="mt-2 w-full px-3 py-2 bg-white/[0.03] border border-white/10 rounded-md text-[13px] text-cl2-ink focus:outline-none focus:border-cl2-burgundy/50"
              />
            )}
          </div>
          <div className="text-[11px] text-cl2-ink/40 italic">
            Preview: {resolvedFolder ? `${slugToTitle(resolvedFolder)} / ` : ''}
            {slugToTitle(title || (mode === 'move' ? initialTitle : 'nueva nota'))}
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-white/5 bg-white/[0.01]">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-[12px] rounded-md text-cl2-ink/70 hover:text-cl2-ink hover:bg-white/5 transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={() => canSubmit && onConfirm(resolvedFolder, title || initialTitle)}
            disabled={!canSubmit}
            className="px-4 py-1.5 text-[12px] rounded-md bg-cl2-burgundy text-white disabled:opacity-40 hover:bg-cl2-burgundy/90 transition-colors"
          >
            {mode === 'create' ? 'Crear' : 'Mover'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function MiMemoriaPage() {
  const [files, setFiles] = useState<NeuronFileMeta[] | null>(null);
  const [totalBytes, setTotalBytes] = useState(0);
  const [quotaBytes, setQuotaBytes] = useState(512_000);
  const [quotaFiles, setQuotaFiles] = useState(50);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState<OpenFile | null>(null);
  const [history, setHistory] = useState<NeuronHistoryEntry[] | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await listMyMemory();
      setFiles(data.files);
      setTotalBytes(data.total_bytes);
      if (data.quota_bytes) setQuotaBytes(data.quota_bytes);
      if (data.quota_files) setQuotaFiles(data.quota_files);
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
      setFiles([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openFile = useCallback(async (path: string) => {
    try {
      const f = await readMyMemoryFile(path);
      setOpen({ path: f.path, content: f.content, dirty: false, saving: false, error: null });
    } catch (err) {
      setOpen({ path, content: '', dirty: false, saving: false, error: (err as Error).message });
    }
  }, []);

  const saveOpenFile = useCallback(async () => {
    if (!open) return;
    setOpen({ ...open, saving: true, error: null });
    try {
      await writeMyMemoryFile(open.path, open.content);
      setOpen({ ...open, saving: false, dirty: false, error: null });
      await refresh();
    } catch (err) {
      setOpen({ ...open, saving: false, error: (err as Error).message });
    }
  }, [open, refresh]);

  const deleteOpenFile = useCallback(async () => {
    if (!open) return;
    const friendly = fileLabel(open.path);
    if (!window.confirm(`¿Borrar "${friendly}"? Esta acción no se puede deshacer.`)) return;
    try {
      await deleteMyMemoryFile(open.path);
      setOpen(null);
      await refresh();
    } catch (err) {
      setOpen({ ...open, error: (err as Error).message });
    }
  }, [open, refresh]);

  // Picker modal state — declarado acá para que los callbacks lo capturen.
  const [pickerMode, setPickerMode] = useState<'create' | 'move' | null>(null);
  const [pickerInitialFolder, setPickerInitialFolder] = useState('');
  const [pickerInitialTitle, setPickerInitialTitle] = useState('');

  // Drag & drop state — el path del file en arrastre + folder bajo cursor.
  const [draggingPath, setDraggingPath] = useState<string | null>(null);
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);

  const openCreatePicker = useCallback(() => {
    setPickerInitialFolder('');
    setPickerInitialTitle('');
    setPickerMode('create');
  }, []);

  const openMovePicker = useCallback(() => {
    if (!open) return;
    const rel = displayPath(open.path);
    const segs = rel.split('/').filter(Boolean);
    const folder = segs.length > 1 ? segs[0] : '';
    const titleSlug = segs[segs.length - 1] ?? '';
    setPickerInitialFolder(folder);
    setPickerInitialTitle(slugToTitle(titleSlug));
    setPickerMode('move');
  }, [open]);

  const handlePickerConfirm = useCallback(
    async (folder: string, title: string) => {
      if (pickerMode === 'create') {
        const path = buildPath(folder, title);
        setPickerMode(null);
        setOpen({
          path,
          content: `# ${title.trim() || 'Nueva nota'}\n\n`,
          dirty: true,
          saving: false,
          error: null,
        });
        return;
      }
      if (pickerMode === 'move' && open) {
        const newPath = buildPath(folder, title);
        if (newPath === open.path) {
          setPickerMode(null);
          return;
        }
        setOpen({ ...open, saving: true, error: null });
        try {
          // Write to new path first; if that fails, original stays intact.
          await writeMyMemoryFile(newPath, open.content);
          // Then delete the old path. If this fails we'll have a duplicate
          // — surface it so the user knows to clean up manually rather
          // than silently lose data.
          await deleteMyMemoryFile(open.path);
          setOpen({ path: newPath, content: open.content, dirty: false, saving: false, error: null });
          setPickerMode(null);
          await refresh();
        } catch (err) {
          setOpen({ ...open, saving: false, error: `No pude mover: ${(err as Error).message}` });
        }
      }
    },
    [pickerMode, open, refresh],
  );

  // ─── Drag & drop ────────────────────────────────────────────────
  // El user arrastra una card de archivo y la suelta sobre un folder
  // header (o sobre la zona "root"). Hace el mismo write+delete que la
  // ruta del modal. Si el archivo no está abierto, se fetchea content
  // al momento del drop. Si ya está abierto, usamos el content en
  // memoria (incluye edits pendientes — si los hay, guardamos primero).
  const handleDragStart = useCallback((e: DragEvent<HTMLLIElement>, path: string) => {
    setDraggingPath(path);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/cl2-neuron-path', path);
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggingPath(null);
    setDragOverFolder(null);
  }, []);

  const handleDropOnFolder = useCallback(
    async (targetFolder: string) => {
      const sourcePath = draggingPath;
      setDraggingPath(null);
      setDragOverFolder(null);
      if (!sourcePath) return;
      // ¿Ya está en esa carpeta? No-op.
      const rel = displayPath(sourcePath);
      const segs = rel.split('/').filter(Boolean);
      const currentFolder = segs.length > 1 ? segs[0] : '';
      if (currentFolder === targetFolder) return;

      // Resolve content: si el file está abierto en el editor usamos lo
      // que tenemos (no perdemos los edits pendientes). Si no, fetcheamos.
      let content = '';
      if (open?.path === sourcePath) {
        content = open.content;
      } else {
        try {
          const fc = await readMyMemoryFile(sourcePath);
          content = fc.content;
        } catch {
          // Silent fail — el user puede reintentar via el modal.
          return;
        }
      }

      // El "título" para el path se preserva: tomamos el último segmento
      // como slug y lo dejamos tal cual.
      const titleSlug = segs[segs.length - 1] ?? 'nota';
      const newPath = targetFolder
        ? `/memories/${targetFolder}/${titleSlug}.md`
        : `/memories/${titleSlug}.md`;
      if (newPath === sourcePath) return;

      try {
        await writeMyMemoryFile(newPath, content);
        await deleteMyMemoryFile(sourcePath);
        if (open?.path === sourcePath) {
          setOpen({ ...open, path: newPath, dirty: false });
        }
        await refresh();
      } catch {
        // Refresh igual para mostrar estado real
        await refresh();
      }
    },
    [draggingPath, open, refresh],
  );

  const openHistory = useCallback(async () => {
    setHistoryOpen(true);
    try {
      const items = await getMyMemoryHistory(30);
      setHistory(items);
    } catch (err) {
      setHistory([]);
      // Silencio: si el endpoint todavía no está poblado, mostrar empty state
      void err;
    }
  }, []);

  const totalFiles = files?.length ?? 0;
  const quotaUsedPct = useMemo(() => Math.min(100, Math.round((totalBytes / quotaBytes) * 100)), [totalBytes, quotaBytes]);
  const grouped = useMemo(() => groupFiles(files ?? []), [files]);
  const groupKeys = useMemo(() => sortedGroupKeys(grouped), [grouped]);
  const existingFolders = useMemo(
    () => groupKeys.filter((k) => k !== ''),
    [groupKeys],
  );
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = useCallback((g: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  }, []);

  return (
    <div className="min-h-screen bg-cl2-bg text-cl2-ink">
      {/* HERO */}
      <header className="border-b border-white/5 bg-gradient-to-b from-cl2-burgundy/5 to-transparent">
        <div className="mx-auto max-w-6xl px-6 py-12">
          <div className="flex items-center gap-3 text-xs uppercase tracking-[0.16em] text-cl2-burgundy/80 mb-3">
            <BookHeart className="w-3.5 h-3.5" />
            <span>Tu memoria en CL2</span>
          </div>
          <h1 className="font-display text-4xl md:text-5xl leading-[1.05] tracking-tight">
            Lo que <em className="text-cl2-burgundy">CL2</em> sabe sobre vos
          </h1>
          <p className="mt-4 max-w-2xl text-cl2-ink/70 text-[15px] leading-relaxed">
            Tu memoria personal la van armando los agentes con cada
            conversación. Esta vista es para casos excepcionales —
            revisar qué saben, ajustar algo puntual, borrar. El flujo
            normal es que la mantengan ellos.
          </p>
        </div>
      </header>

      {/* KPI strip */}
      <div className="border-b border-white/5 bg-cl2-bg/80 backdrop-blur">
        <div className="mx-auto max-w-6xl px-6 py-4 flex flex-wrap gap-8 text-sm">
          <div>
            <div className="text-cl2-ink/50 text-[11px] uppercase tracking-wider">Archivos</div>
            <div className="font-display text-2xl mt-0.5">
              {totalFiles}
              <span className="text-cl2-ink/40 text-base ml-1">/ {quotaFiles}</span>
            </div>
          </div>
          <div>
            <div className="text-cl2-ink/50 text-[11px] uppercase tracking-wider">Uso</div>
            <div className="font-display text-2xl mt-0.5">
              {bytesToKb(totalBytes)}
              <span className="text-cl2-ink/40 text-base ml-1">/ {bytesToKb(quotaBytes)}</span>
            </div>
            <div className="mt-1.5 h-1 w-32 bg-white/5 rounded-full overflow-hidden">
              <div
                className="h-full bg-cl2-burgundy/80 transition-all"
                style={{ width: `${quotaUsedPct}%` }}
              />
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={openHistory}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded-md text-cl2-ink/70 hover:text-cl2-ink hover:bg-white/5 transition-colors"
            >
              <History className="w-3.5 h-3.5" />
              Historial
            </button>
            <button
              onClick={openCreatePicker}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded-md bg-cl2-burgundy text-white hover:bg-cl2-burgundy/90 transition-colors"
            >
              <FilePlus className="w-3.5 h-3.5" />
              Nueva nota
            </button>
          </div>
        </div>
      </div>

      {/* Body */}
      <main className="mx-auto max-w-6xl px-6 py-8 grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-6">
        {/* List — grouped by folder, no /memories/ prefix shown */}
        <aside>
          <h2 className="text-[11px] uppercase tracking-wider text-cl2-ink/50 mb-3">Tu memoria</h2>
          {loadError && (
            <div className="text-sm text-cl2-burgundy/90 bg-cl2-burgundy/8 border border-cl2-burgundy/20 rounded-md p-3 mb-3 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>No pude cargar tu memoria: {loadError}</span>
            </div>
          )}
          {files && files.length === 0 && !loadError && (
            <div className="text-sm text-cl2-ink/50 italic leading-relaxed">
              Tu memoria está vacía. Si todavía no completaste el wizard
              de bienvenida, los agentes la van a empezar a poblar ahí.
              También podés crear una nota a mano con el botón "Nueva
              nota" si querés agregar algo puntual.
            </div>
          )}
          <div className="space-y-3">
            {groupKeys.map((g) => {
              const items = grouped.get(g) ?? [];
              const isRoot = g === '';
              const collapsed = collapsedGroups.has(g);
              if (isRoot) {
                // Root files: render flat. La zona "root" también es
                // drop target — soltar un file acá lo saca de su folder.
                const dragOverRoot = dragOverFolder === '';
                return (
                  <ul
                    key="__root"
                    className={`space-y-1.5 rounded-md transition-colors ${
                      dragOverRoot ? 'bg-cl2-burgundy/8 ring-1 ring-cl2-burgundy/30' : ''
                    }`}
                    onDragOver={(e) => {
                      if (draggingPath) {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'move';
                        setDragOverFolder('');
                      }
                    }}
                    onDragLeave={() => setDragOverFolder(null)}
                    onDrop={(e) => {
                      e.preventDefault();
                      void handleDropOnFolder('');
                    }}
                  >
                    {items.map((entry) => {
                      const isOpen = open?.path === entry.meta.path;
                      const isDragging = draggingPath === entry.meta.path;
                      return (
                        <li
                          key={entry.meta.path}
                          draggable
                          onDragStart={(e) => handleDragStart(e, entry.meta.path)}
                          onDragEnd={handleDragEnd}
                          className={isDragging ? 'opacity-40' : ''}
                        >
                          <button
                            onClick={() => openFile(entry.meta.path)}
                            className={`w-full text-left rounded-md px-3 py-2 transition-colors cursor-grab active:cursor-grabbing ${
                              isOpen ? 'bg-cl2-burgundy/10 ring-1 ring-cl2-burgundy/30' : 'hover:bg-white/5'
                            }`}
                          >
                            <div className="text-[13px] text-cl2-ink/90 truncate">
                              {slugToTitle(entry.shortName)}
                            </div>
                            <div className="mt-0.5 text-[11px] text-cl2-ink/50">
                              {bytesToKb(entry.meta.size_bytes)} · {relativeTime(entry.meta.updated_at)}
                            </div>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                );
              }
              const isOver = dragOverFolder === g;
              return (
                <div
                  key={g}
                  className={`border rounded-md overflow-hidden transition-colors ${
                    isOver ? 'border-cl2-burgundy/50 bg-cl2-burgundy/8' : 'border-white/5'
                  }`}
                  onDragOver={(e) => {
                    if (draggingPath) {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      setDragOverFolder(g);
                    }
                  }}
                  onDragLeave={(e) => {
                    // Solo limpiamos si salimos del contenedor entero
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                      setDragOverFolder(null);
                    }
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    void handleDropOnFolder(g);
                  }}
                >
                  <button
                    onClick={() => toggleGroup(g)}
                    className="w-full px-3 py-2 flex items-center gap-2 text-[12px] uppercase tracking-wider text-cl2-ink/60 hover:bg-white/5 transition-colors"
                  >
                    {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    {collapsed ? <Folder className="w-3.5 h-3.5" /> : <FolderOpen className="w-3.5 h-3.5" />}
                    <span className="font-medium normal-case text-[13px] text-cl2-ink/85">
                      {slugToTitle(g)}
                    </span>
                    <span className="ml-auto text-[11px] text-cl2-ink/45 normal-case">
                      {items.length}
                    </span>
                  </button>
                  {!collapsed && (
                    <ul className="border-t border-white/5 divide-y divide-white/5">
                      {items.map((entry) => {
                        const isOpen = open?.path === entry.meta.path;
                        const isDragging = draggingPath === entry.meta.path;
                        return (
                          <li
                            key={entry.meta.path}
                            draggable
                            onDragStart={(e) => handleDragStart(e, entry.meta.path)}
                            onDragEnd={handleDragEnd}
                            className={isDragging ? 'opacity-40' : ''}
                          >
                            <button
                              onClick={() => openFile(entry.meta.path)}
                              className={`w-full text-left px-3 py-2 pl-9 transition-colors cursor-grab active:cursor-grabbing ${
                                isOpen ? 'bg-cl2-burgundy/10' : 'hover:bg-white/[0.03]'
                              }`}
                            >
                              <div className="text-[13px] text-cl2-ink/90 truncate">
                                {slugToTitle(entry.shortName)}
                              </div>
                              <div className="mt-0.5 text-[11px] text-cl2-ink/50">
                                {bytesToKb(entry.meta.size_bytes)} · {relativeTime(entry.meta.updated_at)}
                              </div>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}

            {/* "Nueva carpeta" CTA al final de la lista — atajo visual para
                users que entendieron la metáfora. Abre el mismo picker;
                el user elige "Nueva carpeta…" desde el dropdown ahí. */}
            {existingFolders.length > 0 && (
              <button
                onClick={openCreatePicker}
                className="w-full mt-2 px-3 py-2 flex items-center gap-2 text-[12px] text-cl2-ink/50 hover:text-cl2-ink/80 hover:bg-white/[0.03] rounded-md transition-colors"
              >
                <FolderPlus className="w-3.5 h-3.5" />
                Nueva nota en carpeta nueva…
              </button>
            )}
          </div>
        </aside>

        {/* Editor */}
        <section>
          {!open ? (
            <div className="h-full min-h-[400px] rounded-md border border-dashed border-white/10 flex items-center justify-center text-cl2-ink/40 text-sm">
              Seleccioná un archivo para verlo o editarlo.
            </div>
          ) : (
            <div className="rounded-md bg-white/[0.02] border border-white/5 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
                <div className="flex items-center gap-2 min-w-0">
                  {(() => {
                    const rel = displayPath(open.path);
                    const segs = rel.split('/').filter(Boolean);
                    if (segs.length <= 1) {
                      return (
                        <span className="text-[14px] font-medium text-cl2-ink/90 truncate">
                          {slugToTitle(segs[0] ?? rel)}
                        </span>
                      );
                    }
                    const last = segs.pop()!;
                    return (
                      <>
                        <span className="text-[11px] text-cl2-ink/50 truncate">
                          {segs.map(slugToTitle).join(' · ')}
                        </span>
                        <span className="text-cl2-ink/30">/</span>
                        <span className="text-[14px] font-medium text-cl2-ink/90 truncate">
                          {slugToTitle(last)}
                        </span>
                      </>
                    );
                  })()}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={saveOpenFile}
                    disabled={open.saving || !open.dirty}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded-md bg-cl2-burgundy text-white disabled:opacity-40 hover:bg-cl2-burgundy/90 transition-colors"
                  >
                    <Save className="w-3.5 h-3.5" />
                    {open.saving ? 'Guardando…' : open.dirty ? 'Guardar' : 'Guardado'}
                  </button>
                  <button
                    onClick={openMovePicker}
                    title="Mover a otra carpeta"
                    className="inline-flex items-center gap-1.5 px-2 py-1.5 text-[12px] rounded-md text-cl2-ink/60 hover:text-cl2-ink hover:bg-white/5 transition-colors"
                  >
                    <MoveRight className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={deleteOpenFile}
                    title="Borrar archivo"
                    className="inline-flex items-center gap-1.5 px-2 py-1.5 text-[12px] rounded-md text-cl2-ink/60 hover:text-cl2-burgundy hover:bg-cl2-burgundy/8 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => setOpen(null)}
                    title="Cerrar"
                    className="inline-flex items-center gap-1.5 px-2 py-1.5 text-[12px] rounded-md text-cl2-ink/60 hover:text-cl2-ink hover:bg-white/5 transition-colors"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              {open.error && (
                <div className="px-4 py-2 text-[12px] text-cl2-burgundy/90 bg-cl2-burgundy/8 border-b border-cl2-burgundy/20">
                  {open.error}
                </div>
              )}
              <textarea
                value={open.content}
                onChange={(e) => setOpen({ ...open, content: e.target.value, dirty: true })}
                className="w-full min-h-[420px] bg-transparent text-[13px] leading-relaxed text-cl2-ink/90 font-mono px-4 py-4 focus:outline-none resize-y"
                spellCheck={false}
              />
              <div className="px-4 py-2 text-[11px] text-cl2-ink/40 border-t border-white/5 flex items-center justify-between">
                <span>{bytesToKb(new TextEncoder().encode(open.content).length)} · markdown</span>
                <span>Cmd/Ctrl + S guarda</span>
              </div>
            </div>
          )}
        </section>
      </main>

      {/* PathPicker modal — usado para crear note y para mover */}
      <PathPickerModal
        open={pickerMode !== null}
        mode={pickerMode ?? 'create'}
        initialFolder={pickerInitialFolder}
        initialTitle={pickerInitialTitle}
        existingFolders={existingFolders}
        onCancel={() => setPickerMode(null)}
        onConfirm={handlePickerConfirm}
      />

      {/* History modal */}
      {historyOpen && (
        <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-center justify-center p-6">
          <div className="bg-cl2-bg border border-white/10 rounded-md w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-5 py-3 border-b border-white/5">
              <h3 className="font-display text-lg">Historial de cambios</h3>
              <button onClick={() => setHistoryOpen(false)} className="text-cl2-ink/60 hover:text-cl2-ink">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-3">
              {history === null && <div className="text-sm text-cl2-ink/50 italic">Cargando…</div>}
              {history && history.length === 0 && (
                <div className="text-sm text-cl2-ink/50 italic">
                  Sin historial todavía. Los cambios futuros aparecen acá con quién los hizo.
                </div>
              )}
              {history && history.length > 0 && (
                <ul className="space-y-3">
                  {history.map((h, i) => (
                    <li key={`${h.created_at}-${i}`} className="text-[13px] border-b border-white/5 pb-3 last:border-b-0">
                      <div className="flex items-center gap-2 text-cl2-ink/60 text-[11px]">
                        <span className="font-mono">{h.command}</span>
                        {h.agent_id && (
                          <span className="px-1.5 py-0.5 rounded bg-white/5 text-[10px]">{h.agent_id}</span>
                        )}
                        {h.app_id && (
                          <span className="px-1.5 py-0.5 rounded bg-white/5 text-[10px]">{h.app_id}</span>
                        )}
                        <span className="ml-auto">{relativeTime(h.created_at)}</span>
                      </div>
                      {h.diff_excerpt && (
                        <pre className="mt-1.5 text-[11.5px] text-cl2-ink/70 font-mono whitespace-pre-wrap line-clamp-3">
                          {h.diff_excerpt}
                        </pre>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
