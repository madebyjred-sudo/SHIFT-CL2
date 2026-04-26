import { useState, useRef, useEffect } from "react";
import { motion, useReducedMotion, type PanInfo } from "motion/react";
import { Section, Reveal } from "./Primitives";

type Alma = {
  glyph: string;
  name: string;
  role: string;
  toneVar: string;
  rule: string;
  signal: string;
  /* posición en la órbita: ángulo en grados (0 = derecha, 90 = abajo) */
  angle: number;
};

const almas: Alma[] = [
  {
    glyph: "⚖",
    name: "Lexa",
    role: "Plenario",
    toneVar: "--cl2-burgundy",
    rule: "Si el archivo no respalda, se detiene.",
    signal: "Cita acta + timecode al segundo",
    angle: 225,
  },
  {
    glyph: "📑",
    name: "Atlas",
    role: "Comisiones",
    toneVar: "--cl2-ochre",
    rule: "No habla de leyes que no estén en SIL.",
    signal: "Cruza dictamen + voto nominal",
    angle: 330,
  },
  {
    glyph: "📡",
    name: "Centinela",
    role: "Watchlist",
    toneVar: "--cl2-rose",
    rule: "Penaliza prensa, prefiere el acta.",
    signal: "Bandera de confianza explícita",
    angle: 90,
  },
];

/* ─── Orbit constants (relative to a 900x900 viewBox) ─── */
const ORBIT_R = 320;
const CENTER = 450;

const polar = (angleDeg: number, r: number) => {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: CENTER + Math.cos(rad) * r, y: CENTER + Math.sin(rad) * r };
};

/* ─── Satellite card ─── */
const Satellite = ({
  alma,
  index,
  hovered,
  onHover,
  onDrag,
}: {
  alma: Alma;
  index: number;
  hovered: string | null;
  onHover: (n: string | null) => void;
  onDrag: (name: string, offset: { x: number; y: number }) => void;
}) => {
  const reduce = useReducedMotion();
  const { x, y } = polar(alma.angle, ORBIT_R);
  const isActive = hovered === alma.name;
  const isDimmed = hovered !== null && !isActive;

  return (
    <div
      className="absolute"
      style={{
        left: `${(x / 900) * 100}%`,
        top: `${(y / 900) * 100}%`,
        transform: "translate(-50%, -50%)",
      }}
      onMouseEnter={() => onHover(alma.name)}
      onMouseLeave={() => onHover(null)}
    >
    <motion.div
      initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.6, delay: 0.3 + index * 0.15, ease: [0.22, 1, 0.36, 1] }}
      drag
      dragMomentum={false}
      dragElastic={0.15}
      whileDrag={{ scale: 1.04, cursor: "grabbing" }}
      onDrag={(_, info: PanInfo) => onDrag(alma.name, { x: info.offset.x, y: info.offset.y })}
      onDragEnd={(_, info: PanInfo) => onDrag(alma.name, { x: info.offset.x, y: info.offset.y })}
      className="cursor-grab touch-none"
    >
      <div
        className="relative transition-all duration-500 cursor-default"
        style={{
          opacity: isDimmed ? 0.35 : 1,
          transform: isActive ? "scale(1.06)" : "scale(1)",
          filter: isDimmed ? "saturate(0.4)" : "saturate(1)",
        }}
      >
        {/* Halo on active */}
        <div
          aria-hidden
          className="absolute inset-0 rounded-full -m-4 transition-opacity duration-500"
          style={{
            background: `radial-gradient(circle, hsl(var(${alma.toneVar}) / 0.25), transparent 70%)`,
            opacity: isActive ? 1 : 0,
          }}
        />

        {/* Card */}
        <div
          className="relative bg-cl2-paper border border-cl2-ink/10 rounded-2xl px-5 py-4 w-[210px] text-center"
          style={{
            boxShadow: isActive
              ? `0 18px 40px hsl(var(${alma.toneVar}) / 0.22), 0 4px 12px hsl(var(${alma.toneVar}) / 0.10)`
              : "0 4px 14px hsl(var(--cl2-ink) / 0.05)",
          }}
        >
          {/* Glyph orb */}
          <div
            className="absolute -top-5 left-1/2 -translate-x-1/2 w-10 h-10 rounded-full flex items-center justify-center text-[18px]"
            style={{
              background: `hsl(var(${alma.toneVar}))`,
              color: "hsl(var(--cl2-paper))",
              boxShadow: `0 6px 18px hsl(var(${alma.toneVar}) / 0.4)`,
            }}
            aria-hidden
          >
            {alma.glyph}
          </div>

          <div className="pt-3">
            <h3
              className="serif text-[26px] leading-none mb-1"
              style={{
                color: `hsl(var(${alma.toneVar}))`,
                fontStyle: "italic",
                fontWeight: 400,
                letterSpacing: "-0.018em",
              }}
            >
              {alma.name}
            </h3>
            <div className="font-mono text-[10px] uppercase tracking-widest text-cl2-ink/50 mb-3">
              {alma.role}
            </div>
            <p
              className="serif text-[13.5px] leading-snug italic"
              style={{ color: `hsl(var(${alma.toneVar}) / 0.92)`, fontWeight: 400 }}
            >
              "{alma.rule}"
            </p>
            <div
              className="mt-3 pt-3 border-t border-dashed border-cl2-ink/10 font-mono text-[10px] uppercase tracking-wider text-cl2-ink/55"
            >
              {alma.signal}
            </div>
          </div>
        </div>
      </div>
    </motion.div>
    </div>
  );
};

