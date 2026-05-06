/**
 * CtaCloser — cierre antes del Manifesto.
 *
 * Combina dos principios:
 *   • Scarcity honesta: "diez fracciones en 2026, acceso revisado a mano".
 *     Crea urgencia sin mentir; las fracciones de la Asamblea son contables.
 *   • Foot-in-the-door: el CTA es "solicitar acceso" (compromiso bajo),
 *     no "registrate" o "comprá". Una respuesta humana en 48h sigue.
 *
 * Encaja entre LiveProof y Manifesto. Tono editorial — paper background
 * con un acento burgundy en el contador, no gradientes ni glassmorphism.
 */
import { Icon } from "./Icon";
import { Section, Reveal } from "./Primitives";

const ESPACIOS_TOTALES = 10;
const ESPACIOS_OCUPADOS = 3; // ajustable cuando entre cada fracción real

export const CtaCloser = () => {
  const disponibles = ESPACIOS_TOTALES - ESPACIOS_OCUPADOS;

  return (
    <Section id="acceso" eyebrow="Acceso" kicker="06 / cómo entrar">
      <div className="max-w-[760px] mx-auto text-center">
        {/* Scarcity indicator */}
        <Reveal>
          <div className="inline-flex items-center gap-3 px-4 py-2 rounded-full border border-cl2-burgundy/20 bg-cl2-burgundy/[0.03] mb-10">
            <span className="flex items-center gap-1">
              {Array.from({ length: ESPACIOS_TOTALES }).map((_, i) => (
                <span
                  key={i}
                  className={`w-1.5 h-1.5 rounded-full transition-colors ${
                    i < ESPACIOS_OCUPADOS
                      ? "bg-cl2-burgundy"
                      : "bg-cl2-burgundy/20"
                  }`}
                  aria-hidden
                />
              ))}
            </span>
            <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-cl2-ink/65">
              {disponibles} de {ESPACIOS_TOTALES} cupos disponibles · piloto 2026
            </span>
          </div>
        </Reveal>

        {/* Headline */}
        <Reveal delay={120}>
          <h2
            className="display"
            style={{
              fontSize: "clamp(36px, 5.4vw, 64px)",
              lineHeight: 1.1,
              fontWeight: 400,
              letterSpacing: "-0.018em",
              marginBottom: 22,
              textWrap: "balance" as const,
            }}
          >
            Diez fracciones de la Asamblea,
            <br />
            <em className="italic-serif text-cl2-burgundy">
              entran al piloto en 2026.
            </em>
          </h2>
        </Reveal>

        {/* Sub */}
        <Reveal delay={200}>
          <p
            className="serif mx-auto"
            style={{
              fontSize: "clamp(17px, 1.6vw, 21px)",
              lineHeight: 1.55,
              fontWeight: 300,
              color: "hsl(var(--cl2-ink) / 0.72)",
              maxWidth: 580,
              marginBottom: 40,
            }}
          >
            Acceso por invitación. Revisamos cada solicitud manualmente —
            buscamos despachos que quieran trabajar serio, no probar diez
            herramientas.
          </p>
        </Reveal>

        {/* CTA */}
        <Reveal delay={300}>
          <a
            href="#waitlist"
            className="btn btn-coral inline-flex items-center gap-2"
            style={{ padding: "16px 32px", fontSize: 14 }}
          >
            Solicitar acceso al piloto <Icon name="arrow-right" size={14} />
          </a>
        </Reveal>

        {/* Tertiary copy */}
        <Reveal delay={400}>
          <div className="flex items-center gap-3.5 flex-wrap justify-center mt-6 font-mono text-[10.5px] text-cl2-ink/45 uppercase tracking-wider">
            <span>Sin cobro durante el piloto</span>
            <span className="w-[3px] h-[3px] rounded-full bg-cl2-ink/25" />
            <span>Respuesta en 48 horas</span>
            <span className="w-[3px] h-[3px] rounded-full bg-cl2-ink/25" />
            <span>Aplicación revisada a mano</span>
          </div>
        </Reveal>
      </div>
    </Section>
  );
};
