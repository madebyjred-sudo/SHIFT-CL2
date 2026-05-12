/**
 * TranscriptDownloadButton — botón "Descargar transcripción" con dropdown
 * TXT/SRT. Hace fetch autenticado al endpoint del BFF y dispara descarga
 * via blob + anchor temporal.
 *
 * Solo soporta sesiones UUID (Supabase). Si pasás un ID legacy (int) el
 * endpoint devuelve 400 — el botón muestra un toast con el error.
 *
 * Usage:
 *   <TranscriptDownloadButton sesionId={sesionId} />
 *
 * Diseño visual matchea los otros action buttons del header del SesionViewPage
 * (small, rounded, color secundario).
 */
import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Download, FileText, FileAudio, Loader2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';

interface Props {
  sesionId: string;
  /** Variante visual: por default 'compact' (icono + texto), 'icon-only' para
   *  cuando el espacio es escaso (e.g. dentro de cards densas). */
  variant?: 'compact' | 'icon-only';
}

export function TranscriptDownloadButton({ sesionId, variant = 'compact' }: Props): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<null | 'txt' | 'srt'>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Calcular posición del menu basada en el bounding rect del botón.
  // Necesario porque renderizamos via portal en document.body — el
  // posicionamiento absoluto relativo al parent ya no aplica.
  function computeMenuPos() {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setMenuPos({
      top: rect.bottom + 6, // 6px debajo del botón
      right: window.innerWidth - rect.right, // alineado al borde derecho del botón
    });
  }

  // Cerrar dropdown al click afuera del botón Y del menú (que vive en portal)
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node;
      if (
        !containerRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    }
    function onResize() {
      computeMenuPos();
    }
    document.addEventListener('mousedown', onDocClick);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
    };
  }, [open]);

  async function downloadFormat(format: 'txt' | 'srt') {
    if (busy) return;
    setBusy(format);
    setOpen(false);
    setErrorMsg(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const url = `/api/sessions/${encodeURIComponent(sesionId)}/transcript/download?format=${format}`;
      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const errBody = await res.text();
        let errMsg = `${res.status}`;
        try { errMsg = JSON.parse(errBody).error ?? errMsg; } catch { /* noop */ }
        throw new Error(errMsg);
      }
      const blob = await res.blob();
      // Filename del Content-Disposition (server lo arma con slug)
      const cd = res.headers.get('content-disposition') ?? '';
      const fnMatch = cd.match(/filename="([^"]+)"/);
      const filename = fnMatch?.[1] ?? `transcripcion.${format}`;
      // Crear anchor temporal para disparar download
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch (err) {
      setErrorMsg((err as Error).message);
      // Auto-clear después de 4s
      setTimeout(() => setErrorMsg(null), 4_000);
    } finally {
      setBusy(null);
    }
  }

  function toggleOpen() {
    if (!open) computeMenuPos();
    setOpen((v) => !v);
  }

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        onClick={toggleOpen}
        title="Descargar transcripción (TXT o SRT)"
        disabled={busy !== null}
        className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[#0e1745]/[0.06] text-[#0e1745]/75 dark:bg-white/[0.06] dark:text-white/75 hover:bg-[#0e1745]/[0.10] dark:hover:bg-white/[0.10] transition-colors disabled:opacity-50"
      >
        {busy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
        {variant === 'icon-only' ? '' : busy ? 'Descargando…' : 'Descargar'}
      </button>

      {errorMsg && menuPos && createPortal(
        <div
          className="fixed w-56 rounded-lg border border-rose-300/60 dark:border-rose-400/40 bg-rose-50 dark:bg-rose-950/40 px-3 py-2 text-[11.5px] text-rose-700 dark:text-rose-300 shadow-md"
          style={{ top: menuPos.top, right: menuPos.right, zIndex: 9999 }}
        >
          {errorMsg}
        </div>,
        document.body,
      )}

      {open && menuPos && createPortal(
        <div
          ref={menuRef}
          className="fixed w-56 rounded-lg border border-[#0e1745]/[0.10] dark:border-white/[0.10] bg-white dark:bg-[#1a1f2e] shadow-lg overflow-hidden"
          style={{ top: menuPos.top, right: menuPos.right, zIndex: 9999 }}
          role="menu"
        >
          <button
            type="button"
            onClick={() => void downloadFormat('txt')}
            className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left text-[12px] text-[#0e1745] dark:text-white hover:bg-[#0e1745]/[0.04] dark:hover:bg-white/[0.04] transition-colors"
            role="menuitem"
          >
            <FileText size={14} className="mt-px shrink-0 text-[#0e1745]/55 dark:text-white/55" />
            <div className="min-w-0">
              <div className="font-medium">TXT plano</div>
              <div className="text-[11px] text-[#0e1745]/55 dark:text-white/55">
                Solo texto, sin timecodes. Para Word o Google Docs.
              </div>
            </div>
          </button>
          <div className="border-t border-[#0e1745]/[0.06] dark:border-white/[0.06]" />
          <button
            type="button"
            onClick={() => void downloadFormat('srt')}
            className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left text-[12px] text-[#0e1745] dark:text-white hover:bg-[#0e1745]/[0.04] dark:hover:bg-white/[0.04] transition-colors"
            role="menuitem"
          >
            <FileAudio size={14} className="mt-px shrink-0 text-[#0e1745]/55 dark:text-white/55" />
            <div className="min-w-0">
              <div className="font-medium">SRT con timecodes</div>
              <div className="text-[11px] text-[#0e1745]/55 dark:text-white/55">
                Subtítulos estándar. Compatible con VLC, YouTube, Premiere.
              </div>
            </div>
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
