/**
 * MemoriaViva — la sección nueva que reemplaza la posición de Capabilities/Almas tech-feature.
 *
 * Concepto: cl2 NO es un buscador. Es una mente. Cada fuente de datos que
 * tiene "leída" se muestra como una memoria conectada al núcleo. La sección
 * traduce la profundidad del producto sin hablar de tecnología:
 *
 *    Memoria 01 — El archivo (21.620 expedientes)
 *    Memoria 02 — Cada palabra del plenario (235 sesiones)
 *    Memoria 03 — El Reglamento (96 artículos)
 *    Memoria 04 — La agenda viva
 *    Memoria 05 — La voz del despacho
 *
 * Cada nodo está conectado al núcleo (cl2) con una línea sutil, y un beam
 * de gradiente burgundy→ochre viaja por la línea de manera independiente.
 * Hover sobre un nodo: la memoria se expande mostrando la descripción
 * completa. Selección sticky: tap mobile mantiene la memoria abierta.
 *
 * Por qué esta forma:
 *   - Authority sin alarde técnico: el usuario VE que cl2 es profundo
 *     sin que le digamos "21k expedientes indexados".
 *   - Endowment: la memoria #05 ("la voz del despacho") posiciona los
 *     lineamientos del cliente como parte del cerebro, no una "feature".
 *   - Lindy: el último renglón promete crecimiento ("cada mes suma más
 *     memoria") — proyecta cl2 como institución, no como producto nuevo.
 */
import { useState, useEffect, useRef } from "react";
import { motion } from "motion/react";
import { Section, Reveal } from "./Primitives";

// ─── Memorias (data) ────────────────────────────────────────────────────
type Memoria = {
  num: string;
  title: string;
  countLabel: string;
  blurb: string;
  // Posición en grados sobre la órbita (0=derecha, 90=abajo, 180=izq, 270=arriba)
  angle: number;
};

const memorias: Memoria[] = [
  {
    num: "01",
    title: "El archivo",
    countLabel: "21.620 expedientes",
    blurb:
      "Lo que se votó hace seis años pesa lo mismo que lo que entra mañana. cl2 lee cada expediente como si fuera el primero — y los recuerda todos a la vez.",
    angle: 270, // arriba
  },
  {
    num: "02",
    title: "Cada palabra del plenario",
    countLabel: "235 sesiones transcritas",
    blurb:
      "Cualquier diputado, cualquier intervención, en cuestión de segundos. cl2 escucha lo que se dijo y lo deja escrito con la marca del momento exacto.",
    angle: 342, // arriba-derecha
  },
  {
    num: "03",
    title: "El Reglamento",
    countLabel: "96 artículos",
    blurb:
      "Las reglas que rigen el procedimiento. cl2 las aplica en silencio cada vez que responde — para que vos no tengas que abrirlas.",
    angle: 54, // abajo-derecha
  },
  {
    num: "04",
    title: "La agenda viva",
    countLabel: "Lo que viene esta semana",
    blurb:
      "Lo que está hoy y mañana en plenario y comisiones. cl2 lo lee mientras dormís y te entrega un mapa al despertar.",
    angle: 126, // abajo-izquierda
  },
  {
    num: "05",
    title: "La voz de tu despacho",
    countLabel: "Tus lineamientos",
    blurb:
      "Cómo le gusta a tu jefa que se redacte un brief. Qué postura mantiene tu fracción en cada tema. cl2 los respeta en cada respuesta, sin olvidarlos.",
    angle: 198, // arriba-izquierda
  },
];

// ─── Layout constants ───────────────────────────────────────────────────
// Diseñado sobre un viewBox cuadrado para que el SVG escale limpio.
const VIEWBOX = 1000;
const CENTER = VIEWBOX / 2;
const ORBIT_RADIUS = 360;

const polar = (angleDeg: number, r: number) => {
  const rad = ((angleDeg - 90) * Math.PI) / 180; // -90 para que 0° sea "arriba"
  return { x: CENTER + Math.cos(rad) * r, y: CENTER + Math.sin(rad) * r };
};

