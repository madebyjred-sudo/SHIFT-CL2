/**
 * TranscriptsSection — pipeline cockpit for the YouTube transcript pipeline.
 *
 * Lets Jred:
 *   1. See all sessions with their pipeline state at a glance
 *   2. Filter by status
 *   3. Manually trigger a sync (calls POST /api/admin/transcripts/sync)
 *   4. Click into a session to drill down (navigates to /admin/transcripts/:id)
 *
 * Data: GET /api/admin/transcripts/sessions (real Supabase, not mocked).
 * Auth: any logged-in user (matches admin.ts convention).
 *
 * Note: this is DIFFERENT from TranscripcionesSection (the legacy CL2 moderation
 * queue for Whisper+diarization). This section is for the new YouTube pipeline:
 * transcript_segments + transcript_corrections (Task 6 schema).
 */
import { useState } from 'react';
import {
  RefreshCw,
  Loader2,
  Video,
  CheckCircle2,
  Clock,
  AlertCircle,
  Inbox,
  ChevronRight,
  SlidersHorizontal,
} from 'lucide-react';
import {
  ActionButton,
  Card,
  CardHeader,
  Pill,
  SectionHeader,
} from '../primitives';
import { AdminTable } from '../Table';
import {
  listTranscriptSessions,
  triggerSync,
  type TranscriptSessionListItem,
} from '@/services/transcriptsAdminApi';
import { useAdminFetch } from '@/services/adminApi';
import { navigate } from '@/lib/router';
import { useToast } from '../Toast';

// ─── Status helpers ────────────────────────────────────────────────────────

type StatusKind = 'success' | 'warn' | 'danger' | 'neutral' | 'info';

function statusPill(status: string): React.ReactElement {
  const map: Record<string, { kind: StatusKind; label: string }> = {
    indexed:    { kind: 'success', label: 'indexado' },
    processing: { kind: 'warn',    label: 'procesando' },
    pending:    { kind: 'info',    label: 'pendiente' },
    failed:     { kind: 'danger',  label: 'error' },
    skipped:    { kind: 'neutral', label: 'saltado' },
  };
  const m = map[status] ?? { kind: 'neutral', label: status };
  return <Pill kind={m.kind}>{m.label}</Pill>;
}

function statusIcon(status: string): React.ReactElement {
  if (status === 'indexed') return <CheckCircle2 size={12} className="text-emerald-600" />;
  if (status === 'processing') return <Clock size={12} className="text-amber-500" />;
  if (status === 'failed') return <AlertCircle size={12} className="text-rose-600" />;
  return <Clock size={12} className="text-[#0e1745]/40 dark:text-white/40" />;
}

function formatRelative(iso: string | null): string {
  if (!iso) return 'nunca';
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return 'ahora';
  if (diffMins < 60) return `hace ${diffMins}m`;
  const diffH = Math.floor(diffMins / 60);
  if (diffH < 24) return `hace ${diffH}h`;
  const diffD = Math.floor(diffH / 24);
  return `hace ${diffD}d`;
}

function formatNumber(n: number): string {
  return n.toLocaleString('es-CR');
}

// ─── Status filter options ─────────────────────────────────────────────────

const STATUS_OPTIONS = [
  { id: 'all',            label: 'Todos' },
  { id: 'pending_review', label: 'Por aprobar' },
  { id: 'indexed',        label: 'Publicadas' },
  { id: 'processing',     label: 'Procesando' },
  { id: 'pending',        label: 'En cola' },
  { id: 'rejected',       label: 'Rechazadas' },
  { id: 'failed',         label: 'Error' },
];

// ─── Main component ────────────────────────────────────────────────────────

