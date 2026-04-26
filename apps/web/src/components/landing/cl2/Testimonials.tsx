import { useState, useRef, useEffect, Fragment } from "react";
import { motion } from "motion/react";
import { Section, Reveal } from "./Primitives";
import mariaImg from "@/assets/testimonials/maria.jpg";
import jorgeImg from "@/assets/testimonials/jorge.jpg";
import andreaImg from "@/assets/testimonials/andrea.jpg";
import ricardoImg from "@/assets/testimonials/ricardo.jpg";
import patriciaImg from "@/assets/testimonials/patricia.jpg";
import diegoImg from "@/assets/testimonials/diego.jpg";

type Testimonial = {
  img: string;
  toneVar: string;
  quote: string;
  name: string;
  role: string;
  org: string;
};

const testimonials: Testimonial[] = [
  {
    img: mariaImg,
    toneVar: "--cl2-burgundy",
    quote:
      "Antes tardaba dos días en armar el contexto de un dictamen. Con [Lexa] abro la sesión y ya tengo el acta, los votos y los antecedentes citados al folio. Mi equipo de litigio lo usa para cada audiencia.",
    name: "María Camacho",
    role: "Socia · Litigio constitucional",
    org: "Camacho & Asociados",
  },
  {
    img: jorgeImg,
    toneVar: "--cl2-ochre",
    quote:
      "En regulatorio cobramos por horas, pero el cliente paga por certeza. cl2 nos da el folio exacto en minutos — y cuando el [archivo] no respalda, simplemente se detiene. Cero riesgo de citar un precedente que no existe.",
    name: "Jorge Restrepo",
    role: "Socio director · Regulatorio",
    org: "RR Legal",
  },
  {
    img: andreaImg,
    toneVar: "--cl2-rose",
    quote:
      "[Centinela] me avisó de tres mociones que afectaban a un cliente del sector energético antes que la prensa. Trabajamos con días de ventaja sobre la competencia.",
    name: "Andrea Lozano",
    role: "Counsel · Public affairs",
    org: "Lozano & Tovar",
  },
  {
    img: ricardoImg,
    toneVar: "--cl2-burgundy",
    quote:
      "Antes mandaba a tres abogados juniors a buscar precedentes. Hoy [Atlas] cruza dictamen + voto nominal y me deja el memo armado en una mañana. La firma factura igual; el equipo descansa.",
    name: "Ricardo Mendoza",
    role: "Socio · Corporativo",
    org: "Mendoza Vélez",
  },
  {
    img: patriciaImg,
    toneVar: "--cl2-ochre",
    quote:
      "Llevo treinta años en la profesión y desconfiaba de la IA. Lo que me convenció fue ver que cita el acta y el timecode al segundo. Si no está en el [archivo], no lo dice. Eso es práctica responsable.",
    name: "Patricia Aguilar",
    role: "Socia fundadora",
    org: "Aguilar Legal Group",
  },
  {
    img: diegoImg,
    toneVar: "--cl2-rose",
    quote:
      "Para due diligence regulatoria es otro nivel. [Centinela] monitorea las comisiones y [Lexa] arma el plenario. Lo que antes era un equipo de cinco, ahora son dos personas y cl2.",
    name: "Diego Salinas",
    role: "Head of Regulatory Affairs",
    org: "Salinas & Partners",
  },
];

/* ─── Glosario cl2: términos detectables en las quotes ─── */
const glossary: Record<string, { almaName?: string; description: string; toneVar: string }> = {
  Lexa: {
    almaName: "Lexa",
    toneVar: "--cl2-burgundy",
    description:
      "Alma especializada en plenario. Cita acta + timecode al segundo. Si el archivo no respalda, se detiene.",
  },
  Atlas: {
    almaName: "Atlas",
    toneVar: "--cl2-ochre",
    description:
      "Alma de comisiones. Cruza dictamen y voto nominal. No habla de leyes que no estén en SIL.",
  },
  Centinela: {
    almaName: "Centinela",
    toneVar: "--cl2-rose",
    description:
      "Alma watchlist. Monitorea actas en tiempo real. Penaliza prensa, prefiere el archivo oficial.",
  },
  archivo: {
    toneVar: "--cl2-ink",
    description:
      "El núcleo de cl2: SIL, reglamento, plenarias y comisiones, todo indexado y citable.",
  },
};