// ─── Animated beam path (svg gradient pulsing along a line) ─────────────
const Beam = ({
  from,
  to,
  delay,
}: {
  from: { x: number; y: number };
  to: { x: number; y: number };
  delay: number;
}) => {
  const gradId = `mv-beam-${from.x}-${from.y}-${to.x}-${to.y}`.replace(
    /\./g,
    "_",
  );
  return (
    <>
      {/* Static base line — siempre visible, muy sutil */}
      <line
        x1={from.x}
        y1={from.y}
        x2={to.x}
        y2={to.y}
        stroke="hsl(var(--cl2-burgundy) / 0.18)"
        strokeWidth={1}
      />
      {/* Animated beam */}
      <line
        x1={from.x}
        y1={from.y}
        x2={to.x}
        y2={to.y}
        stroke={`url(#${gradId})`}
        strokeWidth={2}
        strokeLinecap="round"
      />
      <defs>
        <motion.linearGradient
          id={gradId}
          gradientUnits="userSpaceOnUse"
          x1={from.x}
          y1={from.y}
          x2={to.x}
          y2={to.y}
          initial={{
            // start the gradient OFF the visible segment
            x1: from.x,
            y1: from.y,
            x2: from.x,
            y2: from.y,
          }}
          animate={{
            // sweep the gradient endpoint to the destination
            x1: [from.x, to.x],
            y1: [from.y, to.y],
            x2: [from.x, to.x + (to.x - from.x) * 0.3],
            y2: [from.y, to.y + (to.y - from.y) * 0.3],
          }}
          transition={{
            duration: 3.5,
            repeat: Infinity,
            repeatType: "loop",
            ease: "easeInOut",
            repeatDelay: 2.5,
            delay,
          }}
        >
          <stop offset="0%" stopColor="hsl(var(--cl2-burgundy))" stopOpacity="0" />
          <stop offset="40%" stopColor="hsl(var(--cl2-burgundy))" stopOpacity="0.85" />
          <stop offset="55%" stopColor="hsl(var(--cl2-ochre))" stopOpacity="0.95" />
          <stop offset="100%" stopColor="hsl(var(--cl2-ochre))" stopOpacity="0" />
        </motion.linearGradient>
      </defs>
    </>
  );
};

// ─── Memoria node ───────────────────────────────────────────────────────
const MemoriaNode = ({
  m,
  active,
  onActivate,
}: {
  m: Memoria;
  active: boolean;
  onActivate: () => void;
}) => {
  const { x, y } = polar(m.angle, ORBIT_RADIUS);
  // En SVG porcentaje del viewBox
  const xPct = (x / VIEWBOX) * 100;
  const yPct = (y / VIEWBOX) * 100;

  return (
    <button
      type="button"
      onMouseEnter={onActivate}
      onFocus={onActivate}
      onClick={onActivate}
      className="absolute -translate-x-1/2 -translate-y-1/2 group focus:outline-none"
      style={{ left: `${xPct}%`, top: `${yPct}%` }}
      aria-label={`${m.title} · ${m.countLabel}`}
    >
      {/* halo */}
      <span
        aria-hidden
        className={`absolute -inset-5 rounded-full transition-opacity duration-500 ${
          active ? "opacity-100" : "opacity-0 group-hover:opacity-70"
        }`}
        style={{
          background:
            "radial-gradient(circle, hsl(var(--cl2-burgundy) / 0.20), transparent 70%)",
        }}
      />
      {/* dot */}
      <span
        className={`relative block w-3.5 h-3.5 rounded-full ring-4 transition-all duration-300 ${
          active
            ? "bg-cl2-burgundy ring-cl2-burgundy/15 scale-125"
            : "bg-cl2-burgundy/85 ring-cl2-burgundy/8 group-hover:scale-110"
        }`}
      />
      {/* label */}
      <span
        className="absolute left-1/2 -translate-x-1/2 mt-3 whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.2em] text-cl2-ink/55"
        style={{ top: "100%" }}
      >
        Memoria {m.num}
      </span>
    </button>
  );
};

