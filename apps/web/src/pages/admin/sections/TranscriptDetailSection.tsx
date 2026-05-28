/**
 * TranscriptDetailSection — drill-down for a single session in the pipeline.
 *
 * Shows:
 *   • Session header (title, status, LLM model, counts)
 *   • Re-process / skip-LLM buttons
 *   • Corrections grouped by human_review state (pending first, then
 *     accepted/rejected as collapsible groups)
 *   • Segments preview (first 50, with load-more)
 *
 * Navigation: rendered when path is /admin/transcripts/:sessionId.
 * Clicking "← Volver" goes back to /admin/transcripts.
 *
 * Endpoints used:
 *   GET  /api/admin/transcripts/sessions/:id
 *   PATCH /api/admin/transcripts/corrections/:id
 *   POST /api/admin/transcripts/sync  (re-process)
 */
import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  AlertCircle,
  FileText,
  Cpu,
  Youtube,
  ExternalLink,
} from 'lucide-react';
import {
  ActionButton,
  Card,
  CardBody,
  CardHeader,
  Pill,
  SectionHeader,
} from '../primitives';
import {
  getTranscriptSession,
  patchCorrection,
  reviewTranscriptSession,
  triggerSync,
  type TranscriptCorrection,
  type TranscriptSessionDetailResponse,
} from '@/services/transcriptsAdminApi';
import { TranscriptDownloadButton } from '@/components/TranscriptDownloadButton';
import { navigate } from '@/lib/router';
import { useToast } from '../Toast';

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatTs(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }
  return `${m}:${String(ss).padStart(2, '0')}`;
}

function formatRelative(iso: string | null): string {
  if (!iso) return 'nunca';
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return 'ahora';
  if (diffMins < 60) return `hace ${diffMins}m`;
  const diffH = Math.floor(diffMins / 60);
  if (diffH < 24) return `hace ${diffH}h`;
  return new Date(iso).toLocaleDateString('es-CR', { day: '2-digit', month: 'short' });
}

function confidencePill(conf: number): React.ReactElement {
  const kind = conf >= 0.9 ? 'success' : conf >= 0.75 ? 'warn' : 'danger';
  return <Pill kind={kind}>{(conf * 100).toFixed(0)}%</Pill>;
}

function statusPill(status: string): React.ReactElement {
  const map: Record<string, { kind: 'success' | 'warn' | 'danger' | 'neutral' | 'info'; label: string }> = {
    indexed:    { kind: 'success', label: 'indexado' },
    processing: { kind: 'warn',    label: 'procesando' },
    pending:    { kind: 'info',    label: 'pendiente' },
    failed:     { kind: 'danger',  label: 'error' },
    skipped:    { kind: 'neutral', label: 'saltado' },
  };
  const m = map[status] ?? { kind: 'neutral', label: status };
  return <Pill kind={m.kind}>{m.label}</Pill>;
}

// ─── Correction card ─────────────────────────────────────────────────────────

interface CorrectionCardProps {
  correction: TranscriptCorrection;
  /** Segment index for display (looked up from segments list) */
  segmentIdx: number | null;
  onAccept: () => void;
  onReject: () => void;
  isBusy: boolean;
  isReviewed: boolean;
}

