import { useState, useEffect } from "react";
import { Icon } from "./Icon";

const links = [
  ["Producto", "producto"],
  ["Probar", "demo"],
  ["Comparativa", "comparativa"],
  ["Prueba viva", "prueba"],
  ["Preguntas", "faq"],
] as const;

export const Nav = () => {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 pointer-events-none">
      <div className="shell">
        <div
          className={`pointer-events-auto mx-auto flex items-center justify-between min-h-[64px] pt-3 pb-2 px-4 sm:px-6 rounded-b-2xl rounded-t-none border border-t-0 border-cl2-ink/[0.07] backdrop-blur-xl transition-all duration-300 ${
            scrolled
              ? "bg-cl2-paper/85 shadow-[0_10px_30px_-12px_hsl(var(--cl2-ink)/0.18)]"
              : "bg-cl2-paper/70 shadow-[0_6px_20px_-12px_hsl(var(--cl2-ink)/0.12)]"
          }`}
          style={{ maxWidth: 1100 }}
        >
        <a href="#" className="flex items-center gap-2 font-display text-[22px] text-cl2-ink" aria-label="cl2 — inicio">
          <span className="dot dot-coral" />
          <span>
            cl<em className="italic-serif text-cl2-burgundy">2</em>
          </span>
        </a>

        <div className="hidden md:flex items-center gap-7">
          {links.map(([label, id]) => (
            <a
              key={id}
              href={`#${id}`}
              className="text-[13px] text-cl2-ink/65 hover:text-cl2-ink transition-colors"
            >
              {label}
            </a>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <a
            href="#waitlist"
            className="hidden sm:inline-flex btn btn-coral text-[13px] px-4 py-2.5"
          >
            Solicitar acceso <Icon name="arrow-right" size={13} />
          </a>
          <button
            onClick={() => setOpen(!open)}
            aria-label="Abrir menú"
            className="md:hidden p-2 text-cl2-ink"
          >
            <Icon name={open ? "x" : "menu"} size={20} />
          </button>
        </div>
        </div>

        {open && (
          <div
            className="pointer-events-auto md:hidden mx-auto mt-1 rounded-2xl border border-cl2-ink/[0.07] bg-cl2-paper/95 backdrop-blur-xl shadow-[0_10px_30px_-12px_hsl(var(--cl2-ink)/0.18)]"
            style={{ maxWidth: 1100 }}
          >
            <div className="px-4 py-4 flex flex-col gap-3">
              {links.map(([label, id]) => (
                <a
                  key={id}
                  href={`#${id}`}
                  onClick={() => setOpen(false)}
                  className="text-[14px] text-cl2-ink/80 py-1"
                >
                  {label}
                </a>
              ))}
              <a
                href="#waitlist"
                onClick={() => setOpen(false)}
                className="btn btn-coral text-[13px] px-4 py-2.5 mt-2 self-start"
              >
                Solicitar acceso <Icon name="arrow-right" size={13} />
              </a>
            </div>
          </div>
        )}
      </div>
    </nav>
  );
};