/* Renderiza el quote con tokens [Término] convertidos en chips interactivos */
const renderQuote = (text: string) => {
  const parts = text.split(/(\[[^\]]+\])/g);
  return parts.map((part, i) => {
    const m = part.match(/^\[([^\]]+)\]$/);
    if (!m) return <Fragment key={i}>{part}</Fragment>;
    const term = m[1];
    const entry = glossary[term];
    if (!entry) return <Fragment key={i}>{term}</Fragment>;

    const handleClick = () => {
      if (!entry.almaName) {
        // Solo scroll a la sección si no hay alma específica
        document.getElementById("almas")?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      document.getElementById("almas")?.scrollIntoView({ behavior: "smooth", block: "start" });
      // Pequeño delay para que termine el scroll antes de disparar el highlight
      setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent("cl2:focus-alma", { detail: { name: entry.almaName } }),
        );
      }, 600);
    };

    return (
      <span
        key={i}
        className="group/term relative inline-block cursor-pointer not-italic"
        onClick={handleClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleClick();
        }}
      >
        <span
          className="serif italic underline decoration-dotted underline-offset-[5px] transition-colors duration-200"
          style={{
            color: `hsl(var(${entry.toneVar}))`,
            textDecorationColor: `hsl(var(${entry.toneVar}) / 0.5)`,
          }}
        >
          {term}
        </span>
        {/* Tooltip */}
        <span
          role="tooltip"
          className="pointer-events-none absolute left-1/2 top-full z-30 mt-2 w-[260px] -translate-x-1/2 translate-y-1 rounded-lg border border-cl2-ink/10 bg-cl2-paper p-3 text-left opacity-0 shadow-[0_18px_40px_hsl(var(--cl2-ink)/0.12)] transition-all duration-200 group-hover/term:translate-y-0 group-hover/term:opacity-100 group-focus/term:translate-y-0 group-focus/term:opacity-100"
        >
          <span
            className="font-mono text-[9.5px] uppercase tracking-[0.16em]"
            style={{ color: `hsl(var(${entry.toneVar}))` }}
          >
            {entry.almaName ? "Alma cl2" : "Glosario"}
          </span>
          <span className="mt-1 block serif text-[14px] leading-snug not-italic font-normal text-cl2-ink">
            {entry.description}
          </span>
          {entry.almaName && (
            <span className="mt-2 block font-mono text-[9.5px] uppercase tracking-[0.14em] text-cl2-ink/45">
              Click para ver en la órbita →
            </span>
          )}
        </span>
      </span>
    );
  });
};

