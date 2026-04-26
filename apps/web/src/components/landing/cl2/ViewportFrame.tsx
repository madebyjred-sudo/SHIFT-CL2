import { useState, useEffect } from "react";
import { Icon } from "./Icon";

const links = [
  ["Producto", "producto"],
  ["Probar", "demo"],
  ["Comparativa", "comparativa"],
  ["Prueba viva", "prueba"],
  ["Preguntas", "faq"],
] as const;

const FRAME = 8; // grosor del marco
const PILL_MAX = 1100;
const PILL_HEIGHT = 64;

export const ViewportFrame = () => {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Material del marco (mismo que el pill): paper translúcido, blur sutil, borde, shadow gentle.
  // Se aplica POR BANDA — cada banda es delgada, así el blur sólo afecta al material del marco.
  const bg = scrolled ? "bg-cl2-paper/90" : "bg-cl2-paper/80";
  const bandShadow =
    "shadow-[inset_0_0_0_1px_hsl(var(--cl2-ink)/0.06),0_8px_24px_-16px_hsl(var(--cl2-ink)/0.18)]";
  const bandBase = `absolute backdrop-blur-md ${bg} ${bandShadow} transition-colors duration-300`;

  return (
    <>
      {/* Banda izquierda */}
      <div
        aria-hidden
        className={`${bandBase} top-0 bottom-0 left-0 z-40 pointer-events-none`}
        style={{ width: FRAME }}
      />
      {/* Banda derecha */}
      <div
        aria-hidden
        className={`${bandBase} top-0 bottom-0 right-0 z-40 pointer-events-none`}
        style={{ width: FRAME }}
      />
      {/* Banda inferior */}
      <div
        aria-hidden
        className={`${bandBase} left-0 right-0 bottom-0 z-40 pointer-events-none`}
        style={{ height: FRAME }}
      />

      {/* Banda superior izquierda — del borde hasta donde nace el pill */}
      <div
        aria-hidden
        className={`${bandBase} top-0 left-0 z-40 pointer-events-none`}
        style={{
          height: FRAME,
          right: `calc(50% + ${PILL_MAX / 2}px - 1px)`,
        }}
      />
      {/* Banda superior derecha */}
      <div
        aria-hidden
        className={`${bandBase} top-0 right-0 z-40 pointer-events-none`}
        style={{
          height: FRAME,
          left: `calc(50% + ${PILL_MAX / 2}px - 1px)`,
        }}
      />

      {/* Pill superior — mismo material, abultamiento del marco */}
      <div
        className="fixed top-0 left-1/2 -translate-x-1/2 z-50 w-full"
        style={{ maxWidth: PILL_MAX }}
      >
        <div
          className={`pointer-events-auto ${bg} backdrop-blur-md border border-t-0 border-cl2-ink/[0.10] rounded-b-2xl ${bandShadow} flex items-center justify-between px-5 sm:px-7 transition-colors duration-300`}
          style={{ minHeight: PILL_HEIGHT, paddingTop: 10, paddingBottom: 8 }}
        >
          <a
            href="#"
            className="flex items-center gap-2 font-display text-[22px] text-cl2-ink"
            aria-label="cl2 — inicio"
          >
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
              className="hidden sm:inline-flex btn btn-coral text-[13px] px-4 py-2"
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
          <div className="pointer-events-auto md:hidden mx-3 mt-1 rounded-2xl border border-cl2-ink/[0.10] bg-cl2-paper/95 backdrop-blur-md shadow-[0_12px_30px_-14px_hsl(var(--cl2-ink)/0.22)]">
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
    </>
  );
};
