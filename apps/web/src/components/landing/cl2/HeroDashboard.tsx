/**
 * HeroDashboard — the live demo Mac frame in the landing hero.
 *
 * Visual chrome is the original Lovable draft, untouched: window dots,
 * left sidebar (decorative — "Mis consultas / Watchlist / María R."),
 * center conversation, right sources panel.
 *
 * What changed from the draft: the mock chat (MOCK_REPLIES + pickReply +
 * setTimeout) is replaced by a REAL conversation against Lexa via the
 * BFF's /api/public/demo-chat endpoint. SSE streaming, citation chunks
 * routed to the right panel, 5-prompt cap (was 3) backed by both
 * localStorage (UX) and server-side per-IP rate limit (security).
 */
import { useEffect, useRef, useState } from "react";
import { Cite, renderWithCitations } from "./Primitives";
import { Icon } from "./Icon";

// ─── Constraints (must match apps/api/src/routes/publicDemo.ts) ──────
const DEMO_LIMIT = 5;
const COUNT_KEY = "cl2.landing.demoCount";
const PROMPT_MAX = 600;

const SUGGESTED = [
  "¿Cómo se votó la última reforma a la Ley de Aguas?",
  "Argumentos del dictamen mayoría del expediente 23.918",
  "Plazo del dictamen de comisión según el Reglamento",
  "Qué dijo el diputado Calderón sobre el artículo 14",
];

interface DemoCitation {
  /** 1-indexed reference number — matches `[N]` markers in the body. */
  index: number;
  title: string;
  url?: string | null;
  source?: string | null;
  meta?: string | null;
}

type Msg = {
  role: "user" | "assistant";
  content: string;
  citations?: DemoCitation[];
  /** True only while a stream is still open for this assistant message. */
  streaming?: boolean;
  /** Wallclock ms once the stream finished — used for the response-time chip. */
  durationMs?: number;
};