export const Testimonials = () => {
  const [active, setActive] = useState(0);
  const [autorotate, setAutorotate] = useState(true);
  const quoteWrapRef = useRef<HTMLDivElement>(null);
  const [maxH, setMaxH] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (!autorotate) return;
    const id = setInterval(() => {
      setActive((a) => (a + 1) % testimonials.length);
    }, 7000);
    return () => clearInterval(id);
  }, [autorotate]);

  useEffect(() => {
    if (!quoteWrapRef.current) return;
    const items = quoteWrapRef.current.querySelectorAll<HTMLElement>("[data-quote]");
    let h = 0;
    items.forEach((el) => {
      h = Math.max(h, el.scrollHeight);
    });
    if (h) setMaxH(h);
  }, []);

  return (
    <Section id="testimonios" eyebrow="Confianza ganada" kicker="06 / quién lo usa">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 lg:gap-16 items-start">
        {/* Columna izquierda: título */}
        <Reveal className="lg:col-span-5">
          <div className="lg:sticky lg:top-32">
            <h2 className="display display--lg">
              <em>Asesores</em> que ya
              <br />
              no trabajan sin cl2.
            </h2>
            <p className="lede mt-6 max-w-[420px]">
              Equipos en comisión, despacho y bancada. Cada uno con su forma de citar — todos
              con el mismo archivo detrás.
            </p>

            {/* Indicadores numéricos sutiles */}
            <div className="mt-10 flex items-center gap-3 font-mono text-[10.5px] uppercase tracking-[0.16em] text-cl2-ink/45">
              <span className="text-cl2-ink/80 tabular-nums">
                {String(active + 1).padStart(2, "0")}
              </span>
              <span className="h-px w-8 bg-cl2-ink/20" />
              <span className="tabular-nums">
                {String(testimonials.length).padStart(2, "0")}
              </span>
            </div>
          </div>
        </Reveal>

        {/* Columna derecha: slider */}
        <Reveal delay={120} className="lg:col-span-7">
          <div className="relative">
            {/* Avatares apilados — animación rotación + blur */}
            <div className="relative h-[120px] w-[120px] mb-8">
              {/* Halo decorativo de fondo */}
              <div
                aria-hidden
                className="absolute inset-0 -m-4 rounded-full transition-colors duration-700"
                style={{
                  background: `radial-gradient(circle, hsl(var(${testimonials[active].toneVar}) / 0.18), transparent 70%)`,
                }}
              />
              {testimonials.map((t, i) => {
                const isActive = i === active;
                return (
                  <motion.div
                    key={t.name}
                    aria-hidden={!isActive}
                    initial={false}
                    animate={{
                      opacity: isActive ? 1 : 0,
                      scale: isActive ? 1 : 0.85,
                      rotate: isActive ? 0 : i < active ? -25 : 25,
                      filter: isActive ? "blur(0px)" : "blur(4px)",
                    }}
                    transition={{ duration: 0.85, ease: [0.22, 1, 0.36, 1] }}
                    className="absolute inset-0 rounded-full overflow-hidden"
                    style={{
                      boxShadow: `0 14px 40px hsl(var(${t.toneVar}) / 0.28), 0 0 0 3px hsl(var(--cl2-paper)), 0 0 0 4px hsl(var(${t.toneVar}) / 0.45)`,
                      pointerEvents: isActive ? "auto" : "none",
                    }}
                  >
                    <img
                      src={t.img}
                      alt={t.name}
                      width={512}
                      height={512}
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  </motion.div>
                );
              })}

              {/* Glyph de comillas */}
              <span
                aria-hidden
                className="absolute -bottom-2 -right-2 flex h-8 w-8 items-center justify-center rounded-full bg-cl2-paper border border-cl2-ink/10 transition-colors duration-700"
                style={{ color: `hsl(var(${testimonials[active].toneVar}))` }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M9.983 3v7.391c0 5.704-3.731 9.57-8.983 10.609l-.995-2.151c2.432-.917 3.995-3.638 3.995-5.849h-4v-10h9.983zm14.017 0v7.391c0 5.704-3.748 9.571-9 10.609l-.996-2.151c2.433-.917 3.996-3.638 3.996-5.849h-3.983v-10h9.983z" />
                </svg>
              </span>
            </div>

            {/* Quotes */}
            <div
              ref={quoteWrapRef}
              className="relative"
              style={{ minHeight: maxH ? `${maxH}px` : undefined }}
            >
              {testimonials.map((t, i) => {
                const isActive = i === active;
                return (
                  <motion.blockquote
                    key={t.name}
                    data-quote
                    aria-hidden={!isActive}
                    initial={false}
                    animate={{
                      opacity: isActive ? 1 : 0,
                      y: isActive ? 0 : i < active ? -16 : 16,
                    }}
                    transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
                    className="absolute inset-0 serif text-cl2-ink"
                    style={{
                      fontSize: "clamp(20px, 2vw, 26px)",
                      lineHeight: 1.4,
                      fontWeight: 400,
                      letterSpacing: "-0.012em",
                      fontStyle: "italic",
                      pointerEvents: isActive ? "auto" : "none",
                    }}
                  >
                    "{renderQuote(t.quote)}"
                  </motion.blockquote>
                );
              })}
            </div>

            {/* Wheel de autores — dial estilo caja fuerte */}
            <div className="mt-10">
              <div
                className="relative h-[144px] overflow-hidden"
                style={{
                  maskImage:
                    "linear-gradient(to bottom, transparent 0%, black 30%, black 70%, transparent 100%)",
                  WebkitMaskImage:
                    "linear-gradient(to bottom, transparent 0%, black 30%, black 70%, transparent 100%)",
                }}
              >
                {/* Guías del slot central (48px) */}
                <div
                  aria-hidden
                  className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-[48px] pointer-events-none"
                  style={{
                    borderTop: "1px dashed hsl(var(--cl2-ink) / 0.14)",
                    borderBottom: "1px dashed hsl(var(--cl2-ink) / 0.14)",
                  }}
                />
                {/* Marca lateral del color activo */}
                <motion.div
                  aria-hidden
                  className="absolute left-0 top-1/2 -translate-y-1/2 h-[28px] w-[3px] rounded-r"
                  animate={{
                    backgroundColor: `hsl(var(${testimonials[active].toneVar}))`,
                  }}
                  transition={{ duration: 0.45 }}
                />

                {/* Pista del dial */}
                <motion.div
                  className="absolute left-0 right-0 top-0"
                  animate={{ y: 48 - active * 48 }}
                  transition={{
                    type: "spring",
                    stiffness: 170,
                    damping: 24,
                    mass: 0.9,
                  }}
                >
                  {testimonials.map((t, i) => {
                    const dist = Math.abs(i - active);
                    const isActive = dist === 0;
                    return (
                      <button
                        key={t.name}
                        onClick={() => {
                          setActive(i);
                          setAutorotate(false);
                        }}
                        className="flex h-[48px] w-full items-center gap-3 pl-5 pr-2 text-left tabular-nums transition-opacity duration-300"
                        style={{
                          opacity: isActive ? 1 : dist === 1 ? 0.35 : 0.15,
                        }}
                      >
                        <span
                          className="font-mono text-[10px] uppercase tracking-[0.18em] w-6"
                          style={{
                            color: isActive
                              ? `hsl(var(${t.toneVar}))`
                              : "hsl(var(--cl2-ink) / 0.5)",
                          }}
                        >
                          {String(i + 1).padStart(2, "0")}
                        </span>
                        <span
                          className="serif text-[18px] leading-none"
                          style={{
                            color: isActive
                              ? `hsl(var(${t.toneVar}))`
                              : "hsl(var(--cl2-ink))",
                            fontStyle: "italic",
                            fontWeight: 500,
                          }}
                        >
                          {t.name}
                        </span>
                        <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-cl2-ink/55 truncate">
                          {t.role} · {t.org}
                        </span>
                      </button>
                    );
                  })}
                </motion.div>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </Section>
  );
};
