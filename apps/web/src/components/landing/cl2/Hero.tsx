import { Icon } from "./Icon";
import { HeroDashboard } from "./HeroDashboard";
import { Reveal } from "./Primitives";
import { DottedSurface } from "@/components/landing/ui/dotted-surface";

export const Hero = () => (
  <section className="relative overflow-hidden pt-24 md:pt-32 pb-0 border-b border-cl2-ink/[0.06]">
    {/* Sutil malla de puntos animada en el fondo */}
    <DottedSurface
      className="z-0"
      speed={0.015}
      amplitude={22}
      opacity={0.2}
      dotSize={6}
      dotColor={{ r: 90, g: 30, b: 40 }}
    />
    {/* Fade muy suave solo en los bordes para integrar */}
    <div
      aria-hidden
      className="absolute inset-0 z-[1] pointer-events-none"
      style={{
        background:
          "radial-gradient(ellipse 110% 95% at 50% 55%, transparent 55%, hsl(var(--cl2-paper) / 0.5) 92%, hsl(var(--cl2-paper)) 100%)",
      }}
    />
    <div className="shell relative z-10">
      <div className="flex flex-col items-center text-center pt-10">
        <Reveal>
          <h1
            className="display"
            style={{
              fontSize: "clamp(40px, 6.5vw, 88px)",
              lineHeight: 1.04,
              fontWeight: 400,
              letterSpacing: "-0.022em",
              maxWidth: 1100,
              marginBottom: 28,
              textWrap: "balance" as const,
            }}
          >
            El mejor preparado de la sala.
            <br />
            <em className="italic-serif text-cl2-burgundy">
              Cada votación, cada audiencia, cada nota.
            </em>
          </h1>
        </Reveal>

        <Reveal delay={120}>
          <p className="lede" style={{ maxWidth: 720, marginBottom: 48 }}>
            Trabajá un proyecto entero en un solo espacio. Consultá rápido durante la sesión y citá al folio. Recibí aviso cuando algo importante cambia — antes que nadie. Para diputados, asesoras y equipos de fracción de Costa Rica.
          </p>
        </Reveal>

        {/* Live demo inside Mac frame */}
        <Reveal delay={200}>
          <div className="relative w-full mx-auto" style={{ maxWidth: 1180 }}>
            <div
              aria-hidden
              className="absolute pointer-events-none z-0"
              style={{
                left: "50%",
                top: "-8%",
                transform: "translateX(-50%)",
                width: "94%",
                height: "110%",
                background:
                  "radial-gradient(ellipse 60% 50% at 50% 30%, hsl(var(--cl2-burgundy) / 0.18), transparent 65%), radial-gradient(ellipse 35% 30% at 30% 50%, hsl(var(--cl2-accent) / 0.10), transparent 70%)",
                filter: "blur(40px)",
              }}
            />
            <div className="relative z-10">
              <HeroDashboard />
            </div>
          </div>
        </Reveal>

        {/* CTA below the frame */}
        <Reveal delay={320}>
          <div className="flex flex-col items-center gap-5 mt-12 mb-20">
            <a href="#waitlist" className="btn btn-coral" style={{ padding: "14px 26px", fontSize: 14 }}>
              Solicitar acceso al piloto <Icon name="arrow-right" size={14} />
            </a>
            <div className="flex items-center gap-3.5 flex-wrap justify-center font-mono text-[10.5px] text-cl2-ink/45 uppercase tracking-wider">
              <span>Acceso por invitación</span>
              <span className="w-[3px] h-[3px] rounded-full bg-cl2-ink/25" />
              <span>Sin cobro durante el piloto</span>
              <span className="w-[3px] h-[3px] rounded-full bg-cl2-ink/25" />
              <span>Respuesta en 48h</span>
            </div>
          </div>
        </Reveal>
      </div>
    </div>

    <div
      aria-hidden
      className="absolute left-0 right-0 bottom-0 h-20 pointer-events-none z-[1]"
      style={{ background: "linear-gradient(to bottom, transparent, hsl(var(--cl2-paper)))" }}
    />
  </section>
);
