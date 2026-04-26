import { useEffect, useRef, useState } from "react";
import { Section, Reveal } from "./Primitives";

const stats = [
  { value: 60, suffix: "%", l: "Del conocimiento de un despacho se va con el asesor que renuncia" },
  { value: 21620, suffix: "", scaleK: true, l: "Expedientes en el SIL, la mayoría sin búsqueda funcional", display: "21.6k" },
  { value: 4, suffix: "-7d", l: "Tiempo promedio para reconstruir el historial de un proyecto" },
  { value: 0, suffix: "", l: "Herramientas con citas verificables al acta original", display: "≈ 0" },
];

const Counter = ({ to, suffix, display }: { to: number; suffix: string; display?: string }) => {
  const ref = useRef<HTMLSpanElement>(null);
  const [val, setVal] = useState(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        const start = performance.now();
        const dur = 1400;
        let raf = 0;
        const tick = (now: number) => {
          const t = Math.min(1, (now - start) / dur);
          const eased = 1 - Math.pow(1 - t, 3);
          setVal(eased * to);
          if (t < 1) raf = requestAnimationFrame(tick);
          else setDone(true);
        };
        raf = requestAnimationFrame(tick);
        obs.disconnect();
        return () => cancelAnimationFrame(raf);
      },
      { threshold: 0.4 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [to]);

  if (display && done) return <span ref={ref}>{display}{suffix}</span>;
  if (display && !done) return <span ref={ref}>{Math.round(val).toLocaleString("es-CR")}</span>;
  return <span ref={ref}>{Math.round(val).toLocaleString("es-CR")}{suffix}</span>;
};

export const Problem = () => (
  <Section id="problema" eyebrow="El problema" kicker="01 / la memoria">
    <div className="grid gap-12 md:gap-20 md:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] items-start">
      <Reveal>
        <h2 className="display display--lg">
          Cada cuatro años, la Asamblea pierde
          <br />
          <em>su propia memoria.</em>
        </h2>
      </Reveal>

      <Reveal delay={120}>
        <div className="pt-3 text-[16px] leading-[1.65] text-cl2-ink/[0.78] flex flex-col gap-4">
          <p>
            El conocimiento institucional vive en cabezas, en carpetas compartidas, en chats que
            nadie más puede leer. Cuando un asesor se va — y se van seguido — el despacho pierde
            años de criterio, posiciones tomadas, debates ganados.
          </p>
          <p>
            La Asamblea legisla sobre lo que ya legisló. Las comisiones repiten preguntas que ya
            fueron respondidas. La prensa busca en PDFs lo que algún archivo digital ya tenía.
          </p>
        </div>
      </Reveal>
    </div>

    <Reveal delay={200}>
      <div className="mt-20 grid grid-cols-2 md:grid-cols-4 border-t border-b border-cl2-ink/10">
        {stats.map((s, i) => (
          <div
            key={i}
            className={`p-7 group transition-colors hover:bg-cl2-burgundy/[0.02] ${
              i < 3 ? "md:border-r md:border-cl2-ink/10" : ""
            } ${i % 2 === 0 ? "border-r border-cl2-ink/10 md:border-r" : ""} ${
              i < 2 ? "border-b border-cl2-ink/10 md:border-b-0" : ""
            }`}
          >
            <div
              className="serif text-[44px] leading-none text-cl2-burgundy"
              style={{ letterSpacing: "-0.02em" }}
            >
              <Counter to={s.value} suffix={s.suffix} display={s.display} />
            </div>
            <div className="mt-3 text-[12.5px] leading-snug text-cl2-ink/65">{s.l}</div>
          </div>
        ))}
      </div>
    </Reveal>

    <p className="mt-6 text-[11.5px] text-cl2-ink/40 font-mono">
      * Estimaciones del piloto cl2 · Asamblea Legislativa de Costa Rica · 2025-2026
    </p>
  </Section>
);
