import { Icon } from "./Icon";
import { Section, Reveal, Cite } from "./Primitives";

/**
 * "Caso reconstruido" — narrativa de un despacho usando cl2 para reconstruir
 * la discusión completa de un expediente en minutos. Lenguaje de cliente final
 * (asesores, jefes de despacho), no de dev.
 */

const steps = [
  {
    t: "00:00",
    actor: "Asesora",
    action: "Pregunta inicial",
    body: "¿Qué dijo la fracción oficialista sobre el expediente 23.456 en primer debate?",
  },
  {
    t: "00:08",
    actor: "cl2",
    action: "Devuelve 4 intervenciones",
    body: "Localiza las 4 intervenciones del bloque oficialista en el acta de plenario, con minutaje y folio.",
    cites: ["acta 142 §87", "acta 142 §94", "acta 142 §112"],
  },
  {
    t: "00:42",
    actor: "Asesora",
    action: "Profundiza",
    body: "¿Y qué reservas presentó la oposición? Quiero las que se votaron.",
  },
  {
    t: "00:51",
    actor: "cl2",
    action: "Cruza con SIL",
    body: "7 reservas presentadas, 4 votadas. Cruza con el sistema de expedientes para traer el texto exacto de cada moción.",
    cites: ["exp. 23.456-15", "exp. 23.456-22"],
  },
  {
    t: "02:10",
    actor: "Asesora",
    action: "Cierra el brief",
    body: "Exporta el resumen con las citas verificables. Listo para reunión de bancada.",
  },
];

const beforeAfter = [
  {
    label: "Antes",
    time: "3-4 horas",
    detail: "Buscar en PDFs sueltos, descargar actas, cruzar con SIL a mano, pedir favores al área técnica.",
    tone: "muted" as const,
  },
  {
    label: "Con cl2",
    time: "4 minutos",
    detail: "Pregunta en lenguaje natural. Cada respuesta con folio. Exportable y verificable.",
    tone: "accent" as const,
  },
];