// ─── Section ────────────────────────────────────────────────────────────
export const MemoriaViva = () => {
  const [activeIdx, setActiveIdx] = useState(0);
  const sectionRef = useRef<HTMLDivElement | null>(null);

  // Auto-cycle when nothing is hovered, only while section is in view.
  useEffect(() => {
    let inView = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (interval) return;
      interval = setInterval(() => {
        setActiveIdx((i) => (i + 1) % memorias.length);
      }, 4000);
    };
    const stop = () => {
      if (!interval) return;
      clearInterval(interval);
      interval = null;
    };

    const obs = new IntersectionObserver(
      ([entry]) => {
        inView = entry?.isIntersecting ?? false;
        if (inView) start();
        else stop();
      },
      { threshold: 0.25 },
    );
    if (sectionRef.current) obs.observe(sectionRef.current);
    return () => {
      obs.disconnect();
      stop();
    };
  }, []);

  const active = memorias[activeIdx]!;
  const center = { x: CENTER, y: CENTER };

  return (
    <Section
      id="memoria-viva"
      eyebrow="La memoria"
      kicker="02 / lo que cl2 sabe"
    >
      <div className="grid gap-12 md:gap-16 md:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] items-center">
        {/* ── Headline + active memory description ─────────────── */}
        <div ref={sectionRef}>
          <Reveal>
            <h2 className="display display--lg">
              La memoria de la Asamblea,
              <br />
              <em className="italic-serif text-cl2-burgundy">
                en una sola mente.
              </em>
            </h2>
          </Reveal>

          <Reveal delay={120}>
            <p className="lede mt-6 max-w-[520px]">
              cl2 lee, recuerda y conecta — para que vos no tengas que hacerlo.
            </p>
          </Reveal>

          {/* Active memory panel — changes as user hovers / auto-cycles */}
          <Reveal delay={200}>
            <div
              className="mt-10 border-l-2 border-cl2-burgundy/30 pl-5 min-h-[140px]"
              aria-live="polite"
            >
              <div className="font-mono text-[10.5px] uppercase tracking-[0.22em] text-cl2-burgundy/80 mb-2">
                Memoria {active.num} · {active.countLabel}
              </div>
              <motion.div
                key={active.num}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
              >
                <h3
                  className="serif text-[26px] md:text-[30px] leading-tight text-cl2-ink mb-2"
                  style={{ fontWeight: 500, letterSpacing: "-0.012em" }}
                >
                  {active.title}
                </h3>
                <p className="text-[14.5px] leading-[1.65] text-cl2-ink/[0.72]">
                  {active.blurb}
                </p>
              </motion.div>
            </div>
          </Reveal>

          <Reveal delay={300}>
            <p
              className="mt-10 italic-serif text-cl2-ink/55 text-[15px]"
              style={{ letterSpacing: "-0.005em" }}
            >
              Cada mes, cl2 suma más memoria. Su mente crece. La tuya no se
              queda atrás.
            </p>
          </Reveal>
        </div>

        {/* ── Constellation ────────────────────────────────────── */}
        <Reveal delay={150}>
          <div className="relative w-full aspect-square max-w-[560px] mx-auto">
            {/* SVG layer for the beams + center pulse */}
            <svg
              viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
              className="absolute inset-0 w-full h-full"
              aria-hidden
            >
              {/* faint orbit ring */}
              <circle
                cx={CENTER}
                cy={CENTER}
                r={ORBIT_RADIUS}
                fill="none"
                stroke="hsl(var(--cl2-burgundy) / 0.08)"
                strokeWidth={1}
                strokeDasharray="3 6"
              />
              {/* beams from center to each memoria */}
              {memorias.map((m, idx) => {
                const dot = polar(m.angle, ORBIT_RADIUS);
                return (
                  <Beam
                    key={m.num}
                    from={center}
                    to={dot}
                    delay={idx * 1.2}
                  />
                );
              })}
              {/* center node halo */}
              <circle
                cx={CENTER}
                cy={CENTER}
                r={50}
                fill="hsl(var(--cl2-burgundy) / 0.05)"
              />
              <circle
                cx={CENTER}
                cy={CENTER}
                r={32}
                fill="hsl(var(--cl2-paper))"
                stroke="hsl(var(--cl2-burgundy))"
                strokeWidth={1.5}
              />
            </svg>

            {/* Center label "cl2" — overlaid in HTML so we get crisp font */}
            <div
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none select-none"
              aria-hidden
            >
              <span
                className="font-display text-[34px] text-cl2-burgundy"
                style={{ fontWeight: 500, letterSpacing: "-0.02em" }}
              >
                cl2
              </span>
            </div>

            {/* Memoria nodes (HTML, layered above SVG) */}
            {memorias.map((m, idx) => (
              <MemoriaNode
                key={m.num}
                m={m}
                active={idx === activeIdx}
                onActivate={() => setActiveIdx(idx)}
              />
            ))}
          </div>
        </Reveal>
      </div>
    </Section>
  );
};
