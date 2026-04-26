import { useState, useRef, useEffect, type ReactElement, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/* ─── Eyebrow ─────────────────────────────── */
export const Eyebrow = ({ children, marker = true, className }: { children: ReactNode; marker?: boolean; className?: string }) => (
  <span className={cn("eyebrow", className)}>
    {marker && <span className="marker" />}
    {children}
  </span>
);

/* ─── Section ─────────────────────────────── */
export const Section = ({
  id,
  eyebrow,
  kicker,
  narrow,
  tight,
  xl,
  children,
  className,
}: {
  id?: string;
  eyebrow?: ReactNode;
  kicker?: ReactNode;
  narrow?: boolean;
  tight?: boolean;
  xl?: boolean;
  children: ReactNode;
  className?: string;
}) => (
  <section
    id={id}
    className={cn("section", tight && "section--tight", xl && "section--xl", className)}
  >
    <div className={narrow ? "shell--narrow" : "shell"}>
      {(eyebrow || kicker) && (
        <div className="flex items-baseline justify-between mb-9 gap-6 flex-wrap">
          {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : <span />}
          {kicker && <span className="meta-tag">{kicker}</span>}
        </div>
      )}
      {children}
    </div>
  </section>
);

/* ─── Citation pill with hover popover ─────── */
export const Cite = ({ refLabel, source }: { refLabel: string; source?: string }) => {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-block align-baseline">
      <span
        className="cite"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        {refLabel}
      </span>
      {open && source && (
        <span
          className="absolute left-1/2 -translate-x-1/2 z-20 whitespace-nowrap rounded-lg px-3 py-2 font-sans text-[11px] font-normal text-cl2-paper shadow-lg"
          style={{ bottom: "calc(100% + 8px)", background: "hsl(var(--cl2-ink))" }}
        >
          {source}
        </span>
      )}
    </span>
  );
};

/* ─── Reveal on scroll ─────────────────────── */
export const Reveal = ({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setTimeout(() => setVisible(true), delay);
          obs.disconnect();
        }
      },
      { threshold: 0.12 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [delay]);
  return (
    <div ref={ref} className={cn("reveal", visible && "is-visible", className)}>
      {children}
    </div>
  );
};

/* ─── Render text with [acta NN §NN] / [exp. ...] citations ─ */
export function renderWithCitations(text: string) {
  const re = /\[(acta\s+\d+\s+§\s*\d+|exp\.?\s+[\d.]+\s+fl\.?\s+[\d.]+)\]/gi;
  const parts: (string | ReactElement)[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(<Cite key={i++} refLabel={m[1]} source="Demo · cita ilustrativa" />);
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
