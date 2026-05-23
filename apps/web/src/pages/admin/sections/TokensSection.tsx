/**
 * Tokens — contador certero por usuario (Supabase Auth).
 *
 * Lee /api/admin/tokens/by-user. Devuelve un row por user con costo
 * USD estimado + tokens + última actividad. Click en una row expande
 * el desglose por modelo.
 *
 * Source: ai_call_log (migration 0017 + 0048). Coverage actual:
 *   - Vertex Gemini (transcripciones de video)
 *   - Cerebro invoke (non-stream LLM batch)
 *   - Workspace transforms
 *   - Voice STT/TTS
 *   El chat SSE principal no aparece todavía — esos counters los loggea
 *   Cerebro en su propia DB. Ver `_NoStreamWarning_`.
 */
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, RefreshCw, DollarSign, Cpu } from 'lucide-react';
import { ActionButton, Card, KPI, Pill, SectionHeader } from '../primitives';
import { supabase } from '@/lib/supabase';

interface UserUsage {
  user_id: string;
  call_count: number;
  tokens_in_sum: number;
  tokens_out_sum: number;
  tokens_total_sum: number;
  cache_read_sum: number;
  cache_create_sum: number;
  cost_usd_sum: number;
  last_call_at: string | null;
  first_call_at: string | null;
  active_days: number;
  models_used: number;
  errors_count: number;
  email?: string;
  full_name?: string;
}

interface UsageDetail {
  call_count: number;
  tokens_in_sum: number;
  tokens_out_sum: number;
  cache_read_sum: number;
  cache_create_sum: number;
  cost_usd_sum: number;
  by_model: Array<{
    provider: string;
    model: string;
    call_count: number;
    tokens_total: number;
    cost_usd: number;
  }>;
}

