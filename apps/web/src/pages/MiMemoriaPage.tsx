/**
 * Mi memoria — Track 0b
 *
 * Página dedicada a que el usuario gestione su neurona personal:
 * lista de archivos, editor inline, borrado, audit history.
 *
 * Backend: 5 endpoints en `/api/neuron/*` que proxean a Cerebro
 * (apps/api/src/routes/neuron.ts). El user_id se deriva server-side
 * del JWT; el SPA no manda email — la página solo trabaja con "mis
 * archivos", nunca puede leer los de otro user.
 */
import { useEffect, useMemo, useState, useCallback } from 'react';
import { BookHeart, FilePlus, Save, Trash2, X, History, AlertCircle } from 'lucide-react';
import {
  listMyMemory,
  readMyMemoryFile,
  writeMyMemoryFile,
  deleteMyMemoryFile,
  getMyMemoryHistory,
  type NeuronFileMeta,
  type NeuronHistoryEntry,
} from '@/services/neuronApi';

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

interface OpenFile {
  path: string;
  content: string;
  dirty: boolean;
  saving: boolean;
  error: string | null;
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
    if (!window.confirm(`¿Borrar ${open.path}? Esta acción no se puede deshacer.`)) return;
    try {
      await deleteMyMemoryFile(open.path);
      setOpen(null);
      await refresh();
    } catch (err) {
      setOpen({ ...open, error: (err as Error).message });
    }
  }, [open, refresh]);

  const createNew = useCallback(async () => {
    const raw = window.prompt(
      'Nombre del archivo (ej: notas-cliente-acme, ideas-q3). Se guarda bajo /memories/',
      'nueva-nota',
    );
    if (!raw) return;
    const slug = raw.trim().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    if (!slug) return;
    const path = slug.startsWith('/memories/') ? slug : `/memories/${slug}.md`;
    setOpen({
      path,
      content: `# ${slug.replace(/-/g, ' ')}\n\n`,
      dirty: true,
      saving: false,
      error: null,
    });
  }, []);

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
            Esta es tu memoria personal — la usan Lexa, Atlas y Centinela
            al inicio de cada conversación para adaptar sus respuestas.
            Es privada: nadie más la ve. Editá libremente.
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
              onClick={createNew}
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
        {/* List */}
        <aside>
          <h2 className="text-[11px] uppercase tracking-wider text-cl2-ink/50 mb-3">Archivos</h2>
          {loadError && (
            <div className="text-sm text-cl2-burgundy/90 bg-cl2-burgundy/8 border border-cl2-burgundy/20 rounded-md p-3 mb-3 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>No pude cargar tu memoria: {loadError}</span>
            </div>
          )}
          {files && files.length === 0 && !loadError && (
            <div className="text-sm text-cl2-ink/50 italic">
              Tu memoria está vacía. Creá una nota o esperá a que un admin
              te apruebe (los templates se siembran solos).
            </div>
          )}
          <ul className="space-y-1.5">
            {(files ?? []).map((f) => {
              const isOpen = open?.path === f.path;
              return (
                <li key={f.path}>
                  <button
                    onClick={() => openFile(f.path)}
                    className={`w-full text-left rounded-md px-3 py-2.5 transition-colors ${
                      isOpen
                        ? 'bg-cl2-burgundy/10 ring-1 ring-cl2-burgundy/30'
                        : 'hover:bg-white/5'
                    }`}
                  >
                    <div className="font-mono text-[12px] text-cl2-ink/90 truncate">{f.path}</div>
                    <div className="mt-0.5 text-[11px] text-cl2-ink/50">
                      {bytesToKb(f.size_bytes)} · {relativeTime(f.updated_at)}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
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
                <div className="font-mono text-[12px] text-cl2-ink/80 truncate">{open.path}</div>
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