function readCount(): number {
  if (typeof localStorage === "undefined") return 0;
  const v = Number.parseInt(localStorage.getItem(COUNT_KEY) ?? "0", 10);
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

function bumpCount(): number {
  const next = readCount() + 1;
  try {
    localStorage.setItem(COUNT_KEY, String(next));
  } catch {
    /* private mode etc. */
  }
  return next;
}

/** Parse the assistant text for legacy-style `[acta NN §NN]` / `[exp...]`
 *  citation markers. We keep this for backward visual compatibility with
 *  renderWithCitations, but the canonical citation list now comes from
 *  the SSE stream's `citation` chunk. */
function extractLegacySources(text: string): { ref: string; kind: string }[] {
  const re = /\[(acta\s+\d+\s+§\s*\d+|exp\.?\s+[\d.]+\s+fl\.?\s+[\d.]+)\]/gi;
  const found: { ref: string; kind: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const ref = m[1];
    const kind = ref.toLowerCase().startsWith("acta") ? "Acta plenaria" : "Expediente · folio";
    if (!found.some((f) => f.ref === ref)) found.push({ ref, kind });
  }
  return found;
}

export const HeroDashboard = () => {
  const [count, setCount] = useState<number>(() => readCount());
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const startTimeRef = useRef<number>(0);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, streaming]);

  // Cancel any in-flight stream on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  const remaining = Math.max(0, DEMO_LIMIT - count);
  const blocked = remaining === 0 || streaming;
  const composerLocked = remaining === 0;

  const send = async (text?: string) => {
    const q = (text ?? input).trim();
    if (!q || streaming) return;
    if (q.length > PROMPT_MAX) return;
    if (composerLocked) return;

    // Prior context — last few turns to keep continuity. Server caps at
    // 8 entries / 1500 chars each, but we trim eagerly to keep the
    // request small.
    const prior = messages.slice(-6).map((m) => ({ role: m.role, content: m.content }));

    setInput("");
    setMessages((prev) => [
      ...prev,
      { role: "user", content: q },
      { role: "assistant", content: "", streaming: true },
    ]);
    setStreaming(true);
    startTimeRef.current = performance.now();
    abortRef.current = new AbortController();

    try {
      const res = await fetch("/api/public/demo-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, prior }),
        signal: abortRef.current.signal,
      });

      if (!res.ok) {
        let parsed: { error?: string; message?: string } = {};
        try {
          parsed = await res.json();
        } catch {
          /* not json */
        }
        finalizeAssistantWithError(
          parsed.message ?? `No se pudo conectar (HTTP ${res.status}).`
        );
        return;
      }

      // Server has burned the slot the moment we got past the rate-limit
      // gate (it increments before the model call). Mirror that locally.
      setCount(bumpCount());

      await streamSse(res, (chunk) => {
        if (chunk.type === "token" && typeof chunk.payload === "string") {
          appendToken(chunk.payload);
        } else if (chunk.type === "citation" && Array.isArray(chunk.payload)) {
          attachCitations(chunk.payload as DemoCitation[]);
        } else if (chunk.type === "error") {
          const p = chunk.payload as { message?: string } | undefined;
          finalizeAssistantWithError(p?.message ?? "Algo falló del lado nuestro.");
        }
      });
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        finalizeAssistantWithError(`Error: ${(err as Error).message}`);
      }
    } finally {
      const dur = Math.round(performance.now() - startTimeRef.current);
      setStreaming(false);
      finalizeStreaming(dur);
      abortRef.current = null;
    }
  };

  function appendToken(token: string) {
    setMessages((prev) => {
      const next = prev.slice();
      const last = next[next.length - 1];
      if (last && last.role === "assistant") {
        next[next.length - 1] = { ...last, content: last.content + token };
      }
      return next;
    });
  }

  function attachCitations(cites: DemoCitation[]) {
    setMessages((prev) => {
      const next = prev.slice();
      const last = next[next.length - 1];
      if (last && last.role === "assistant") {
        next[next.length - 1] = { ...last, citations: cites };
      }
      return next;
    });
  }

  function finalizeStreaming(durationMs: number) {
    setMessages((prev) => {
      const next = prev.slice();
      const last = next[next.length - 1];
      if (last && last.role === "assistant" && last.streaming) {
        next[next.length - 1] = { ...last, streaming: false, durationMs };
      }
      return next;
    });
  }

  function finalizeAssistantWithError(msg: string) {
    setMessages((prev) => {
      const next = prev.slice();
      const last = next[next.length - 1];
      if (last && last.role === "assistant") {
        const prefix = last.content ? `${last.content}\n\n` : "";
        next[next.length - 1] = {
          ...last,
          content: `${prefix}_${msg}_`,
          streaming: false,
        };
      }
      return next;
    });
  }

  // The latest assistant message drives the right panel. We prefer the
  // SSE-emitted citation list over legacy regex extraction — fallback
  // covers the (rare) case where the model emits old-style markers.
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const realCites: DemoCitation[] = lastAssistant?.citations ?? [];
  const legacySources = lastAssistant
    ? extractLegacySources(lastAssistant.content)
    : [];

  return (
    <div
      id="demo"
      className="rounded-2xl bg-white overflow-hidden border border-cl2-ink/10 scroll-mt-24"
      style={{
        boxShadow:
          "0 30px 80px hsl(var(--cl2-ink) / 0.12), 0 8px 24px hsl(var(--cl2-ink) / 0.06)",
      }}
    >
      {/* Window chrome */}
      <div className="flex items-center gap-3 px-3.5 py-2.5 border-b border-cl2-ink/[0.08] bg-cl2-ink/[0.02]">
        <div className="flex gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full" style={{ background: "#FF5F57" }} />
          <span className="w-2.5 h-2.5 rounded-full" style={{ background: "#FEBC2E" }} />
          <span className="w-2.5 h-2.5 rounded-full" style={{ background: "#28C840" }} />
        </div>
        <div className="flex-1 text-center font-mono text-[10.5px] text-cl2-ink/45 tracking-wider truncate">
          alpha.agentescl2.com / demo pública · Lexa
        </div>
        <div className="w-[60px]" />
      </div>

      {/* Body grid */}
      <div className="grid min-h-[480px]" style={{ gridTemplateColumns: "220px minmax(0,1fr) 260px" }}>
        {/* Sidebar (decorative) */}
        <aside className="hidden lg:flex border-r border-cl2-ink/[0.06] bg-cl2-ink/[0.015] p-4 flex-col gap-5">
          <div className="flex items-center gap-2 px-2.5 py-2 bg-white border border-cl2-ink/[0.08] rounded-lg text-[12px] text-cl2-ink/50">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/></svg>
            <span className="flex-1">Buscar en archivo…</span>
            <span className="font-mono text-[10px] px-1.5 py-0.5 bg-cl2-ink/[0.06] rounded text-cl2-ink/45">⌘K</span>
          </div>

          <SidebarSection
            title="Mis consultas"
            items={[
              { l: "Demo en curso", s: "ahora", active: true },
              { l: "Voto Ley de Aguas", s: "ayer" },
              { l: "Comisión Hacienda mar.", s: "2 días" },
              { l: "Posiciones del PLN", s: "5 días" },
            ]}
          />
          <SidebarSection
            title="Watchlist"
            items={[
              { l: "Reforma fiscal", s: "3 cambios", dot: "hsl(var(--cl2-accent))" },
              { l: "Comisión Especial", s: "1 cambio", dot: "hsl(var(--cl2-burgundy))" },
              { l: "Diputado Mora", s: "sin cambios", dot: "hsl(var(--cl2-ink) / 0.2)" },
            ]}
          />

          <div className="mt-auto pt-3.5 border-t border-cl2-ink/[0.08] flex items-center gap-2.5">
            <div
              className="w-[26px] h-[26px] rounded-full flex items-center justify-center text-white text-[10px] font-semibold"
              style={{ background: "linear-gradient(135deg, hsl(var(--cl2-burgundy)), hsl(var(--cl2-rose)))" }}
            >
              MR
            </div>
            <div className="min-w-0">
              <div className="text-[12px] text-cl2-ink font-medium">María R.</div>
              <div className="text-[10.5px] text-cl2-ink/50">Redacción · prensa</div>
            </div>
          </div>
        </aside>

        {/* Center — live conversation */}
        <div className="flex flex-col min-w-0">
          <div className="px-6 py-3 border-b border-cl2-ink/[0.06] flex items-center justify-between font-mono text-[11px] text-cl2-ink/55 tracking-wider uppercase">
            <span className="flex items-center gap-2 truncate">
              <span className={`dot ${blocked ? "dot-ink" : "dot-coral live-dot"}`} />
              <span>cl2 · demo pública</span>
            </span>
            <span
              className="text-[10.5px]"
              style={{
                color: composerLocked ? "hsl(var(--cl2-burgundy))" : "hsl(var(--cl2-ink) / 0.55)",
                fontWeight: composerLocked ? 600 : 400,
              }}
            >
              {composerLocked ? "Límite alcanzado" : `${remaining} de ${DEMO_LIMIT} restantes`}
            </span>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 px-6 sm:px-7 py-6 flex flex-col gap-5 overflow-y-auto" style={{ maxHeight: 460 }}>
            {messages.length === 0 && (
              <div>
                <div className="font-mono text-[10px] text-cl2-ink/40 uppercase tracking-wider mb-3">
                  Tocá una pregunta para empezar
                </div>
                <div className="flex flex-col gap-2">
                  {SUGGESTED.map((s) => (
                    <button
                      key={s}
                      onClick={() => void send(s)}
                      disabled={blocked}
                      className="text-left bg-cl2-ink/[0.025] border border-cl2-ink/[0.08] hover:border-cl2-burgundy/40 hover:bg-cl2-burgundy/[0.04] rounded-[10px] px-3.5 py-2.5 text-[13px] text-cl2-ink font-display transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) =>
              m.role === "user" ? (
                <div key={i} className="self-end max-w-[80%]">
                  <div
                    className="text-cl2-paper px-3.5 py-2.5 text-[13.5px] leading-relaxed"
                    style={{ background: "hsl(var(--cl2-ink))", borderRadius: "14px 14px 4px 14px" }}
                  >
                    {m.content}
                  </div>
                </div>
              ) : (
                <div key={i}>
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <span className="dot dot-burgundy" />
                    <span className="font-mono text-[10px] text-cl2-ink/45 uppercase tracking-wider">
                      cl2 · lexa
                      {m.streaming ? (
                        <span className="ml-1 animate-pulse">· pensando</span>
                      ) : (
                        <>
                          {m.durationMs != null && (
                            <span> · {(m.durationMs / 1000).toFixed(1)}s</span>
                          )}
                          {m.citations && m.citations.length > 0 && (
                            <span> · {m.citations.length} fuentes</span>
                          )}
                        </>
                      )}
                    </span>
                  </div>
                  <div className="text-[13.5px] leading-[1.65] text-cl2-ink whitespace-pre-wrap">
                    {m.content === "" && m.streaming ? (
                      <span className="inline-flex gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-cl2-burgundy animate-pulse" />
                        <span className="w-1.5 h-1.5 rounded-full bg-cl2-burgundy animate-pulse" style={{ animationDelay: "0.2s" }} />
                        <span className="w-1.5 h-1.5 rounded-full bg-cl2-burgundy animate-pulse" style={{ animationDelay: "0.4s" }} />
                      </span>
                    ) : (
                      <RenderAssistantContent content={m.content} citations={m.citations} />
                    )}
                  </div>
                </div>
              )
            )}
          </div>

          {/* Blocked banner above composer */}
          {composerLocked && (
            <div
              className="mx-4 mb-2 px-3.5 py-2.5 rounded-[10px] flex items-center justify-between gap-3 text-[12.5px]"
              style={{ background: "hsl(var(--cl2-burgundy) / 0.08)", border: "1px solid hsl(var(--cl2-burgundy) / 0.2)" }}
            >
              <span className="text-cl2-ink/80">
                <span className="italic-serif text-cl2-burgundy">Ya usaste tus 5 consultas.</span>{" "}
                La versión completa no tiene este límite.
              </span>
              <a href="#waitlist" className="btn btn-coral text-[12px] px-3 py-1.5 flex-shrink-0">
                Solicitar acceso <Icon name="arrow-right" size={12} />
              </a>
            </div>
          )}

          {/* Composer */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
            className="px-4 py-2.5 border-t border-cl2-ink/[0.06] flex items-center gap-2.5 bg-cl2-ink/[0.015]"
          >
            <input
              value={input}
              maxLength={PROMPT_MAX}
              onChange={(e) => setInput(e.target.value)}
              disabled={blocked}
              placeholder={
                composerLocked
                  ? "Demo agotada — solicitá acceso al piloto"
                  : streaming
                  ? "Lexa está respondiendo…"
                  : "Preguntá sobre un expediente, una comisión, un legislador…"
              }
              className="flex-1 bg-transparent border-none outline-none font-sans text-[13px] text-cl2-ink py-1.5 placeholder:text-cl2-ink/40 disabled:cursor-not-allowed"
            />
            {input.length > PROMPT_MAX * 0.85 && (
              <span className="font-mono text-[10px] text-cl2-ink/40 tabular-nums">
                {input.length}/{PROMPT_MAX}
              </span>
            )}
            <span className="font-mono text-[10px] text-cl2-ink/40 hidden sm:inline">↵</span>
            <button
              type="submit"
              disabled={blocked || !input.trim()}
              aria-label="Enviar consulta"
              className="inline-flex items-center justify-center w-7 h-7 rounded-full text-white transition-colors"
              style={{
                background: !input.trim() || blocked ? "hsl(var(--cl2-ink) / 0.18)" : "hsl(var(--cl2-ink))",
                cursor: !input.trim() || blocked ? "not-allowed" : "pointer",
              }}
            >
              <Icon name="arrow-right" size={13} />
            </button>
          </form>
        </div>

        {/* Right — dynamic sources panel.
            Prefers the real citation list from the SSE stream;
            falls back to legacy regex extraction for visual parity
            with the original draft when the model emits old-style markers. */}
        <aside
          className="hidden lg:flex border-l border-cl2-ink/[0.06] p-4 flex-col gap-3"
          style={{ background: "hsl(var(--cl2-burgundy) / 0.025)" }}
        >
          <div className="font-mono text-[10px] uppercase tracking-widest text-cl2-burgundy font-semibold">
            Fuentes citadas
          </div>

          {realCites.length === 0 && legacySources.length === 0 ? (
            <div className="text-[11.5px] text-cl2-ink/50 leading-snug py-4">
              Las fuentes aparecerán acá cuando Lexa cite. Sin cita, no hay respuesta.
            </div>
          ) : realCites.length > 0 ? (
            realCites.map((c) => (
              <div
                key={c.index}
                className="bg-white rounded-lg p-3 flex flex-col gap-1"
                style={{ border: "1px solid hsl(var(--cl2-burgundy) / 0.12)" }}
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10.5px] text-cl2-burgundy font-semibold">
                    [{c.index}]
                  </span>
                  {c.source && (
                    <span className="font-mono text-[9.5px] text-cl2-ink/45">{c.source}</span>
                  )}
                </div>
                <div className="text-[11.5px] text-cl2-ink/85 font-medium leading-tight line-clamp-2">
                  {c.title}
                </div>
                {c.meta && (
                  <div className="text-[10.5px] text-cl2-ink/55">{c.meta}</div>
                )}
              </div>
            ))
          ) : (
            legacySources.map((s) => (
              <div
                key={s.ref}
                className="bg-white rounded-lg p-3 flex flex-col gap-1"
                style={{ border: "1px solid hsl(var(--cl2-burgundy) / 0.12)" }}
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10.5px] text-cl2-burgundy font-semibold">
                    {s.ref}
                  </span>
                  <span className="font-mono text-[9.5px] text-cl2-ink/45">verificada</span>
                </div>
                <div className="text-[11.5px] text-cl2-ink/65">{s.kind}</div>
                <div className="flex items-center gap-1.5 mt-1">
                  <div className="flex-1 h-[3px] rounded-full bg-cl2-ink/[0.06] overflow-hidden">
                    <div className="h-full" style={{ width: "92%", background: "hsl(142 71% 41%)" }} />
                  </div>
                  <span
                    className="text-[9.5px] font-semibold uppercase tracking-wider"
                    style={{ color: "hsl(142 71% 41%)" }}
                  >
                    alta
                  </span>
                </div>
              </div>
            ))
          )}

          <div className="mt-auto p-3 rounded-lg bg-cl2-ink/[0.04] text-[11px] text-cl2-ink/60 leading-snug">
            Cada cita lleva al folio o minuto exacto del archivo. Sin cita, sin respuesta.
          </div>
        </aside>
      </div>
    </div>
  );
};

// ─── Assistant content rendering ─────────────────────────────────────
//
// Real Lexa uses [N] numeric citations from the search_transcripts tool;
// the original mock used [acta NN §NN] / [exp...]. We support BOTH
// without falling back to plain text — handy during the transition while
// agent prompts evolve.

function RenderAssistantContent({
  content,
  citations,
}: {
  content: string;
  citations?: DemoCitation[];
}) {
  // If the assistant text contains the legacy markers, defer to the
  // original `renderWithCitations` pipeline (preserves visual identity).
  if (/\[(acta\s+\d+\s+§\s*\d+|exp\.?\s+[\d.]+\s+fl\.?\s+[\d.]+)\]/i.test(content)) {
    return <>{renderWithCitations(content)}</>;
  }
  // Otherwise wrap [N] markers as the same Cite pill so they look the
  // same in the body. Hover popover gets the citation title from the
  // SSE-streamed list when available.
  const re = /\[(\d{1,2})\]/g;
  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(content)) !== null) {
    if (m.index > lastIdx) parts.push(content.slice(lastIdx, m.index));
    const n = Number(m[1]);
    const cite = citations?.find((c) => c.index === n);
    parts.push(
      <Cite
        key={`c-${key++}`}
        refLabel={`[${n}]`}
        source={cite?.title ?? "Fuente verificada"}
      />
    );
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < content.length) parts.push(content.slice(lastIdx));
  return <>{parts.length === 0 ? content : parts}</>;
}

