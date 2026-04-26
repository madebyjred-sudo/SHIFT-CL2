/**
 * Live demo chat for the public landing — Mac window chrome wrapping a
 * real conversation against the BFF's /api/public/demo-chat endpoint.
 *
 * Why a separate component (not the SPA's AnimatedAiInput): the real
 * chat is tightly coupled to ChatProvider, sessions, supabase auth, the
 * sidebar — none of which we want on a public marketing page. This is a
 * stripped-down sibling that streams the same chunk types, so visually
 * and behaviorally it's "literally our chat" — just without persistence
 * and with the 5-prompt demo cap baked in.
 *
 * Defense against abuse is split between client + server:
 *   - Server (publicDemo.ts): hard 5/IP/24h cap + global daily ceiling +
 *     prompt length + char-class filter + agent fixed to Lexa.
 *   - Client (this file): localStorage counter for UX so the user sees
 *     "2 de 5 restantes" without making a probe request, and the
 *     composer locks at 5 with a CTA. It's COSMETIC — the server is the
 *     source of truth, so wiping localStorage doesn't bypass the cap.
 */
import { useEffect, useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';

const DEMO_LIMIT = 5;
const COUNT_KEY = 'cl2.landing.demoCount';
const PROMPT_MAX = 600;

const SUGGESTED: string[] = [
  '¿Cómo se votó la última reforma a la Ley de Aguas?',
  'Argumentos del dictamen mayoría del expediente 23.918',
  'Plazo del dictamen de comisión según el Reglamento',
  'Qué dijo el diputado Calderón sobre el artículo 14',
];

interface DemoCitation {
  index: number;
  title: string;
  url?: string | null;
  source?: string | null;
  meta?: string | null;
}

interface Msg {
  role: 'user' | 'assistant';
  content: string;
  citations?: DemoCitation[];
  /** True only while a stream is open for this assistant message. */
  streaming?: boolean;
}

function readCount(): number {
  if (typeof localStorage === 'undefined') return 0;
  const v = Number.parseInt(localStorage.getItem(COUNT_KEY) ?? '0', 10);
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

function bumpCount(): number {
  const next = readCount() + 1;
  try {
    localStorage.setItem(COUNT_KEY, String(next));
  } catch { /* private mode etc. */ }
  return next;
}

/**
 * Parse an `[N]` cite reference from raw assistant text into a chip.
 * Matches the pattern emitted by Lexa via the search_transcripts tool —
 * the model sprinkles `[1]`, `[2]` inline; the BFF emits the source list
 * as a separate `citation` chunk.
 */
function renderWithCites(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const re = /\[(\d{1,2})\]/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIdx) parts.push(text.slice(lastIdx, m.index));
    parts.push(
      <span
        key={`c-${m.index}`}
        className="inline-flex items-center align-baseline mx-0.5 px-1.5 py-0.5 rounded-md bg-cl2-burgundy/[0.10] dark:bg-cl2-accent/[0.12] text-cl2-burgundy dark:text-cl2-accent-soft text-[10.5px] font-semibold tabular-nums border border-cl2-burgundy/20 dark:border-cl2-accent/20"
      >
        [{m[1]}]
      </span>,
    );
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts.length === 0 ? text : parts;
}

export function DemoChatFrame() {
  const [count, setCount] = useState<number>(() => readCount());
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const remaining = Math.max(0, DEMO_LIMIT - count);
  const blocked = remaining === 0 || streaming;
  const composerLocked = remaining === 0;

  // Auto-scroll on new tokens.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, streaming]);

  // Cleanup any in-flight stream on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  async function send(text?: string) {
    const q = (text ?? input).trim();
    if (!q || streaming) return;
    if (q.length > PROMPT_MAX) return;
    if (composerLocked) return;

    // Build the prior context to send to the BFF (last 4 turns each side
    // is plenty given the 5-message cap).
    const prior = messages
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.content }));

    setInput('');
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: q },
      { role: 'assistant', content: '', streaming: true },
    ]);
    setStreaming(true);
    abortRef.current = new AbortController();

    try {
      const res = await fetch('/api/public/demo-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, prior }),
        signal: abortRef.current.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let payload: { error?: string; message?: string } = {};
        try { payload = JSON.parse(text); } catch { /* not json */ }
        finalizeAssistantWithError(
          payload.message ?? `No se pudo conectar (HTTP ${res.status}).`,
        );
        return;
      }

      // Bump local counter eagerly — server has already burned the slot
      // by this point (see publicDemo.ts: count is incremented BEFORE
      // the model call to avoid a flaky-network exploit).
      setCount(bumpCount());

      await streamSse(res, (chunk) => {
        if (chunk.type === 'token' && typeof chunk.payload === 'string') {
          appendToken(chunk.payload);
        } else if (chunk.type === 'citation' && Array.isArray(chunk.payload)) {
          attachCitations(chunk.payload as DemoCitation[]);
        } else if (chunk.type === 'error') {
          const p = chunk.payload as { message?: string } | undefined;
          finalizeAssistantWithError(p?.message ?? 'Algo falló del lado nuestro.');
        }
      });
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        finalizeAssistantWithError(`Error: ${(err as Error).message}`);
      }
    } finally {
      setStreaming(false);
      finalizeStreaming();
      abortRef.current = null;
    }
  }

  function appendToken(token: string) {
    setMessages((prev) => {
      const next = prev.slice();
      const last = next[next.length - 1];
      if (last && last.role === 'assistant') {
        next[next.length - 1] = { ...last, content: last.content + token };
      }
      return next;
    });
  }

  function attachCitations(cites: DemoCitation[]) {
    setMessages((prev) => {
      const next = prev.slice();
      const last = next[next.length - 1];
      if (last && last.role === 'assistant') {
        next[next.length - 1] = { ...last, citations: cites };
      }
      return next;
    });
  }

  function finalizeStreaming() {
    setMessages((prev) => {
      const next = prev.slice();
      const last = next[next.length - 1];
      if (last && last.role === 'assistant' && last.streaming) {
        next[next.length - 1] = { ...last, streaming: false };
      }
      return next;
    });
  }

  function finalizeAssistantWithError(msg: string) {
    setMessages((prev) => {
      const next = prev.slice();
      const last = next[next.length - 1];
      if (last && last.role === 'assistant') {
        const prefix = last.content ? `${last.content}\n\n` : '';
        next[next.length - 1] = { ...last, content: `${prefix}_${msg}_`, streaming: false };
      }
      return next;
    });
  }

  // Latest assistant's citations drive the right panel.
  const latestAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const sources = latestAssistant?.citations ?? [];

  return (
    <div className="rounded-2xl bg-white dark:bg-[#231f1f] overflow-hidden border border-[#0e1745]/[0.08] dark:border-white/[0.06] shadow-[0_30px_80px_rgba(14,23,69,0.10),0_8px_24px_rgba(14,23,69,0.06)] dark:shadow-[0_30px_80px_rgba(0,0,0,0.40),0_8px_24px_rgba(0,0,0,0.20)]">
      {/* Mac chrome */}
      <div className="flex items-center gap-3 px-3.5 py-2.5 border-b border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-[#0e1745]/[0.02] dark:bg-white/[0.02]">
        <div className="flex gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-[#FF5F57]" />
          <span className="w-2.5 h-2.5 rounded-full bg-[#FEBC2E]" />
          <span className="w-2.5 h-2.5 rounded-full bg-[#28C840]" />
        </div>
        <div className="flex-1 text-center font-mono text-[10.5px] text-[#0e1745]/45 dark:text-white/45 tracking-wider truncate">
          agentescl2.com / demo pública · Lexa
        </div>
        <div className="w-[60px]" />
      </div>

      {/* Body */}
      <div className="grid min-h-[460px] md:min-h-[480px]" style={{ gridTemplateColumns: 'minmax(0,1fr) 240px' }}>
        {/* Center: conversation */}
        <div className="flex flex-col min-w-0 border-r border-[#0e1745]/[0.06] dark:border-white/[0.06]">
          <div className="px-5 md:px-6 py-3 border-b border-[#0e1745]/[0.05] dark:border-white/[0.05] flex items-center justify-between font-mono text-[11px] tracking-wider uppercase">
            <span className="flex items-center gap-2 truncate text-cl2-burgundy dark:text-cl2-accent-soft">
              <span
                className={cn(
                  'inline-block w-1.5 h-1.5 rounded-full',
                  blocked ? 'bg-[#0e1745]/30 dark:bg-white/30' : 'bg-cl2-accent animate-pulse',
                )}
              />
              cl2 · demo pública
            </span>
            <span
              className={cn(
                'text-[10.5px]',
                composerLocked
                  ? 'text-cl2-burgundy dark:text-cl2-accent-soft font-semibold'
                  : 'text-[#0e1745]/55 dark:text-white/55',
              )}
            >
              {composerLocked ? 'Límite alcanzado' : `${remaining} de ${DEMO_LIMIT} restantes`}
            </span>
          </div>

          <div
            ref={scrollRef}
            className="flex-1 px-5 sm:px-6 py-5 flex flex-col gap-4 overflow-y-auto"
            style={{ maxHeight: 460 }}
          >
            {messages.length === 0 && (
              <div>
                <div className="font-mono text-[10px] text-[#0e1745]/40 dark:text-white/40 uppercase tracking-wider mb-3">
                  Tocá una pregunta para empezar
                </div>
                <div className="flex flex-col gap-2">
                  {SUGGESTED.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => void send(s)}
                      disabled={blocked}
                      className="text-left bg-[#0e1745]/[0.025] dark:bg-white/[0.04] border border-[#0e1745]/[0.08] dark:border-white/[0.08] hover:border-cl2-burgundy/40 hover:bg-cl2-burgundy/[0.04] dark:hover:bg-cl2-accent/[0.08] rounded-[10px] px-3.5 py-2.5 text-[13px] text-[#0e1745] dark:text-white font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) =>
              m.role === 'user' ? (
                <div key={i} className="self-end max-w-[80%]">
                  <div
                    className="bg-[#0e1745] dark:bg-white/[0.10] text-white px-3.5 py-2.5 text-[13.5px] leading-relaxed"
                    style={{ borderRadius: '14px 14px 4px 14px' }}
                  >
                    {m.content}
                  </div>
                </div>
              ) : (
                <div key={i}>
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-cl2-burgundy dark:bg-[#d8a4ad]" />
                    <span className="font-mono text-[10px] text-[#0e1745]/45 dark:text-white/45 uppercase tracking-wider">
                      lexa
                      {m.streaming && <span className="ml-1 animate-pulse">· pensando</span>}
                      {!m.streaming && m.citations && m.citations.length > 0 && (
                        <span> · {m.citations.length} fuentes</span>
                      )}
                    </span>
                  </div>
                  <div className="text-[13.5px] leading-[1.65] text-[#0e1745] dark:text-white whitespace-pre-wrap">
                    {m.content === '' && m.streaming ? (
                      <span className="inline-flex gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-cl2-burgundy/60 dark:bg-[#d8a4ad]/60 animate-pulse" />
                        <span className="w-1.5 h-1.5 rounded-full bg-cl2-burgundy/60 dark:bg-[#d8a4ad]/60 animate-pulse [animation-delay:0.2s]" />
                        <span className="w-1.5 h-1.5 rounded-full bg-cl2-burgundy/60 dark:bg-[#d8a4ad]/60 animate-pulse [animation-delay:0.4s]" />
                      </span>
                    ) : (
                      renderWithCites(m.content)
                    )}
                  </div>
                </div>
              ),
            )}
          </div>

          {/* Blocked banner */}
          {composerLocked && (
            <div className="mx-4 mb-2 px-3.5 py-2.5 rounded-[10px] flex items-center justify-between gap-3 text-[12.5px] bg-cl2-burgundy/[0.08] dark:bg-cl2-accent/[0.10] border border-cl2-burgundy/20 dark:border-cl2-accent/30">
              <span className="text-[#0e1745]/85 dark:text-white/85">
                <span className="italic text-cl2-burgundy dark:text-cl2-accent-soft font-semibold">
                  Ya usaste tus 5 consultas.
                </span>{' '}
                La versión completa no tiene este límite.
              </span>
              <a
                href="#cta"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-cl2-accent hover:bg-cl2-accent-hover text-white text-[12px] font-semibold flex-shrink-0 transition-colors"
              >
                Solicitar acceso
                <ArrowRight size={12} />
              </a>
            </div>
          )}

          {/* Composer */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
            className="px-4 py-2.5 border-t border-[#0e1745]/[0.06] dark:border-white/[0.06] flex items-center gap-2.5 bg-[#0e1745]/[0.015] dark:bg-white/[0.02]"
          >
            <input
              value={input}
              maxLength={PROMPT_MAX}
              onChange={(e) => setInput(e.target.value)}
              disabled={blocked}
              placeholder={
                composerLocked
                  ? 'Demo agotada — solicitá acceso al piloto'
                  : streaming
                    ? 'Lexa está respondiendo…'
                    : 'Preguntá sobre un expediente, una comisión, un legislador…'
              }
              className="flex-1 bg-transparent border-none outline-none font-sans text-[13px] text-[#0e1745] dark:text-white py-1.5 placeholder:text-[#0e1745]/40 dark:placeholder:text-white/40 disabled:cursor-not-allowed"
            />
            {input.length > PROMPT_MAX * 0.85 && (
              <span className="font-mono text-[10px] text-[#0e1745]/45 dark:text-white/45 tabular-nums">
                {input.length}/{PROMPT_MAX}
              </span>
            )}
            <button
              type="submit"
              disabled={blocked || !input.trim()}
              aria-label="Enviar consulta"
              className={cn(
                'inline-flex items-center justify-center w-7 h-7 rounded-full text-white transition-colors',
                !input.trim() || blocked
                  ? 'bg-[#0e1745]/20 dark:bg-white/15 cursor-not-allowed'
                  : 'bg-cl2-accent hover:bg-cl2-accent-hover',
              )}
            >
              <ArrowRight size={13} />
            </button>
          </form>
        </div>

        {/* Right: dynamic source panel */}
        <aside className="hidden lg:flex p-4 flex-col gap-3 bg-cl2-burgundy/[0.025] dark:bg-cl2-burgundy/[0.06]">
          <div className="font-mono text-[10px] uppercase tracking-widest text-cl2-burgundy dark:text-[#d8a4ad] font-semibold">
            Fuentes citadas
          </div>
          {sources.length === 0 ? (
            <div className="text-[11.5px] text-[#0e1745]/55 dark:text-white/55 leading-snug py-4">
              Las fuentes aparecerán acá cuando Lexa cite. Sin cita, no hay respuesta.
            </div>
          ) : (
            sources.map((s) => (
              <div
                key={s.index}
                className="bg-white dark:bg-white/[0.04] rounded-lg p-3 flex flex-col gap-1 border border-cl2-burgundy/12 dark:border-[#d8a4ad]/15"
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10.5px] text-cl2-burgundy dark:text-[#d8a4ad] font-semibold">
                    [{s.index}]
                  </span>
                  {s.source && (
                    <span className="font-mono text-[9.5px] text-[#0e1745]/45 dark:text-white/45 uppercase tracking-wider">
                      {s.source}
                    </span>
                  )}
                </div>
                <div className="text-[11.5px] text-[#0e1745] dark:text-white/85 font-medium leading-tight line-clamp-2">
                  {s.title}
                </div>
                {s.meta && (
                  <div className="text-[10.5px] text-[#0e1745]/55 dark:text-white/55">{s.meta}</div>
                )}
              </div>
            ))
          )}
          <div className="mt-auto p-3 rounded-lg bg-[#0e1745]/[0.04] dark:bg-white/[0.03] text-[11px] text-[#0e1745]/65 dark:text-white/65 leading-snug">
            Cada cita lleva al folio o minuto exacto del archivo. Sin cita, sin respuesta.
          </div>
        </aside>
      </div>
    </div>
  );
}

// ─── SSE parser ──────────────────────────────────────────────────────

interface ServerChunk {
  type: string;
  payload?: unknown;
}

/**
 * Read the SSE body. The server emits one `data: {...}\n\n` per event.
 * We split on `\n\n` and JSON-parse each event, ignoring keep-alive
 * comments and partial lines that arrive across chunk boundaries.
 */
async function streamSse(res: Response, onChunk: (chunk: ServerChunk) => void): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('stream_unavailable');
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const event = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      // SSE event format: lines beginning with "data: " — concat their bodies.
      const lines = event.split('\n');
      const dataLines = lines
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''));
      if (dataLines.length === 0) continue;
      const raw = dataLines.join('\n');
      try {
        const parsed = JSON.parse(raw) as ServerChunk;
        onChunk(parsed);
      } catch {
        // ignore malformed events — the stream may include keep-alives
      }
    }
  }
}