export const LiveProof = () => (
  <Section id="prueba" eyebrow="Cómo se usa · un caso real" kicker="06 / qué cambia en tu día">
    <Reveal>
      <div className="flex items-end justify-between gap-8 flex-wrap mb-12">
        <h2 className="display display--lg max-w-[760px]">
          Reconstruir una discusión completa,
          <br />
          <em className="italic-serif text-cl2-burgundy">en lo que dura un café.</em>
        </h2>
        <p className="lede max-w-[380px] text-[15px]">
          Caso típico de un despacho preparando reunión de bancada. Misma pregunta, dos
          formas de resolverla.
        </p>
      </div>
    </Reveal>

    {/* Before / After comparison strip */}
    <Reveal delay={120}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-cl2-ink/10 border border-cl2-ink/10 rounded-xl overflow-hidden mb-14">
        {beforeAfter.map((b) => (
          <div
            key={b.label}
            className={`p-7 ${b.tone === "accent" ? "bg-cl2-paper" : "bg-cl2-ink/[0.02]"}`}
          >
            <div className="font-mono text-[10.5px] uppercase tracking-widest text-cl2-ink/45 mb-3">
              {b.label}
            </div>
            <div
              className={`serif leading-none mb-3 ${
                b.tone === "accent" ? "text-cl2-burgundy" : "text-cl2-ink/55"
              }`}
              style={{ fontSize: "clamp(36px, 4vw, 52px)", letterSpacing: "-0.02em", fontWeight: 400 }}
            >
              {b.time}
            </div>
            <p className="text-[14px] leading-[1.55] text-cl2-ink/70 max-w-[420px]">{b.detail}</p>
          </div>
        ))}
      </div>
    </Reveal>

    {/* The reconstructed case — narrative timeline */}
    <Reveal delay={200}>
      <div
        className="relative rounded-2xl overflow-hidden"
        style={{
          background:
            "linear-gradient(180deg, hsl(var(--cl2-paper)), hsl(var(--cl2-burgundy) / 0.025))",
          border: "1px solid hsl(var(--cl2-ink) / 0.08)",
        }}
      >
        {/* Header bar */}
        <div
          className="flex items-center justify-between px-6 sm:px-8 py-4 border-b border-cl2-ink/8"
          style={{ background: "hsl(var(--cl2-ink) / 0.02)" }}
        >
          <div className="flex items-center gap-3">
            <span className="dot dot-burgundy live-dot" />
            <span className="font-mono text-[11px] uppercase tracking-wider text-cl2-ink/65">
              Sesión reconstruida · Despacho legislativo
            </span>
          </div>
          <span className="font-mono text-[11px] text-cl2-ink/45">
            Expediente 23.456 · Reforma fiscal
          </span>
        </div>

        {/* Timeline */}
        <div className="p-6 sm:p-10">
          <ol className="relative">
            {/* vertical rail */}
            <div
              aria-hidden
              className="absolute left-[22px] sm:left-[26px] top-2 bottom-2 w-px bg-cl2-ink/10"
            />

            {steps.map((s, i) => {
              const isCl2 = s.actor === "cl2";
              return (
                <li key={i} className="relative flex gap-5 sm:gap-6 pb-8 last:pb-0">
                  {/* node */}
                  <div className="relative z-10 flex-shrink-0">
                    <div
                      className="w-[44px] h-[44px] sm:w-[52px] sm:h-[52px] rounded-full flex items-center justify-center"
                      style={{
                        background: isCl2 ? "hsl(var(--cl2-burgundy))" : "hsl(var(--cl2-paper))",
                        border: isCl2
                          ? "1px solid hsl(var(--cl2-burgundy))"
                          : "1.5px solid hsl(var(--cl2-ink) / 0.18)",
                        boxShadow: isCl2 ? "0 4px 16px hsl(var(--cl2-burgundy) / 0.25)" : "none",
                      }}
                    >
                      {isCl2 ? (
                        <span className="font-mono text-[10px] font-bold text-white tracking-wider">
                          cl2
                        </span>
                      ) : (
                        <span className="serif text-[15px] text-cl2-ink/60" style={{ fontStyle: "italic" }}>
                          A
                        </span>
                      )}
                    </div>
                  </div>

                  {/* content */}
                  <div className="flex-1 min-w-0 pt-1">
                    <div className="flex items-center gap-3 flex-wrap mb-2">
                      <span className="font-mono text-[10.5px] uppercase tracking-wider text-cl2-ink/40">
                        {s.t}
                      </span>
                      <span className="w-1 h-1 rounded-full bg-cl2-ink/20" />
                      <span
                        className={`text-[12px] font-semibold ${
                          isCl2 ? "text-cl2-burgundy" : "text-cl2-ink/75"
                        }`}
                      >
                        {s.actor}
                      </span>
                      <span className="text-[12px] text-cl2-ink/50">— {s.action}</span>
                    </div>

                    <p
                      className={`text-[15px] leading-[1.6] mb-3 ${
                        isCl2 ? "text-cl2-ink" : "text-cl2-ink/80"
                      }`}
                      style={isCl2 ? {} : { fontStyle: "italic" }}
                    >
                      {isCl2 ? s.body : `"${s.body}"`}
                    </p>

                    {s.cites && (
                      <div className="flex flex-wrap gap-1.5">
                        {s.cites.map((c) => (
                          <Cite key={c} refLabel={c} source="Caso ilustrativo" />
                        ))}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>

        {/* Footer outcome */}
        <div
          className="px-6 sm:px-10 py-6 border-t border-cl2-ink/8 flex items-center justify-between gap-4 flex-wrap"
          style={{ background: "hsl(var(--cl2-burgundy) / 0.04)" }}
        >
          <div className="flex items-center gap-3">
            <Icon name="check" size={16} className="text-cl2-burgundy" />
            <span className="text-[14px] text-cl2-ink/80">
              Brief listo, exportable, <strong>con folio en cada cita</strong>.
            </span>
          </div>
          <span className="font-mono text-[11px] uppercase tracking-wider text-cl2-ink/45">
            5 citas · 2 expedientes cruzados · 0 PDFs descargados
          </span>
        </div>
      </div>
    </Reveal>

    {/* Three usage scenarios — quick legitimizers */}
    <Reveal delay={280}>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-12">
        {[
          {
            icon: "book" as const,
            title: "Preparar bancada",
            body: "Reconstruí qué dijo cada fracción sobre un tema, con citas listas para presentar.",
          },
          {
            icon: "compass" as const,
            title: "Rastrear un argumento",
            body: "Seguí la evolución de una postura a través de varios plenarios, sin perder el hilo.",
          },
          {
            icon: "archive" as const,
            title: "Cruzar expediente y debate",
            body: "Conectá el texto formal del expediente con lo que se dijo en sala y en comisión.",
          },
        ].map((u) => (
          <div
            key={u.title}
            className="p-6 rounded-xl border border-cl2-ink/10 bg-cl2-paper/60 hover:border-cl2-burgundy/30 transition-colors"
          >
            <div
              className="w-10 h-10 rounded-lg flex items-center justify-center mb-4"
              style={{ background: "hsl(var(--cl2-burgundy) / 0.08)" }}
            >
              <Icon name={u.icon} size={18} className="text-cl2-burgundy" />
            </div>
            <h4 className="serif text-[17px] text-cl2-ink mb-2" style={{ fontWeight: 500 }}>
              {u.title}
            </h4>
            <p className="text-[13.5px] leading-[1.55] text-cl2-ink/65">{u.body}</p>
          </div>
        ))}
      </div>
    </Reveal>
  </Section>
);