// ─── SSE parser (same shape as DemoChatFrame in /landing v1) ─────────

interface ServerChunk {
  type: string;
  payload?: unknown;
}

async function streamSse(res: Response, onChunk: (chunk: ServerChunk) => void): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("stream_unavailable");
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const event = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLines = event
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""));
      if (dataLines.length === 0) continue;
      try {
        onChunk(JSON.parse(dataLines.join("\n")) as ServerChunk);
      } catch {
        /* ignore malformed events / keep-alives */
      }
    }
  }
}

// ─── Sidebar (decorative — original draft) ───────────────────────────

const SidebarSection = ({
  title,
  items,
}: {
  title: string;
  items: { l: string; s: string; active?: boolean; dot?: string }[];
}) => (
  <div>
    <div className="font-mono text-[9.5px] uppercase tracking-widest text-cl2-ink/40 font-semibold mb-2">
      {title}
    </div>
    <div className="flex flex-col gap-0.5">
      {items.map((it) => (
        <div
          key={it.l}
          className={`px-2.5 py-1.5 rounded-md flex items-center gap-2 cursor-pointer ${
            it.active ? "bg-white border border-cl2-ink/[0.08]" : "border border-transparent"
          }`}
        >
          {it.dot && <span className="dot flex-shrink-0" style={{ background: it.dot }} />}
          <div className="min-w-0 flex-1">
            <div className={`text-[12px] truncate ${it.active ? "text-cl2-ink font-medium" : "text-cl2-ink/75"}`}>
              {it.l}
            </div>
            <div className="text-[10px] text-cl2-ink/45 font-mono">{it.s}</div>
          </div>
        </div>
      ))}
    </div>
  </div>
);
