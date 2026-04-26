/**
 * Transcripciones — moderation queue (the user's primary ask).
 *
 * Three-column layout:
 *   • [tabs] Pendientes / En proceso / Aprobadas / Rechazadas (counts).
 *   • [list] Pending transcriptions with confidence + flagged-segments
 *     hint. Click a row → loads detail in the right pane.
 *   • [detail] Video preview placeholder + diarization speaker bars +
 *     segment list with per-line confidence + final approve/reject.
 *
 * Backend: /api/admin/transcripciones (mock today). Approve/reject hits
 * /transcripciones/:id/review which echoes back. The optimistic update
 * removes the row from the list locally — the next /transcripciones
 * refresh will resync from the server when we have a real backend.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Filter,
  Flag,
  ShieldCheck,
  ExternalLink,
  Pencil,
  MessageSquareWarning,
  CheckCircle2,
  XCircle,
  Eye,
  Play,
  Loader2,
  Inbox,
} from 'lucide-react';
import {
  ActionButton,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Pill,
  SectionHeader,
  Tabs,
  Toggle,
} from '../primitives';
import {
  fetchTranscripciones,
  fetchTranscripcionDetail,
  reviewTranscripcion,
  fetchFlags,
  patchFlag,
  type TranscriptionItem,
  type TranscriptionDetail,
  useAdminFetch,
} from '@/services/adminApi';
import { useToast } from '../Toast';

type TabId = 'pending' | 'in_progress' | 'approved' | 'rejected';

export function TranscripcionesSection(): React.ReactElement {
  const { notify } = useToast();
  const [tab, setTab] = useState<TabId>('pending');
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TranscriptionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [autoApproveBusy, setAutoApproveBusy] = useState(false);
  const queue = useAdminFetch(fetchTranscripciones);
  const flags = useAdminFetch(fetchFlags);

  // Auto-approve > 95% threshold lives in feature_flags as a boolean.
  // When ON, pending rows with confidence >= 95 will be auto-approved
  // server-side as soon as the legacy worker pushes them. UI just
  // reflects the persisted toggle.
  const autoApproveOn = (() => {
    const v = flags.data?.flags['auto_approve_high_confidence'];
    return v === true || v === 'true';
  })();

  const onAutoApproveToggle = async (next: boolean) => {
    setAutoApproveBusy(true);
    try {
      await patchFlag('auto_approve_high_confidence', next);
      notify({
        kind: 'success',
        text: next ? 'Auto-aprobar > 95% activado' : 'Auto-aprobar pausado',
        detail: next
          ? 'Las transcripciones nuevas con confianza ≥95% se aprueban sin revisión humana.'
          : 'Todas las transcripciones nuevas pasan por la cola.',
      });
      void flags.refetch();
    } catch (err) {
      notify({ kind: 'error', text: 'No se pudo guardar', detail: (err as Error).message });
    } finally {
      setAutoApproveBusy(false);
    }
  };

  // Sort the visible queue: lowest confidence first ("riesgosos arriba").
  const visibleItems = useMemo(() => {
    const items = queue.data?.items ?? [];
    return [...items]
      .filter((it) => (tab === 'pending' ? it.status === 'pending' : it.status === tab))
      .sort((a, b) => a.confidence - b.confidence);
  }, [queue.data?.items, tab]);

  // Auto-select the first row whenever the visible list changes.
  useEffect(() => {
    if (!openId && visibleItems.length > 0) setOpenId(visibleItems[0].id);
    if (openId && !visibleItems.find((v) => v.id === openId) && visibleItems[0]) {
      setOpenId(visibleItems[0].id);
    }
  }, [visibleItems, openId]);

  // Load detail when the open id changes.
  useEffect(() => {
    if (!openId) {
      setDetail(null);
      return;
    }
    let alive = true;
    setDetailLoading(true);
    fetchTranscripcionDetail(openId)
      .then((env) => {
        if (alive) setDetail(env.data);
      })
      .catch(() => {
        if (alive) setDetail(null);
      })
      .finally(() => {
        if (alive) setDetailLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [openId]);

  const handleAction = async (item: TranscriptionItem, action: 'approve' | 'reject') => {
    setBusy((s) => new Set(s).add(item.id));
    try {
      await reviewTranscripcion(item.id, action);
      // Optimistic remove — refetch ensures eventual consistency.
      const next = visibleItems.filter((v) => v.id !== item.id);
      setOpenId(next[0]?.id ?? null);
      notify({
        kind: 'success',
        text: action === 'approve' ? 'Transcripción aprobada' : 'Transcripción rechazada',
        detail: `#${item.id}`,
      });
      void queue.refetch();
    } catch (err) {
      notify({
        kind: 'error',
        text: `No se pudo ${action === 'approve' ? 'aprobar' : 'rechazar'}`,
        detail: (err as Error).message,
      });
    } finally {
      setBusy((s) => {
        const out = new Set(s);
        out.delete(item.id);
        return out;
      });
    }
  };

  const counts = queue.data?.counts ?? { pending: 0, in_progress: 0, approved: 0, rejected: 0 };

  return (
    <>
      <SectionHeader
        eyebrow="Operación · Aprobación de transcripciones"
        actions={
          <>
            <span
              className="inline-flex items-center gap-2 rounded-full border border-[#0e1745]/[0.08] dark:border-white/[0.10] bg-white dark:bg-white/[0.05] px-3 py-1.5 text-[12px] text-[#0e1745]/60 dark:text-white/60"
              title={
                flags.loading
                  ? 'Cargando flag…'
                  : 'Persiste en feature_flags.auto_approve_high_confidence'
              }
            >
              <span className="font-semibold text-[#0e1745] dark:text-white">
                Auto-aprobar &gt; 95%
              </span>
              <Toggle
                on={autoApproveOn}
                onChange={(next) => void onAutoApproveToggle(next)}
                label="Auto-aprobar transcripciones de alta confianza"
              />
              {autoApproveBusy && <span className="text-[10.5px] opacity-60">guardando…</span>}
            </span>
            <ActionButton
              variant="ghost"
              icon={Filter}
              onClick={() => {
                const order: TabId[] = ['pending', 'in_progress', 'approved', 'rejected'];
                const next = order[(order.indexOf(tab) + 1) % order.length]!;
                setTab(next);
                notify({ kind: 'info', text: `Filtro: ${next}` });
              }}
            >
              Filtro: {tab}
            </ActionButton>
          </>
        }
      />

      <div className="mb-4 flex items-center gap-3">
        <Tabs<TabId>
          options={[
            { id: 'pending',     label: <>Pendientes <span className="ml-1 text-[10.5px] tabular-nums opacity-60">{counts.pending}</span></> },
            { id: 'in_progress', label: <>En proceso <span className="ml-1 text-[10.5px] tabular-nums opacity-60">{counts.in_progress}</span></> },
            { id: 'approved',    label: <>Aprobadas  <span className="ml-1 text-[10.5px] tabular-nums opacity-60">{counts.approved}</span></> },
            { id: 'rejected',    label: <>Rechazadas <span className="ml-1 text-[10.5px] tabular-nums opacity-60">{counts.rejected}</span></> },
          ]}
          active={tab}
          onChange={setTab}
        />
        <span className="text-[11.5px] text-[#0e1745]/50 dark:text-white/50">
          · Ordenado por confianza ↑ · los riesgosos arriba
        </span>
        {queue.isMock && (
          <Pill kind="warn" className="ml-auto">
            Datos de demostración
          </Pill>
        )}
      </div>

      {visibleItems.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="Sin transcripciones en esta cola"
          description="Cuando Whisper transcriba una sesión, aparecerá acá para que la apruebes antes de que sea visible al usuario y citable por Lexa."
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[2fr_3fr] gap-4">
          {/* List column */}
          <Card>
            <CardHeader
              title={`Pendientes — ${visibleItems.length}`}
              meta={
                <>
                  <span className="inline-block h-[7px] w-[7px] rounded-full bg-[#f59e0b] shadow-[0_0_0_3px_rgba(245,158,11,0.14)]" />{' '}
                  {visibleItems.filter((v) => v.confidence < 80).length} con confianza &lt; 80%
                </>
              }
            />
            <div>
              {visibleItems.map((it) => {
                const isOpen = it.id === openId;
                return (
                  <button
                    key={it.id}
                    type="button"
                    onClick={() => setOpenId(it.id)}
                    className={`flex w-full cursor-pointer flex-col gap-1.5 border-l-2 border-t border-[#0e1745]/[0.05] dark:border-white/[0.05] bg-transparent px-4 py-3 text-left first:border-t-0 hover:bg-[#0e1745]/[0.015] dark:hover:bg-white/[0.04] ${
                      isOpen
                        ? 'border-l-cl2-accent bg-cl2-accent/[0.06] dark:bg-cl2-accent/[0.10]'
                        : 'border-l-transparent'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[11px] text-[#0e1745]/50 dark:text-white/50">
                        #{it.id.split('-')[1]}
                      </span>
                      <span className="flex-1 text-[13px] font-semibold text-[#0e1745] dark:text-white">
                        {it.sesion_label}
                      </span>
                      {it.status === 'approved' ? (
                        <Pill kind="success">Aprobada</Pill>
                      ) : it.status === 'rejected' ? (
                        <Pill kind="danger">Rechazada</Pill>
                      ) : (
                        <Pill
                          kind={
                            it.confidence > 90 ? 'success' : it.confidence > 80 ? 'info' : 'warn'
                          }
                        >
                          {it.confidence}%
                        </Pill>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-[11.5px] text-[#0e1745]/55 dark:text-white/55">
                      <span className="font-mono">{it.expediente ?? '—'}</span>
                      <span>·</span>
                      <span>{formatDate(it.date)}</span>
                      <span>·</span>
                      <span>{formatDuration(it.duration_seconds)}</span>
                    </div>
                    {it.flagged_segments > 0 && (
                      <div className="inline-flex items-center gap-1 text-[11px] text-[#b45309]">
                        <Flag size={11} strokeWidth={2.2} /> {it.flagged_segments} segmento
                        {it.flagged_segments > 1 ? 's' : ''} marcado
                        {it.flagged_segments > 1 ? 's' : ''}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </Card>

          {/* Detail column */}
          <div className="flex flex-col gap-4">
            {detailLoading ? (
              <Card>
                <CardBody className="flex items-center justify-center gap-2 py-12 text-[#0e1745]/50 dark:text-white/50">
                  <Loader2 size={16} className="animate-spin" /> Cargando detalle…
                </CardBody>
              </Card>
            ) : !detail ? (
              <Card>
                <CardBody className="text-center text-[12.5px] text-[#0e1745]/55 dark:text-white/55">
                  Seleccioná una transcripción para revisarla.
                </CardBody>
              </Card>
            ) : (
              <DetailPane
                detail={detail}
                isBusy={busy.has(detail.item.id)}
                onApprove={() => void handleAction(detail.item, 'approve')}
                onReject={() => void handleAction(detail.item, 'reject')}
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}

interface DetailPaneProps {
  detail: TranscriptionDetail;
  isBusy: boolean;
  onApprove: () => void;
  onReject: () => void;
}

function DetailPane({ detail, isBusy, onApprove, onReject }: DetailPaneProps): React.ReactElement {
  const { notify } = useToast();
  const item = detail.item;
  return (
    <>
      <Card>
        <CardHeader
          title={
            <div className="flex flex-col">
              <span className="text-[11px] font-normal text-[#0e1745]/50 dark:text-white/50">
                {item.sesion_label} · {item.expediente ?? '—'}
              </span>
              <span className="font-display text-[18px] font-normal tracking-tight">
                {item.status === 'approved'
                  ? 'Transcripción publicada'
                  : item.status === 'rejected'
                    ? 'Transcripción descartada'
                    : 'Revisión de transcripción'}{' '}
                <span className="font-mono text-[12px] font-normal text-[#0e1745]/50 dark:text-white/50">
                  #{item.id}
                </span>
              </span>
            </div>
          }
          meta={
            <span className="flex items-center gap-1.5">
              <Pill kind="lexa">⚖️ Lexa</Pill>
              {item.status === 'approved' && (
                <Pill kind="success" icon={CheckCircle2}>
                  Aprobada — visible
                </Pill>
              )}
              {item.status === 'rejected' && (
                <Pill kind="danger" icon={XCircle}>
                  Rechazada
                </Pill>
              )}
              {item.status === 'pending' && (
                <Pill kind={item.confidence > 90 ? 'success' : 'warn'} icon={ShieldCheck}>
                  Confianza {item.confidence}%
                </Pill>
              )}
            </span>
          }
        />
        <CardBody className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1.1fr]">
          {/* Video + diarization */}
          <div>
            <div
              className="relative overflow-hidden rounded-[10px] shadow-[0_4px_18px_rgba(0,0,0,0.18)]"
              style={{ aspectRatio: '16 / 9', background: '#0a0a0a' }}
            >
              <div className="absolute inset-0 flex items-center justify-center text-white/70">
                <Play size={28} color="rgba(255,255,255,0.85)" />
              </div>
              <div className="absolute bottom-2.5 left-2.5 font-mono text-[10.5px] text-white/85">
                {item.excerpt_ts} / {formatDuration(item.duration_seconds)}
              </div>
              <div className="absolute right-2.5 top-2.5 inline-flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[10px] text-white">
                {item.status === 'approved' ? (
                  <>
                    <span className="inline-block h-[7px] w-[7px] rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.20)]" />
                    Publicada
                  </>
                ) : item.status === 'rejected' ? (
                  <>
                    <span className="inline-block h-[7px] w-[7px] rounded-full bg-rose-500 shadow-[0_0_0_3px_rgba(239,68,68,0.20)]" />
                    Descartada
                  </>
                ) : (
                  <>
                    <span className="inline-block h-[7px] w-[7px] rounded-full bg-amber-500 shadow-[0_0_0_3px_rgba(245,158,11,0.20)]" />
                    En revisión
                  </>
                )}
              </div>
            </div>
            <div className="mt-2.5 flex justify-between text-[11.5px] text-[#0e1745]/55 dark:text-white/55">
              <span>{item.source}</span>
              <span>
                {detail.total_segments.toLocaleString('es-CR')} segmentos ·{' '}
                {detail.total_words.toLocaleString('es-CR')} palabras
              </span>
            </div>

            <div className="mt-3.5 rounded-lg border border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-[#0e1745]/[0.03] dark:bg-white/[0.04] px-3 py-2.5">
              <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.16em] text-[#0e1745]/50 dark:text-white/50">
                Diarización
              </div>
              <div className="flex flex-col gap-1 text-[12px]">
                {detail.diarization.map((s, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span
                      className="inline-block h-2 w-2 shrink-0 rounded-sm"
                      style={{ background: s.color }}
                    />
                    <span className="flex-1 text-[#0e1745] dark:text-white">{s.speaker}</span>
                    <span className="font-mono text-[11px] text-[#0e1745]/55 dark:text-white/55">
                      {formatDuration(s.total_seconds)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Segments list */}
          <div>
            <div className="mb-2.5 flex items-center justify-between">
              <div className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-[#0e1745]/50 dark:text-white/50">
                Segmentos del extracto
              </div>
              <ActionButton
                variant="quiet"
                icon={ExternalLink}
                onClick={() =>
                  notify({
                    kind: 'info',
                    text: 'Editor segment-by-segment vendrá en una iteración próxima.',
                    detail: 'Por ahora editá el JSON en el bucket de transcripciones y volvé a transcribir.',
                  })
                }
              >
                Abrir editor
              </ActionButton>
            </div>
            <div className="border-t border-[#0e1745]/[0.06] dark:border-white/[0.06]">
              {detail.segments.map((l, i) => (
                <div
                  key={i}
                  className={`grid items-baseline gap-2.5 border-b border-dashed border-[#0e1745]/[0.06] dark:border-white/[0.06] py-1.5 text-[12.5px] last:border-b-0 ${
                    l.flagged ? 'rounded bg-[rgba(245,158,11,0.06)] px-2' : ''
                  } ${l.highlighted ? 'rounded bg-[rgba(122,59,71,0.06)] px-2 border-b-0' : ''}`}
                  style={{ gridTemplateColumns: '60px 110px 1fr' }}
                >
                  <span className="font-mono text-[11px] font-semibold text-cl2-burgundy dark:text-[#d8a4ad]">{l.ts}</span>
                  <span
                    className={`text-[11.5px] font-semibold ${
                      l.flagged ? 'text-[#b45309]' : 'text-[#0e1745]/70 dark:text-white/70'
                    }`}
                  >
                    {l.speaker}
                  </span>
                  <div>
                    <span className="leading-relaxed text-[#0e1745] dark:text-white">{l.text}</span>
                    <span
                      className="ml-2 font-mono text-[10px]"
                      style={{
                        color:
                          l.confidence < 70
                            ? '#b91c1c'
                            : l.confidence < 90
                              ? '#b45309'
                              : 'rgba(14,23,69,0.4)',
                      }}
                    >
                      {l.confidence}%
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {detail.segments.some((s) => s.flagged) && (
              <div className="mt-3.5 rounded-lg border border-dashed border-[rgba(245,158,11,0.4)] bg-[rgba(245,158,11,0.05)] px-3 py-2.5 text-[12px] text-[#92400e]">
                <strong className="font-semibold">
                  {detail.segments.filter((s) => s.flagged).length} segmento
                  {detail.segments.filter((s) => s.flagged).length > 1 ? 's' : ''} requiere
                  {detail.segments.filter((s) => s.flagged).length > 1 ? 'n' : ''} atención.
                </strong>{' '}
                Reasigná o marcá como inaudible antes de aprobar.
              </div>
            )}
          </div>
        </CardBody>

        {/* Footer actions */}
        <div className="flex flex-wrap items-center gap-2.5 rounded-b-xl border-t border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-[#0e1745]/[0.012] dark:bg-white/[0.02] px-[18px] py-3">
          {item.status === 'pending' ? (
            <>
              <ActionButton
                variant="quiet"
                icon={MessageSquareWarning}
                onClick={() =>
                  notify({
                    kind: 'info',
                    text: 'Mandando ping al canal #cl2-transcripts',
                    detail: 'En el demo el canal no está conectado; en prod va por Slack.',
                  })
                }
              >
                Pedir corrección a equipo
              </ActionButton>
              <ActionButton
                variant="quiet"
                icon={Pencil}
                onClick={() =>
                  notify({
                    kind: 'info',
                    text: 'Re-transcripción en cola',
                    detail: `${detail.item.id} marcado para re-correr Whisper en la próxima ventana.`,
                  })
                }
              >
                Editar y volver a transcribir
              </ActionButton>
              <span className="flex-1" />
              <ActionButton variant="reject" icon={XCircle} onClick={onReject} disabled={isBusy}>
                Rechazar — no publicar
              </ActionButton>
              <ActionButton variant="approve" icon={CheckCircle2} onClick={onApprove} disabled={isBusy}>
                Aprobar — visible al usuario
              </ActionButton>
            </>
          ) : (
            <>
              <div
                className={`flex items-center gap-2 text-[12.5px] font-semibold ${
                  item.status === 'approved'
                    ? 'text-emerald-700 dark:text-emerald-300'
                    : 'text-rose-700 dark:text-rose-300'
                }`}
              >
                {item.status === 'approved' ? (
                  <>
                    <CheckCircle2 size={14} strokeWidth={2} />
                    Aprobada y visible al usuario.
                  </>
                ) : (
                  <>
                    <XCircle size={14} strokeWidth={2} />
                    Descartada — no se publicó.
                  </>
                )}
              </div>
              <span className="flex-1" />
              <ActionButton
                variant="ghost"
                onClick={() =>
                  notify({
                    kind: 'info',
                    text: item.status === 'approved' ? 'Reabrir revisión' : 'Re-encolar',
                    detail: 'La acción de revertir decisión llega en una iteración próxima.',
                  })
                }
              >
                {item.status === 'approved' ? 'Reabrir revisión' : 'Volver a la cola'}
              </ActionButton>
            </>
          )}
        </div>
      </Card>

      {/* Where it'll appear */}
      <Card>
        <CardHeader
          title={
            <span className="inline-flex items-center gap-1.5">
              <Eye size={13} />{' '}
              {item.status === 'approved'
                ? 'Cómo se publicó'
                : item.status === 'rejected'
                  ? 'Cómo se hubiera publicado'
                  : 'Vista previa al aprobar'}
            </span>
          }
          meta={
            item.status === 'approved'
              ? 'Visible en el viewer de la sesión y citable por Lexa'
              : item.status === 'rejected'
                ? 'Sin publicar. Lexa no la cita.'
                : 'Visible en el viewer de la sesión y citable por Lexa al aprobar'
          }
        />
        <CardBody className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          <div className="rounded-[10px] border border-[rgba(122,59,71,0.16)] bg-[rgba(122,59,71,0.05)] p-3">
            <div className="mb-1.5 flex items-center gap-1.5">
              <Pill kind="lexa">⚖️ Lexa</Pill>
              <Pill kind="success" icon={ShieldCheck}>
                Cita verificable
              </Pill>
            </div>
            <div className="font-mono text-[11px] font-semibold text-cl2-burgundy dark:text-[#d8a4ad]">
              ▶ {item.excerpt_ts} · {item.speaker}
            </div>
            <div className="mt-1.5 italic leading-relaxed text-[13px] text-[#0e1745] dark:text-white">
              "{item.excerpt}"
            </div>
          </div>
          <div className="rounded-[10px] border border-[#0e1745]/[0.08] dark:border-white/[0.10] p-3 text-[12px] text-[#0e1745]/70 dark:text-white/70">
            <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.16em] text-[#0e1745]/50 dark:text-white/50">
              {item.status === 'approved' ? 'Lo que se publicó' : item.status === 'rejected' ? 'Lo que se hubiera publicado' : 'Al aprobar'}
            </div>
            <ul className="m-0 list-disc pl-4 leading-7">
              <li>
                Se publica la transcripción en la pestaña{' '}
                <strong>Transcripción</strong> de la sesión.
              </li>
              <li>
                Lexa puede citar segmentos como{' '}
                <span className="font-mono">
                  plenaria://{item.session_id ?? 'NXX'}#{item.excerpt_ts}
                </span>
                .
              </li>
              <li>Los chunks entran al índice RAG con embeddings v3.</li>
              <li>
                Se notifica a los usuarios con la sesión en favoritos.
              </li>
            </ul>
          </div>
        </CardBody>
      </Card>
    </>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-CR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function formatDuration(seconds: number): string {
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s.toString().padStart(2, '0')}s`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m.toString().padStart(2, '0')}m`;
}