function CorrectionCard({
  correction,
  segmentIdx,
  onAccept,
  onReject,
  isBusy,
  isReviewed,
}: CorrectionCardProps): React.ReactElement {
  return (
    <div
      className={`rounded-lg border px-4 py-3 text-[12.5px] transition-colors ${
        correction.human_review === 'pending'
          ? 'border-amber-400/30 bg-amber-500/[0.04] dark:bg-amber-500/[0.06]'
          : correction.human_review === 'accepted'
            ? 'border-emerald-400/30 bg-emerald-500/[0.04] dark:bg-emerald-500/[0.04]'
            : 'border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-[#0e1745]/[0.02] dark:bg-white/[0.02] opacity-70'
      }`}
    >
      <div className="flex flex-wrap items-start gap-2 mb-2">
        {/* Segment index badge */}
        {segmentIdx != null && (
          <span className="shrink-0 rounded border border-[#0e1745]/[0.10] dark:border-white/[0.10] bg-[#0e1745]/[0.05] dark:bg-white/[0.05] px-1.5 py-px font-mono text-[10.5px] text-[#0e1745]/60 dark:text-white/60">
            [{segmentIdx}]
          </span>
        )}
        {/* Kind badge */}
        <span className="rounded bg-[#0e1745]/[0.06] dark:bg-white/[0.08] px-1.5 py-px font-mono text-[10.5px] text-[#0e1745]/70 dark:text-white/70">
          {correction.kind}
        </span>
        {/* Confidence */}
        {confidencePill(correction.confidence)}
        {/* Review state badge (for accepted/rejected) */}
        {correction.human_review === 'accepted' && (
          <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 size={11} strokeWidth={2} /> aceptado
          </span>
        )}
        {correction.human_review === 'rejected' && (
          <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-rose-600 dark:text-rose-400">
            <XCircle size={11} strokeWidth={2} /> rechazado
          </span>
        )}
        {/* Model */}
        {correction.model && (
          <span className="ml-auto font-mono text-[10px] text-[#0e1745]/40 dark:text-white/40">
            {correction.model}
          </span>
        )}
      </div>

      {/* Original → suggested */}
      <div className="flex flex-wrap items-baseline gap-1.5 font-mono text-[12.5px]">
        <span className="text-rose-700 dark:text-rose-400 line-through opacity-80">
          &ldquo;{correction.original_text}&rdquo;
        </span>
        <span className="text-[#0e1745]/40 dark:text-white/40">→</span>
        <span className="text-emerald-700 dark:text-emerald-300 font-semibold">
          &ldquo;{correction.suggested_text}&rdquo;
        </span>
      </div>

      {/* Reasoning */}
      {correction.reasoning && (
        <div className="mt-1.5 text-[11.5px] italic text-[#0e1745]/55 dark:text-white/55">
          {correction.reasoning}
        </div>
      )}

      {/* Action buttons — only for pending */}
      {correction.human_review === 'pending' && !isReviewed && (
        <div className="mt-3 flex items-center gap-2">
          <ActionButton
            variant="approve"
            size="sm"
            icon={CheckCircle2}
            onClick={onAccept}
            disabled={isBusy}
          >
            Aceptar
          </ActionButton>
          <ActionButton
            variant="reject"
            size="sm"
            icon={XCircle}
            onClick={onReject}
            disabled={isBusy}
          >
            Rechazar
          </ActionButton>
          {isBusy && <Loader2 size={13} className="animate-spin text-[#0e1745]/40 dark:text-white/40" />}
        </div>
      )}
      {/* Show reviewed-at for reviewed corrections */}
      {correction.reviewed_at && (
        <div className="mt-2 text-[11px] text-[#0e1745]/45 dark:text-white/45">
          revisado {formatRelative(correction.reviewed_at)}
        </div>
      )}
    </div>
  );
}

// ─── Collapsible group ────────────────────────────────────────────────────────