const NUM = new Intl.NumberFormat('es-CR');

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatCost(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'recién';
  if (min < 60) return `hace ${min}min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `hace ${hr}h`;
  const days = Math.floor(hr / 24);
  return `hace ${days}d`;
}

export function TokensSection(): React.ReactElement {
  const [rows, setRows] = useState<UserUsage[] | null>(null);
  const [windowDays, setWindowDays] = useState(30);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, UsageDetail>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const res = await fetch(`/api/admin/tokens/by-user?window_days=${windowDays}&limit=200`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? 'falló /tokens/by-user');
      setRows(data.items ?? []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const loadDetail = async (userId: string) => {
    if (details[userId]) return;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const res = await fetch(`/api/admin/tokens/by-user/${userId}?window_days=${windowDays}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data = await res.json();
      if (data.ok && data.detail) {
        setDetails((d) => ({ ...d, [userId]: data.detail as UsageDetail }));
      }
    } catch {
      // ignore — la row sigue colapsable
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowDays]);

  const totalCost = (rows ?? []).reduce((acc, r) => acc + (r.cost_usd_sum ?? 0), 0);
  const totalCalls = (rows ?? []).reduce((acc, r) => acc + r.call_count, 0);
  const totalTokens = (rows ?? []).reduce((acc, r) => acc + r.tokens_total_sum, 0);

  return (
    <>
      <SectionHeader
        eyebrow={`Acceso · Tokens (últimos ${windowDays} días)`}
        actions={
          <>
            <div className="inline-flex overflow-hidden rounded-lg border border-[#0e1745]/[0.10] dark:border-white/10">
              {[7, 30, 90].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setWindowDays(d)}
                  className={
                    'px-2.5 py-1.5 text-[11.5px] font-medium transition-colors ' +
                    (windowDays === d
                      ? 'bg-[#0e1745] text-white dark:bg-white dark:text-[#0e1745]'
                      : 'bg-transparent text-[#0e1745]/65 dark:text-white/65 hover:bg-[#0e1745]/[0.04] dark:hover:bg-white/[0.04]')
                  }
                >
                  {d}d
                </button>
              ))}
            </div>
            <ActionButton variant="ghost" icon={RefreshCw} onClick={() => void load()}>
              Recargar
            </ActionButton>
          </>
        }
      />

      <div className="mb-5 grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        <KPI label="Costo USD estimado" value={formatCost(totalCost)} delta={`${windowDays}d`} deltaDir="flat" />
        <KPI label="Usuarios con actividad" value={String(rows?.length ?? 0)} delta="distintos" deltaDir="flat" />
        <KPI label="Llamadas LLM" value={NUM.format(totalCalls)} delta="total" deltaDir="flat" />
        <KPI label="Tokens" value={formatTokens(totalTokens)} delta="in+out" deltaDir="flat" />
      </div>

      <Card>
        <div className="px-[18px] py-3 border-b border-[#0e1745]/[0.06] dark:border-white/[0.06]">
          <div className="text-[11px] text-[#0e1745]/55 dark:text-white/55 leading-relaxed">
            Source: <code className="font-mono">ai_call_log</code>. Cobertura actual: Vertex Gemini (transcripciones) + Cerebro invoke (batch) + workspace transforms + voice. <strong>El chat SSE no figura</strong> — esos counters viven en el lado Cerebro y se agregan via reconciliación post-deploy. Costo USD calculado con pricing table de <code className="font-mono">tokenAccounting.ts</code>.
          </div>
        </div>
        {error && (
          <div className="px-[18px] py-3 text-[12.5px] text-rose-700 dark:text-rose-300">
            Error: {error}
          </div>
        )}
        {loading && rows === null ? (
          <div className="px-[18px] py-6 text-center text-[12.5px] text-[#0e1745]/55 dark:text-white/55">
            Cargando…
          </div>
        ) : !rows || rows.length === 0 ? (
          <div className="px-[18px] py-6 text-center text-[12.5px] text-[#0e1745]/55 dark:text-white/55">
            Sin llamadas LLM registradas en la ventana.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead className="bg-[#0e1745]/[0.04] dark:bg-white/[0.04]">
                <tr className="text-left">
                  <th className="px-3 py-2 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[#0e1745]/60 dark:text-white/60" />
                  <th className="px-3 py-2 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[#0e1745]/60 dark:text-white/60">Usuario</th>
                  <th className="px-3 py-2 text-right text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[#0e1745]/60 dark:text-white/60">Costo USD</th>
                  <th className="px-3 py-2 text-right text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[#0e1745]/60 dark:text-white/60">Llamadas</th>
                  <th className="px-3 py-2 text-right text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[#0e1745]/60 dark:text-white/60">Tokens</th>
                  <th className="px-3 py-2 text-right text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[#0e1745]/60 dark:text-white/60">Cache hit</th>
                  <th className="px-3 py-2 text-right text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[#0e1745]/60 dark:text-white/60">Modelos</th>
                  <th className="px-3 py-2 text-right text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[#0e1745]/60 dark:text-white/60">Errores</th>
                  <th className="px-3 py-2 text-right text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[#0e1745]/60 dark:text-white/60">Última</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#0e1745]/[0.04] dark:divide-white/[0.04]">
                {rows.map((r) => {
                  const isOpen = expanded === r.user_id;
                  return (
                    <>
                      <tr
                        key={r.user_id}
                        className="cursor-pointer hover:bg-[#0e1745]/[0.02] dark:hover:bg-white/[0.02]"
                        onClick={() => {
                          const next = isOpen ? null : r.user_id;
                          setExpanded(next);
                          if (next) void loadDetail(r.user_id);
                        }}
                      >
                        <td className="px-3 py-2.5 w-6">
                          {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="font-semibold text-[#0e1745] dark:text-white">
                            {r.full_name ?? r.email?.split('@')[0] ?? r.user_id.slice(0, 8)}
                          </div>
                          <div className="text-[11px] text-[#0e1745]/55 dark:text-white/55 font-mono">
                            {r.email ?? r.user_id.slice(0, 18)}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono font-semibold tabular-nums">
                          {formatCost(r.cost_usd_sum ?? 0)}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{NUM.format(r.call_count)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{formatTokens(r.tokens_total_sum)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          {r.cache_read_sum > 0 ? (
                            <span className="text-emerald-600 dark:text-emerald-400">{formatTokens(r.cache_read_sum)}</span>
                          ) : (
                            <span className="text-[#0e1745]/30 dark:text-white/30">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{r.models_used}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          {r.errors_count > 0 ? (
                            <Pill kind="danger">{r.errors_count}</Pill>
                          ) : (
                            <span className="text-[#0e1745]/30 dark:text-white/30">0</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right text-[11.5px] text-[#0e1745]/55 dark:text-white/55">
                          {formatRelative(r.last_call_at)}
                        </td>
                      </tr>
                      {isOpen && details[r.user_id] && (
                        <tr className="bg-[#0e1745]/[0.02] dark:bg-white/[0.02]">
                          <td />
                          <td colSpan={8} className="px-3 py-3">
                            <div className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[#0e1745]/55 dark:text-white/55 mb-2">
                              Desglose por modelo
                            </div>
                            <table className="w-full text-[11.5px]">
                              <thead>
                                <tr className="text-left text-[#0e1745]/45 dark:text-white/45">
                                  <th className="py-1">Provider</th>
                                  <th className="py-1">Modelo</th>
                                  <th className="py-1 text-right">Llamadas</th>
                                  <th className="py-1 text-right">Tokens</th>
                                  <th className="py-1 text-right">Costo USD</th>
                                </tr>
                              </thead>
                              <tbody>
                                {details[r.user_id].by_model.map((m, i) => (
                                  <tr key={`${m.provider}-${m.model}-${i}`}>
                                    <td className="py-1">
                                      <Pill kind="neutral">{m.provider}</Pill>
                                    </td>
                                    <td className="py-1 font-mono text-[11px]">{m.model}</td>
                                    <td className="py-1 text-right tabular-nums">{NUM.format(m.call_count)}</td>
                                    <td className="py-1 text-right tabular-nums">{formatTokens(m.tokens_total)}</td>
                                    <td className="py-1 text-right font-mono tabular-nums">{formatCost(m.cost_usd)}</td>
                                  </tr>
                                ))}
                                {details[r.user_id].by_model.length === 0 && (
                                  <tr>
                                    <td colSpan={5} className="py-2 text-center text-[#0e1745]/45 dark:text-white/45">
                                      Sin desglose por modelo (calls antiguos sin column model).
                                    </td>
                                  </tr>
                                )}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
