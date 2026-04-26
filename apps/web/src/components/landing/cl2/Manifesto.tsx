import { useEffect, useRef, useState } from "react";

export const Manifesto = () => {
  const ref = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const onScroll = () => {
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const vh = window.innerHeight;
      // Range: section enters viewport bottom → exits top
      const progress = (vh - rect.top) / (vh + rect.height);
      const clamped = Math.max(0, Math.min(1, progress));
      setOffset((clamped - 0.5) * 40); // ±20px
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <section
      ref={ref}
      className="section section--xl relative overflow-hidden border-b-0"
      style={{ background: "hsl(var(--cl2-burgundy-deep))", color: "hsl(var(--cl2-paper))" }}
    >
      {/* Parallax dot atmosphere */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none will-change-transform"
        style={{
          backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.04) 1px, transparent 1px)",
          backgroundSize: "5px 5px",
          transform: `translateY(${offset}px)`,
          transition: "transform 60ms linear",
        }}
      />

      <div className="shell relative">
        <div className="flex items-center gap-3 mb-14" style={{ color: "hsl(var(--cl2-paper) / 0.5)" }}>
          <span className="w-[18px] h-px" style={{ background: "hsl(var(--cl2-paper) / 0.5)" }} />
          <span className="font-mono text-[10.5px] uppercase tracking-[0.22em]">
            Manifiesto · Shift · 2026
          </span>
        </div>

        <div className="max-w-[920px]">
          <p
            className="serif mb-10"
            style={{
              fontSize: "clamp(28px, 3.6vw, 48px)",
              lineHeight: 1.22,
              fontWeight: 300,
              letterSpacing: "-0.012em",
              color: "hsl(var(--cl2-paper))",
              textWrap: "pretty" as const,
            }}
          >
            La memoria no es archivo. Es la capacidad de una institución de
            <em className="italic-serif" style={{ color: "hsl(var(--cl2-accent-soft))" }}>
              {" "}recordarse a sí misma{" "}
            </em>
            — sus debates, sus contradicciones, las posiciones que tomó cuando nadie estaba mirando.
          </p>
          <p
            className="serif mb-7"
            style={{
              fontSize: "clamp(20px, 2.2vw, 30px)",
              lineHeight: 1.4,
              fontWeight: 300,
              letterSpacing: "-0.008em",
              color: "hsl(var(--cl2-paper) / 0.82)",
            }}
          >
            Una democracia que olvida lo que ya legisló está condenada a discutir lo mismo
            cada cuatro años. Una redacción que no puede citar el folio exacto pierde la
            autoridad de su nota.
          </p>
          <p
            className="serif mb-16"
            style={{
              fontSize: "clamp(20px, 2.2vw, 30px)",
              lineHeight: 1.4,
              fontWeight: 300,
              letterSpacing: "-0.008em",
              color: "hsl(var(--cl2-paper) / 0.82)",
            }}
          >
            cl2 no es un asistente más. Es la promesa de que la próxima generación de
            asesores, periodistas y legisladores va a heredar — y no perder — el conocimiento
            que costó décadas construir.
          </p>

          <div className="flex items-center gap-4 text-[13px]" style={{ color: "hsl(var(--cl2-paper) / 0.6)" }}>
            <span className="w-8 h-px" style={{ background: "hsl(var(--cl2-paper) / 0.3)" }} />
            <span className="italic-serif">Equipo cl2</span>
            <span>·</span>
            <span className="font-mono text-[11px] tracking-wider">San José · marzo 2026</span>
          </div>
        </div>
      </div>
    </section>
  );
};