function CollapsibleGroup({
  title,
  defaultOpen = false,
  children,
  count,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
  count: number;
}): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 py-2 text-left text-[12px] font-semibold text-[#0e1745]/70 dark:text-white/70 hover:text-[#0e1745] dark:hover:text-white"
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {title}
        <span className="ml-1 rounded-full bg-[#0e1745]/[0.06] dark:bg-white/[0.08] px-1.5 py-px font-mono text-[10.5px] font-normal">
          {count}
        </span>
      </button>
      {open && <div className="flex flex-col gap-2 pb-2">{children}</div>}
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

interface TranscriptDetailSectionProps {
  sessionId: string;
}

export function TranscriptDetailSection({
  sessionId,
}: TranscriptDetailSectionProps): React.ReactElement {
  const { notify } = useToast();
  const [detailData, setDetailData] = useState<TranscriptSessionDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Optimistic state: track correction updates locally while re-fetch is in flight
  const [optimisticUpdates, setOptimisticUpdates] = useState<
    Record<string, 'accepted' | 'rejected'>
  >({});
  const [busyCorrections, setBusyCorrections] = useState<Set<string>>(new Set());

  const [reprocessBusy, setReprocessBusy] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  // Búsqueda dentro del transcript — Cmd+F nativo no es ideal en listas largas
  // (4000+ segments), un input dedicado filtra in-memory rápido.
  const [segmentSearch, setSegmentSearch] = useState('');

  // ── Load session detail ────────────────────────────────────────────────
  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await getTranscriptSession(sessionId);
      setDetailData(res);
      setOptimisticUpdates({});
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // ── Correct a single correction ────────────────────────────────────────
  const handleReview = async (correction: TranscriptCorrection, action: 'accept' | 'reject') => {
    setBusyCorrections((s) => new Set(s).add(correction.id));
    // Optimistic: show the new state immediately
    setOptimisticUpdates((prev) => ({
      ...prev,
      [correction.id]: action === 'accept' ? 'accepted' : 'rejected',
    }));
    try {
      await patchCorrection(correction.id, action);
      notify({
        kind: 'success',
        text: action === 'accept' ? 'Corrección aceptada' : 'Corrección rechazada',
        detail: `kind: ${correction.kind}`,
      });
      // Refresh the full detail to sync counts
      void load();
    } catch (err) {
      // Revert optimistic update on error
      setOptimisticUpdates((prev) => {
        const next = { ...prev };
        delete next[correction.id];
        return next;
      });
      notify({ kind: 'error', text: 'No se pudo guardar', detail: (err as Error).message });
    } finally {
      setBusyCorrections((s) => {
        const out = new Set(s);
        out.delete(correction.id);
        return out;
      });
    }
  };

  // ── Re-process ─────────────────────────────────────────────────────────
  const handleReprocess = async (skipLlm: boolean) => {
    if (!detailData) return;
    setReprocessBusy(true);
    const videoId = detailData.session.youtube_video_id;
    try {
      await triggerSync(
        videoId
          ? { videoIds: [videoId], force: true, skipLlmReview: skipLlm }
          : { force: true, skipLlmReview: skipLlm },
      );
      notify({
        kind: 'success',
        text: skipLlm ? 'Re-segmentado (sin revisión IA)' : 'Re-procesando con revisión IA…',
        detail: 'Los datos se actualizarán en unos momentos.',
      });
      void load();
    } catch (err) {
      notify({ kind: 'error', text: 'No se pudo re-procesar', detail: (err as Error).message });
    } finally {
      setReprocessBusy(false);
    }
  };

  const handleSessionReview = async (action: 'approve' | 'reject') => {
    if (!detailData) return;
    setReviewBusy(true);
    try {
      await reviewTranscriptSession(sessionId, action);
      notify({
        kind: 'success',
        text:
          action === 'approve'
            ? 'Sesión aprobada — visible en /sesiones para todos'
            : 'Sesión rechazada — no se publicó',
      });
      void load();
    } catch (err) {
      notify({
        kind: 'error',
        text: action === 'approve' ? 'No se pudo aprobar' : 'No se pudo rechazar',
        detail: (err as Error).message,
      });
    } finally {
      setReviewBusy(false);
    }
  };

  // ── Build effective corrections (apply optimistic overrides) ───────────
  const effectiveCorrections = (corrs: TranscriptCorrection[]): TranscriptCorrection[] =>
    corrs.map((c) =>
      optimisticUpdates[c.id] ? { ...c, human_review: optimisticUpdates[c.id]! } : c,
    );

  // ── Render ─────────────────────────────────────────────────────────────

  if (loading && !detailData) {
    return (
      <div className="flex items-center justify-center gap-2 py-20 text-[12.5px] text-[#0e1745]/50 dark:text-white/50">
        <Loader2 size={15} className="animate-spin" />
        Cargando sesión…
      </div>
    );
  }

  if (loadError) {
    return (
      <>
        <SectionHeader eyebrow="Transcripciones · Cola de revisión" />
        <button
          type="button"
          onClick={() => navigate('/admin/transcripts')}
          className="mb-4 inline-flex items-center gap-1.5 text-[12.5px] text-[#0e1745]/65 dark:text-white/65 hover:text-[#0e1745] dark:hover:text-white"
        >
          <ArrowLeft size={13} /> Volver
        </button>
        <Card>
          <CardBody className="flex items-center gap-2 text-[12.5px] text-rose-700 dark:text-rose-300">
            <AlertCircle size={14} />
            Error: {loadError}
            <ActionButton variant="quiet" icon={RefreshCw} onClick={() => void load()}>
              Reintentar
            </ActionButton>
          </CardBody>
        </Card>
      </>
    );
  }

  if (!detailData) return <></>;

  const { session, segments, corrections: rawCorrections } = detailData;

  // Apply optimistic updates to all correction groups
  const corrections = {
    pending: effectiveCorrections(rawCorrections.pending).filter(
      (c) => c.human_review === 'pending',
    ),
    accepted: [
      ...effectiveCorrections(rawCorrections.pending).filter(
        (c) => c.human_review === 'accepted',
      ),
      ...effectiveCorrections(rawCorrections.accepted),
    ],
    rejected: [
      ...effectiveCorrections(rawCorrections.pending).filter(
        (c) => c.human_review === 'rejected',
      ),
      ...effectiveCorrections(rawCorrections.rejected),
    ],
  };

  // Build a map from segment_id → segment_idx for the correction display
  const segmentIdxMap: Record<string, number> = {};
  for (const seg of segments) {
    segmentIdxMap[seg.id] = seg.segment_idx;
  }

  const totalCorrections =
    corrections.pending.length + corrections.accepted.length + corrections.rejected.length;

  return (
    <>
      <SectionHeader eyebrow="Transcripciones · Cola de revisión" />

      {/* Back + title row */}
      <div className="mb-4 flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate('/admin/transcripts')}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[#0e1745]/[0.08] dark:border-white/[0.08] bg-white dark:bg-white/[0.04] px-3 py-1.5 text-[12.5px] font-medium text-[#0e1745]/70 dark:text-white/70 hover:bg-[#0e1745]/[0.04] dark:hover:bg-white/[0.08] hover:text-[#0e1745] dark:hover:text-white"
        >
          <ArrowLeft size={12} /> Volver
        </button>
        <div className="flex-1 min-w-0">
          <h2 className="m-0 truncate font-display text-[20px] font-normal leading-tight tracking-tight text-[#0e1745] dark:text-white">
            {session.title}
          </h2>
          {session.fecha && (
            <div className="text-[11.5px] text-[#0e1745]/50 dark:text-white/50">
              {new Date(`${session.fecha}T12:00:00`).toLocaleDateString('es-CR', {
                day: '2-digit',
                month: 'long',
                year: 'numeric',
              })}
              {session.comision && ` · ${session.comision}`}
            </div>
          )}
        </div>
      </div>

      {/* Status bar */}
      <Card className="mb-5">
        <CardBody className="flex flex-wrap items-center gap-3 py-3">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#0e1745]/45 dark:text-white/45">
              Estado
            </span>
            {statusPill(session.status)}
          </div>
          <span className="text-[#0e1745]/20 dark:text-white/20">|</span>
          {session.llm_review_model && (
            <div className="flex items-center gap-1.5 text-[12px] text-[#0e1745]/60 dark:text-white/60">
              <Cpu size={11} />
              <span className="font-mono">{session.llm_review_model}</span>
            </div>
          )}
          <div className="flex items-center gap-1.5 text-[12px] text-[#0e1745]/60 dark:text-white/60">
            <FileText size={11} />
            <span className="tabular-nums font-semibold text-[#0e1745] dark:text-white">
              {segments.length.toLocaleString('es-CR')}
            </span>{' '}
            segmentos
          </div>
          <div className="text-[12px] text-[#0e1745]/60 dark:text-white/60">
            <span className="tabular-nums font-semibold text-[#0e1745] dark:text-white">
              {totalCorrections.toLocaleString('es-CR')}
            </span>{' '}
            correcciones
            {corrections.pending.length > 0 && (
              <Pill kind="warn" className="ml-2">
                {corrections.pending.length} pendientes
              </Pill>
            )}
          </div>
          {session.llm_reviewed_at && (
            <span className="text-[11.5px] text-[#0e1745]/50 dark:text-white/50">
              Revisión IA: {formatRelative(session.llm_reviewed_at)}
            </span>
          )}

          {/* Action buttons */}
          <div className="ml-auto flex items-center gap-2">
            <TranscriptDownloadButton sesionId={sessionId} />
            <ActionButton
              variant="ghost"
              icon={reprocessBusy ? Loader2 : RefreshCw}
              onClick={() => void handleReprocess(false)}
              disabled={reprocessBusy || reviewBusy}
              title="Procesar de nuevo: nueva transcripción + revisión automática"
            >
              Re-procesar
            </ActionButton>
            <ActionButton
              variant="quiet"
              onClick={() => void handleReprocess(true)}
              disabled={reprocessBusy || reviewBusy}
              title="Solo re-segmentar la transcripción, sin revisión automática"
            >
              Solo re-segmentar
            </ActionButton>
            {/* Botones de decisión final — aparecen automáticamente para toda
                sesión que aún no está 'indexed' o 'rejected'. */}
            {session.status !== 'indexed' && session.status !== 'rejected' && (
              <>
                <ActionButton
                  variant="reject"
                  icon={XCircle}
                  onClick={() => void handleSessionReview('reject')}
                  disabled={reprocessBusy || reviewBusy}
                  title="Rechazar la sesión: no se publica en /sesiones"
                >
                  Rechazar
                </ActionButton>
                <ActionButton
                  variant="approve"
                  icon={CheckCircle2}
                  onClick={() => void handleSessionReview('approve')}
                  disabled={reprocessBusy || reviewBusy}
                  title="Aprobar la sesión: queda visible en /sesiones para todos"
                >
                  {reviewBusy ? 'Aprobando…' : 'Aprobar sesión'}
                </ActionButton>
              </>
            )}
            {session.status === 'indexed' && (
              <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 size={14} strokeWidth={2} /> Publicada en /sesiones
              </span>
            )}
            {session.status === 'rejected' && (
              <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-rose-700 dark:text-rose-300">
                <XCircle size={14} strokeWidth={2} /> Rechazada
              </span>
            )}
          </div>
        </CardBody>
      </Card>

      {/* ── YouTube embed ───────────────────────────────────────────────
          El operador necesita ver el video original mientras revisa la
          transcripción — para validar fechas, oradores, nombres mal
          transcritos. Si la sesión no es de YouTube (legacy uploads),
          no renderiza nada.
       */}
      {session.youtube_video_id && (
        <Card className="mb-5 overflow-hidden">
          <div className="relative w-full" style={{ paddingBottom: '56.25%' }}>
            <iframe
              src={`https://www.youtube.com/embed/${session.youtube_video_id}`}
              title={session.title}
              className="absolute inset-0 h-full w-full"
              frameBorder={0}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          </div>
          <CardBody className="flex items-center gap-2 py-2 text-[11.5px] text-[#0e1745]/55 dark:text-white/55">
            <Youtube size={12} />
            <span className="font-mono">{session.youtube_video_id}</span>
            <a
              href={`https://www.youtube.com/watch?v=${session.youtube_video_id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto inline-flex items-center gap-1 hover:text-[#0e1745] dark:hover:text-white"
            >
              Abrir en YouTube <ExternalLink size={11} />
            </a>
          </CardBody>
        </Card>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_420px] gap-5">
        {/* ── Corrections ──────────────────────────────────────────────── */}
        <div className="flex flex-col gap-3">
          <Card>
            <CardHeader
              title={
                <span className="inline-flex items-center gap-1.5">
                  Correcciones
                  <span className="font-mono text-[10.5px] font-normal text-[#0e1745]/50 dark:text-white/50">
                    ({totalCorrections})
                  </span>
                </span>
              }
              meta={
                corrections.pending.length > 0 ? (
                  <Pill kind="warn">{corrections.pending.length} pendientes</Pill>
                ) : totalCorrections > 0 ? (
                  <Pill kind="success">todas revisadas</Pill>
                ) : undefined
              }
            />
            <CardBody className="flex flex-col gap-3">
              {totalCorrections === 0 && (
                <div className="py-6 text-center text-[12.5px] text-[#0e1745]/50 dark:text-white/50">
                  Sin correcciones para esta sesión.
                </div>
              )}

              {/* Pending — always expanded */}
              {corrections.pending.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-amber-600 dark:text-amber-400">
                    Pendientes ({corrections.pending.length})
                  </div>
                  {corrections.pending.map((c) => (
                    <CorrectionCard
                      key={c.id}
                      correction={c}
                      segmentIdx={c.segment_id ? (segmentIdxMap[c.segment_id] ?? null) : null}
                      onAccept={() => void handleReview(c, 'accept')}
                      onReject={() => void handleReview(c, 'reject')}
                      isBusy={busyCorrections.has(c.id)}
                      isReviewed={!!optimisticUpdates[c.id]}
                    />
                  ))}
                </div>
              )}

              {/* Accepted — collapsible */}
              {corrections.accepted.length > 0 && (
                <CollapsibleGroup
                  title="Aceptadas"
                  count={corrections.accepted.length}
                  defaultOpen={corrections.pending.length === 0}
                >
                  {corrections.accepted.map((c) => (
                    <CorrectionCard
                      key={c.id}
                      correction={c}
                      segmentIdx={c.segment_id ? (segmentIdxMap[c.segment_id] ?? null) : null}
                      onAccept={() => void handleReview(c, 'accept')}
                      onReject={() => void handleReview(c, 'reject')}
                      isBusy={busyCorrections.has(c.id)}
                      isReviewed={false}
                    />
                  ))}
                </CollapsibleGroup>
              )}

              {/* Rejected — collapsible */}
              {corrections.rejected.length > 0 && (
                <CollapsibleGroup
                  title="Rechazadas"
                  count={corrections.rejected.length}
                  defaultOpen={false}
                >
                  {corrections.rejected.map((c) => (
                    <CorrectionCard
                      key={c.id}
                      correction={c}
                      segmentIdx={c.segment_id ? (segmentIdxMap[c.segment_id] ?? null) : null}
                      onAccept={() => void handleReview(c, 'accept')}
                      onReject={() => void handleReview(c, 'reject')}
                      isBusy={busyCorrections.has(c.id)}
                      isReviewed={false}
                    />
                  ))}
                </CollapsibleGroup>
              )}
            </CardBody>
          </Card>
        </div>

        {/* ── Segments con visor fijo + scroll interno ─────────────────────
            Bug previo: scroll infinito de página + botón "Cargar más" cada 50.
            Para plenarios de 6 h (7900+ segments) era imposible navegar.
            Ahora: panel con altura fija (calc(100vh - 240px)) + scroll interno
            + búsqueda rápida en memoria. Muestra TODOS los segments. */}
        <div>
          <Card className="flex flex-col max-h-[calc(100vh-240px)] min-h-[420px]">
            <CardHeader
              title={
                <div className="flex items-center gap-2.5">
                  <FileText size={13} />
                  <span>Transcripción</span>
                  <span className="font-mono text-[10.5px] font-normal text-[#0e1745]/50 dark:text-white/50">
                    {segmentSearch
                      ? `(${segments.filter((s) => s.text.toLowerCase().includes(segmentSearch.toLowerCase())).length}/${segments.length})`
                      : `${segments.length} segmentos`}
                  </span>
                </div>
              }
              meta={
                <span className="flex items-center">
                  <input
                    type="text"
                    placeholder="Buscar en transcripción…"
                    value={segmentSearch}
                    onChange={(e) => setSegmentSearch(e.target.value)}
                    className="w-56 rounded-md border border-[#0e1745]/15 dark:border-white/15 bg-white/60 dark:bg-white/[0.04] px-2.5 py-1 text-[11.5px] text-[#0e1745] dark:text-white placeholder-[#0e1745]/45 dark:placeholder-white/35 focus:outline-none focus:border-cl2-accent/60"
                  />
                  {segmentSearch && (
                    <button
                      type="button"
                      onClick={() => setSegmentSearch('')}
                      className="ml-1.5 rounded p-1 text-[#0e1745]/40 hover:text-[#0e1745] dark:text-white/40 dark:hover:text-white"
                      aria-label="Limpiar búsqueda"
                    >
                      <XCircle size={12} />
                    </button>
                  )}
                </span>
              }
            />
            <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-[#0e1745]/[0.05] dark:divide-white/[0.05]">
              {(() => {
                const q = segmentSearch.trim().toLowerCase();
                const filtered = q
                  ? segments.filter((s) => s.text.toLowerCase().includes(q))
                  : segments;
                if (filtered.length === 0 && segments.length > 0) {
                  return (
                    <div className="px-[18px] py-8 text-center text-[12.5px] text-[#0e1745]/50 dark:text-white/50">
                      Sin resultados para "{segmentSearch}". Probá otro término o limpiá la búsqueda.
                    </div>
                  );
                }
                return filtered.map((seg) => (
                  <div
                    key={seg.id}
                    className="flex gap-3 px-[18px] py-2.5 text-[12.5px]"
                  >
                    <div className="shrink-0 pt-px">
                      <span className="font-mono text-[10.5px] text-[#0e1745]/45 dark:text-white/45">
                        {formatTs(seg.start_seconds)}
                      </span>
                    </div>
                    <div className="min-w-0 flex-1 text-[#0e1745] dark:text-white leading-relaxed">
                      {seg.text}
                    </div>
                  </div>
                ));
              })()}
            </div>
            {segments.length === 0 && (
              <div className="px-[18px] py-8 text-center text-[12.5px] text-[#0e1745]/50 dark:text-white/50">
                Sin transcripción aún. Tocá "Re-procesar" para generarla.
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