export const Almas = () => {
  const [hovered, setHovered] = useState<string | null>(null);
  const [offsets, setOffsets] = useState<Record<string, { x: number; y: number }>>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();

  // Escucha eventos externos: focus-alma con detail.name → resalta el alma N segundos
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ name: string }>).detail;
      if (!detail?.name) return;
      setHovered(detail.name);
      // Suelta el highlight tras un momento para no congelar el hover
      const t = setTimeout(() => setHovered(null), 2400);
      return () => clearTimeout(t);
    };
    window.addEventListener("cl2:focus-alma", handler as EventListener);
    return () => window.removeEventListener("cl2:focus-alma", handler as EventListener);
  }, []);

  const handleDrag = (name: string, offsetPx: { x: number; y: number }) => {
    const w = containerRef.current?.clientWidth ?? 900;
    const ratio = 900 / w;
    setOffsets((prev) => ({
      ...prev,
      [name]: { x: offsetPx.x * ratio, y: offsetPx.y * ratio },
    }));
  };

  return (
    <Section id="almas" eyebrow="Tres almas · un equipo" kicker="04 / quién responde">
      <Reveal>
        <div className="mb-12 max-w-[820px]">
          <h2 className="display display--lg">
            No es un chat. Son <em>tres asesores</em>
            <br />
            que leen lo mismo, distinto.
          </h2>
          <p className="lede mt-5">
            Mismo archivo en el centro, tres criterios distintos alrededor. Cada uno con su
            umbral de confianza y su forma de citar. Ninguno inventa.
          </p>
        </div>
      </Reveal>

      {/* Mobile: stacked cards — the orbit composition needs ~700px to
          breathe; below md the satellites collide with the nucleus and
          each other. Same data, vertical stack. */}
      <div className="md:hidden flex flex-col gap-10 items-stretch px-1">
        {/* Núcleo first — establishes the metaphor */}
        <div className="self-center w-full max-w-[280px] py-6 px-5 rounded-2xl bg-cl2-paper border border-cl2-ink/15 text-center" style={{ boxShadow: "0 12px 40px hsl(var(--cl2-ink) / 0.10)" }}>
          <div className="font-mono text-[9.5px] uppercase tracking-widest text-cl2-ink/45 mb-1">
            Núcleo
          </div>
          <div className="serif text-[20px] leading-tight text-cl2-ink" style={{ fontWeight: 500, letterSpacing: "-0.015em" }}>
            Archivo legislativo
          </div>
          <div className="mt-2 font-mono text-[10px] uppercase tracking-widest" style={{ color: "hsl(var(--cl2-burgundy))" }}>
            SIL · Reglamento · Plenarias
          </div>
        </div>

        {/* Three satellites stacked */}
        {almas.map((alma) => (
          <div key={alma.name} className="relative pt-7 pb-5 px-5 rounded-2xl bg-cl2-paper border border-cl2-ink/10" style={{ boxShadow: "0 4px 14px hsl(var(--cl2-ink) / 0.05)" }}>
            <div
              className="absolute -top-5 left-1/2 -translate-x-1/2 w-10 h-10 rounded-full flex items-center justify-center text-[18px]"
              style={{
                background: `hsl(var(${alma.toneVar}))`,
                color: "hsl(var(--cl2-paper))",
                boxShadow: `0 6px 18px hsl(var(${alma.toneVar}) / 0.4)`,
              }}
              aria-hidden
            >
              {alma.glyph}
            </div>
            <div className="text-center">
              <h3
                className="serif text-[26px] leading-none mb-1"
                style={{
                  color: `hsl(var(${alma.toneVar}))`,
                  fontStyle: "italic",
                  fontWeight: 400,
                  letterSpacing: "-0.018em",
                }}
              >
                {alma.name}
              </h3>
              <div className="font-mono text-[10px] uppercase tracking-widest text-cl2-ink/50 mb-3">
                {alma.role}
              </div>
              <p
                className="serif text-[14px] leading-snug italic"
                style={{ color: `hsl(var(${alma.toneVar}) / 0.92)`, fontWeight: 400 }}
              >
                "{alma.rule}"
              </p>
              <div className="mt-3 pt-3 border-t border-dashed border-cl2-ink/10 font-mono text-[10px] uppercase tracking-wider text-cl2-ink/55">
                {alma.signal}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Orbit composition — desktop only (md+) */}
      <div ref={containerRef} className="hidden md:block relative mx-auto w-full max-w-[900px] aspect-square overflow-hidden touch-none select-none">
        {/* SVG: orbit ring + connection lines */}
        <svg
          className="absolute inset-0 w-full h-full"
          viewBox="0 0 900 900"
          aria-hidden
        >
          {/* Orbit ring */}
          <circle
            cx={CENTER}
            cy={CENTER}
            r={ORBIT_R}
            fill="none"
            stroke="hsl(var(--cl2-ink) / 0.10)"
            strokeWidth="1"
            strokeDasharray="2 6"
          />
          {/* Outer hairline ring */}
          <circle
            cx={CENTER}
            cy={CENTER}
            r={ORBIT_R + 38}
            fill="none"
            stroke="hsl(var(--cl2-ink) / 0.05)"
            strokeWidth="1"
          />

          {/* Connection lines — núcleo a cada satélite */}
          {almas.map((alma) => {
            const base = polar(alma.angle, ORBIT_R);
            const off = offsets[alma.name] ?? { x: 0, y: 0 };
            const x = base.x + off.x;
            const y = base.y + off.y;
            const isActive = hovered === alma.name;
            return (
              <line
                key={alma.name}
                x1={CENTER}
                y1={CENTER}
                x2={x}
                y2={y}
                stroke={`hsl(var(${alma.toneVar}))`}
                strokeWidth={isActive ? 1.5 : 0.8}
                strokeOpacity={isActive ? 0.65 : 0.18}
                strokeDasharray={isActive ? "0" : "3 5"}
              />
            );
          })}

          {/* Tick marks on orbit */}
          {Array.from({ length: 24 }).map((_, i) => {
            const a = (i * 360) / 24;
            const inner = polar(a, ORBIT_R - 4);
            const outer = polar(a, ORBIT_R + 4);
            return (
              <line
                key={i}
                x1={inner.x}
                y1={inner.y}
                x2={outer.x}
                y2={outer.y}
                stroke="hsl(var(--cl2-ink) / 0.12)"
                strokeWidth="1"
              />
            );
          })}
        </svg>

        {/* Subtle rotation animation for the orbit ring */}
        {!reduce && (
          <motion.div
            className="absolute inset-0 pointer-events-none"
            animate={{ rotate: 360 }}
            transition={{ duration: 90, repeat: Infinity, ease: "linear" }}
          >
            <svg className="w-full h-full" viewBox="0 0 900 900" aria-hidden>
              {[0, 120, 240].map((a) => {
                const p = polar(a, ORBIT_R);
                return (
                  <circle
                    key={a}
                    cx={p.x}
                    cy={p.y}
                    r="2"
                    fill="hsl(var(--cl2-ink) / 0.25)"
                  />
                );
              })}
            </svg>
          </motion.div>
        )}

        {/* Núcleo central — el archivo */}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <motion.div
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.7 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
            className="relative"
          >
            {/* Pulse halo */}
            {!reduce && (
              <motion.div
                aria-hidden
                className="absolute inset-0 rounded-full"
                style={{ background: "hsl(var(--cl2-ink) / 0.10)" }}
                animate={{ scale: [1, 1.4, 1], opacity: [0.5, 0, 0.5] }}
                transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
              />
            )}
            <div
              className="relative w-[180px] h-[180px] rounded-full flex flex-col items-center justify-center text-center p-6 bg-cl2-paper border border-cl2-ink/15"
              style={{ boxShadow: "0 12px 40px hsl(var(--cl2-ink) / 0.10)" }}
            >
              <div className="font-mono text-[9.5px] uppercase tracking-widest text-cl2-ink/45 mb-1">
                Núcleo
              </div>
              <div
                className="serif text-[19px] leading-tight text-cl2-ink"
                style={{ fontWeight: 500, letterSpacing: "-0.015em" }}
              >
                Archivo
                <br />
                legislativo
              </div>
              <div
                className="mt-2 font-mono text-[9.5px] uppercase tracking-widest"
                style={{ color: "hsl(var(--cl2-burgundy))" }}
              >
                SIL · Reglamento · Plenarias
              </div>
            </div>
          </motion.div>
        </div>

        {/* Satellites */}
        {almas.map((alma, i) => (
          <Satellite
            key={alma.name}
            alma={alma}
            index={i}
            hovered={hovered}
            onHover={setHovered}
            onDrag={handleDrag}
          />
        ))}
      </div>
    </Section>
  );
};