export function TranscriptsSection(): React.ReactElement {
  const { notify } = useToast();
  // Default abierto en "Por aprobar" — es el tab donde Carlos toma decisión.
  // Antes era 'all', pero eso enterraba las pending_review en una lista de 250+
  // sesiones legacy ya indexadas.
  const [statusFilter, setStatusFilter] = useState<string>('pending_review');
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncVideoInput, setSyncVideoInput] = useState('');

  // Build the query params from the current filter
  const fetchSessions = () =>
    listTranscriptSessions(
      statusFilter !== 'all' ? { status: statusFilter, limit: 200 } : { limit: 200 },
    ).then((res) => ({
      ok: true as const,
      mock: false,
      generated_at: new Date().toISOString(),
      data: res,
    }));

  const { data, loading, error, refetch } = useAdminFetch(fetchSessions, [statusFilter]);

  const sessions = data?.sessions ?? [];
  const total = data?.total ?? 0;
  const pendingCount = sessions.filter((s) => s.corrections_pending > 0).length;

  // ── Sync action ────────────────────────────────────────────────────────
  const handleSync = async (videoIds?: string[]) => {
    setSyncBusy(true);
    try {
      const result = await triggerSync(
        videoIds && videoIds.length > 0
          ? { videoIds }
          : { daysBack: 7 },
      );
      const processed = (result.processed as Array<{ status: string }>).length;
      const failures = (result.processed as Array<{ status: string }>).filter(
        (p) => p.status === 'permanent_failure',
      ).length;
      notify({
        kind: failures > 0 ? 'info' : 'success',
        text: `Sync completo — ${processed} sesiones procesadas`,
        detail: failures > 0 ? `${failures} con error` : undefined,
      });
      void refetch();
    } catch (err) {
      notify({ kind: 'error', text: 'Sync falló', detail: (err as Error).message });
    } finally {
      setSyncBusy(false);
      setSyncVideoInput('');
    }
  };

  const handleSyncWithVideoIds = () => {
    const ids = syncVideoInput
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) {
      notify({ kind: 'info', text: 'Ingresá al menos un videoId' });
      return;
    }
    void handleSync(ids);
  };

  return (
    <>
      <SectionHeader
        eyebrow="Operación · Cola de revisión · Transcripciones"
        actions={
          <>
            <ActionButton
              variant="ghost"
              icon={SlidersHorizontal}
              onClick={() => {
                const next = STATUS_OPTIONS[(STATUS_OPTIONS.findIndex((o) => o.id === statusFilter) + 1) % STATUS_OPTIONS.length];
                setStatusFilter(next?.id ?? 'all');
              }}
            >
              {STATUS_OPTIONS.find((o) => o.id === statusFilter)?.label ?? 'Todos'}
            </ActionButton>
            <ActionButton
              variant="coral"
              icon={syncBusy ? Loader2 : RefreshCw}
              onClick={() => void handleSync()}
              disabled={syncBusy}
            >
              {syncBusy ? 'Sincronizando…' : 'Sincronizar ahora'}
            </ActionButton>
          </>
        }
      />

      {/* Toolbar row: video-specific sync + stats */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <input
            type="text"
            value={syncVideoInput}
            onChange={(e) => setSyncVideoInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleSyncWithVideoIds();
            }}
            placeholder="ID de video de YouTube: dQw4w9WgXcQ, ..."
            className="h-9 min-w-0 flex-1 rounded-lg border border-[#0e1745]/[0.10] dark:border-white/10 bg-white dark:bg-white/[0.05] px-3 font-mono text-[12px] text-[#0e1745] dark:text-white placeholder:text-[#0e1745]/40 dark:placeholder:text-white/40 outline-none focus:border-cl2-accent/40 focus:ring-2 focus:ring-cl2-accent/15"
          />
          <ActionButton
            variant="ghost"
            onClick={handleSyncWithVideoIds}
            disabled={syncBusy || !syncVideoInput.trim()}
          >
            Sincronizar IDs
          </ActionButton>
        </div>

        {/* Stats pills */}
        <div className="flex items-center gap-2 text-[11.5px] text-[#0e1745]/55 dark:text-white/55">
          <span>
            <strong className="text-[#0e1745] dark:text-white tabular-nums">{total}</strong>{' '}
            sesiones
          </span>
          {pendingCount > 0 && (
            <>
              <span>·</span>
              <span className="font-semibold text-amber-600 dark:text-amber-400">
                {pendingCount} sin revisar
              </span>
            </>
          )}
        </div>

        {/* Filter tabs */}
        <div className="flex gap-1">
          {STATUS_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => setStatusFilter(opt.id)}
              className={`rounded-full px-3 py-1.5 text-[11.5px] font-medium transition-colors ${
                statusFilter === opt.id
                  ? 'bg-[#0e1745]/[0.08] dark:bg-white/[0.10] text-[#0e1745] dark:text-white font-semibold'
                  : 'bg-transparent text-[#0e1745]/60 dark:text-white/60 hover:bg-[#0e1745]/[0.04] dark:hover:bg-white/[0.04]'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Error state */}
      {error && (
        <Card className="mb-4">
          <div className="flex items-center gap-2.5 px-[18px] py-3 text-[12.5px] text-rose-700 dark:text-rose-300">
            <AlertCircle size={14} />
            <span>No se pudo cargar las sesiones: <strong>{error}</strong></span>
            <ActionButton variant="quiet" onClick={() => void refetch()}>
              Reintentar
            </ActionButton>
          </div>
        </Card>
      )}

      {/* Loading state */}
      {loading && !data && (
        <div className="flex items-center justify-center gap-2 py-16 text-[12.5px] text-[#0e1745]/50 dark:text-white/50">
          <Loader2 size={15} className="animate-spin" />
          Cargando sesiones…
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && sessions.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-[#0e1745]/15 dark:border-white/15 bg-white/40 dark:bg-white/[0.02] px-6 py-12 text-center">
          <Inbox size={28} strokeWidth={1.5} className="text-[#0e1745]/40 dark:text-white/40" />
          <div className="font-display text-[18px] text-[#0e1745] dark:text-white">
            Sin sesiones
          </div>
          <div className="max-w-md text-[12.5px] leading-relaxed text-[#0e1745]/60 dark:text-white/60">
            {statusFilter !== 'all'
              ? `No hay sesiones con estado "${statusFilter}". Probá con otro filtro.`
              : 'No hay sesiones en cola aún. Tocá "Sincronizar ahora" para buscar videos nuevos del canal.'}
          </div>
          <ActionButton
            variant="coral"
            icon={RefreshCw}
            onClick={() => void handleSync()}
            disabled={syncBusy}
          >
            Sincronizar ahora
          </ActionButton>
        </div>
      )}

      {/* Sessions table */}
      {sessions.length > 0 && (
        <Card>
          <CardHeader
            title={
              <span className="inline-flex items-center gap-1.5">
                <Video size={13} /> Sesiones · {total.toLocaleString('es-CR')}
                {statusFilter !== 'all' && (
                  <span className="font-mono text-[10.5px] font-normal text-[#0e1745]/50 dark:text-white/50">
                    · filtro: {statusFilter}
                  </span>
                )}
              </span>
            }
            meta={
              loading ? (
                <Loader2 size={11} className="animate-spin text-[#0e1745]/40 dark:text-white/40" />
              ) : undefined
            }
          />
          <AdminTable<TranscriptSessionListItem>
            rowKey={(r) => r.id}
            rows={sessions}
            onRowClick={(r) => navigate(`/admin/transcripts/${r.id}`)}
            columns={[
              {
                header: 'Título',
                cell: (r) => (
                  <div className="flex flex-col gap-0.5">
                    <span className="font-semibold text-[#0e1745] dark:text-white line-clamp-1">
                      {r.title}
                    </span>
                    {r.comision && (
                      <span className="text-[11px] text-[#0e1745]/50 dark:text-white/50">
                        {r.comision}
                      </span>
                    )}
                  </div>
                ),
              },
              {
                header: 'Fuente',
                width: '90px',
                cell: (r) => (
                  <div className="flex items-center gap-1.5">
                    {r.source === 'youtube' ? (
                      <Video size={11} className="text-rose-500 shrink-0" />
                    ) : null}
                    <span className="font-mono text-[11px] text-[#0e1745]/70 dark:text-white/70">
                      {r.source}
                    </span>
                  </div>
                ),
              },
              {
                header: 'Estado',
                width: '120px',
                cell: (r) => (
                  <div className="flex items-center gap-1.5">
                    {statusIcon(r.status)}
                    {statusPill(r.status)}
                  </div>
                ),
              },
              {
                header: 'Segmentos',
                width: '90px',
                align: 'right',
                cell: (r) => (
                  <span className="font-mono tabular-nums text-[12px]">
                    {r.segments_count > 0 ? formatNumber(r.segments_count) : '—'}
                  </span>
                ),
              },
              {
                header: 'Correcciones',
                width: '110px',
                align: 'right',
                cell: (r) => (
                  <div className="flex items-center justify-end gap-1.5">
                    <span className="font-mono tabular-nums text-[12px]">
                      {r.corrections_count > 0 ? formatNumber(r.corrections_count) : '—'}
                    </span>
                    {r.corrections_pending > 0 && (
                      <Pill kind="warn">{r.corrections_pending} pend.</Pill>
                    )}
                  </div>
                ),
              },
              {
                header: 'Revisado',
                width: '110px',
                cell: (r) => (
                  <span className="text-[11.5px] text-[#0e1745]/60 dark:text-white/60">
                    {formatRelative(r.llm_reviewed_at)}
                  </span>
                ),
              },
              {
                header: '',
                width: '36px',
                cell: () => (
                  <ChevronRight
                    size={14}
                    className="text-[#0e1745]/30 dark:text-white/30 group-hover:text-cl2-accent"
                  />
                ),
              },
            ]}
          />
        </Card>
      )}
    </>
  );
}
