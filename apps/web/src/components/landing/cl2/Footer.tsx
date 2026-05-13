import { useState, ReactNode, ComponentProps } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Mail, LifeBuoy, Activity } from "lucide-react";
import { Icon } from "./Icon";
import { Eyebrow } from "./Primitives";
import { Cl2Mark } from "@/components/Cl2Mark";

interface FooterLink {
  title: string;
  href: string;
  icon?: React.ComponentType<{ className?: string }>;
}

interface FooterSection {
  label: string;
  links: FooterLink[];
}

const footerLinks: FooterSection[] = [
  {
    label: "Producto",
    links: [
      { title: "Capacidades", href: "#producto" },
      { title: "Citabilidad", href: "#citabilidad" },
      { title: "Comparativa", href: "#comparativa" },
      { title: "Caso real", href: "#prueba" },
    ],
  },
  {
    label: "Institucional",
    links: [
      { title: "Preguntas frecuentes", href: "#faq" },
      { title: "Manifiesto", href: "#manifiesto" },
      { title: "Términos", href: "#" },
      { title: "Seguridad", href: "#" },
    ],
  },
  {
    label: "Acceso",
    links: [
      { title: "Solicitar piloto", href: "#waitlist", icon: Mail },
      { title: "Soporte", href: "mailto:soporte@shift.cr", icon: LifeBuoy },
      { title: "Estado del servicio", href: "#", icon: Activity },
    ],
  },
];

const Field = ({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) => (
  <label className="flex flex-col gap-1.5">
    <span className="text-[11px] text-cl2-ink/60 uppercase tracking-wider font-semibold">
      {label}
      {required && <span className="text-cl2-accent"> *</span>}
    </span>
    {children}
  </label>
);

type ViewAnimationProps = {
  delay?: number;
  className?: ComponentProps<typeof motion.div>["className"];
  children: ReactNode;
};

function AnimatedContainer({ className, delay = 0.1, children }: ViewAnimationProps) {
  const shouldReduceMotion = useReducedMotion();
  if (shouldReduceMotion) return <>{children}</>;
  return (
    <motion.div
      initial={{ filter: "blur(4px)", y: 12, opacity: 0 }}
      whileInView={{ filter: "blur(0px)", y: 0, opacity: 1 }}
      viewport={{ once: true }}
      transition={{ delay, duration: 0.7 }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

export const Footer = () => {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("");
  const [org, setOrg] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setSubmitted(true);
  };

  return (
    <>
      {/* Waitlist CTA */}
      <section id="waitlist" className="section bg-cl2-paper border-b border-cl2-ink/[0.06]">
        <div className="shell">
          <div className="grid gap-10 md:gap-16 md:grid-cols-2 items-start">
            <div>
              <Eyebrow>Solicitar acceso al piloto</Eyebrow>
              <h2 className="display display--lg mt-5 mb-5">
                Acceso por invitación.
                <br />
                <em>Revisamos cada solicitud.</em>
              </h2>
              <p className="text-[15px] leading-[1.65] text-cl2-ink/70 max-w-[460px]">
                Estamos abriendo el piloto a redacciones, despachos legislativos, observatorios
                y centros de pensamiento. Contános quién sos y para qué necesitás cl2 — la
                primera respuesta llega en menos de 48h.
              </p>
              <div className="mt-8 flex gap-6 text-cl2-ink/55 text-[12px] flex-wrap">
                {["Sin cobro durante el piloto", "Soporte directo del equipo", "Influís en el roadmap"].map((t) => (
                  <div key={t} className="flex items-center gap-2">
                    <Icon name="check" size={13} className="cmp-check" />
                    {t}
                  </div>
                ))}
              </div>
            </div>

            <form onSubmit={submit} className="cl2-card p-7">
              {submitted ? (
                <div className="py-4">
                  <div
                    className="w-11 h-11 rounded-xl flex items-center justify-center mb-4"
                    style={{ background: "hsl(142 71% 41% / 0.1)", color: "hsl(142 71% 41%)" }}
                  >
                    <Icon name="check" size={22} stroke={2} />
                  </div>
                  <h3 className="serif text-[22px] text-cl2-ink mb-2" style={{ fontWeight: 500, letterSpacing: "-0.01em" }}>
                    Solicitud recibida.
                  </h3>
                  <p className="text-[14px] text-cl2-ink/70 leading-[1.6]">
                    Te respondemos a{" "}
                    <span className="font-mono text-cl2-burgundy">{email}</span> en menos de 48h
                    hábiles. Si tu institución ya está en el piloto, vas a recibir un enlace de
                    invitación directo.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-3.5">
                  <Field label="Email institucional" required>
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="vos@redaccion.cr"
                      className="cl2-input"
                    />
                  </Field>
                  <Field label="Rol">
                    <select value={role} onChange={(e) => setRole(e.target.value)} className="cl2-input">
                      <option value="">Seleccioná…</option>
                      <option>Periodista / editor</option>
                      <option>Asesor / a legislativo</option>
                      <option>Investigador / a</option>
                      <option>Equipo institucional</option>
                      <option>Otro</option>
                    </select>
                  </Field>
                  <Field label="Organización">
                    <input
                      value={org}
                      onChange={(e) => setOrg(e.target.value)}
                      placeholder="Medio, despacho, observatorio…"
                      className="cl2-input"
                    />
                  </Field>
                  <button type="submit" className="btn btn-coral mt-2 justify-center w-full px-4 py-3 text-[14px]">
                    Solicitar acceso <Icon name="arrow-right" size={14} />
                  </button>
                  <p className="text-[11px] text-cl2-ink/50 leading-snug mt-1">
                    Al enviar aceptás que el equipo de cl2 te contacte por este medio. No vamos
                    a usar tu email para nada más.
                  </p>
                </div>
              )}
            </form>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer
        className="relative md:rounded-t-3xl overflow-hidden pt-16 pb-9"
        style={{ background: "hsl(var(--cl2-burgundy-deep))", color: "hsl(var(--cl2-paper) / 0.7)" }}
      >
        {/* Atmospheric glow */}
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 h-px"
          style={{
            background:
              "linear-gradient(90deg, transparent, hsl(var(--cl2-paper) / 0.18), transparent)",
          }}
        />
        <div
          aria-hidden
          className="absolute -top-32 left-1/2 -translate-x-1/2 w-[640px] h-[320px] pointer-events-none opacity-40"
          style={{
            background:
              "radial-gradient(ellipse at center, hsl(var(--cl2-accent) / 0.18), transparent 70%)",
          }}
        />
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none opacity-[0.5]"
          style={{
            backgroundImage:
              "radial-gradient(circle, hsl(var(--cl2-paper) / 0.04) 1px, transparent 1px)",
            backgroundSize: "5px 5px",
          }}
        />

        <div className="shell relative">
          <div className="grid w-full gap-10 xl:grid-cols-3 xl:gap-16">
            {/* Brand */}
            <AnimatedContainer className="space-y-5">
              <div className="flex items-center gap-3">
                <Cl2Mark size={44} className="rounded-xl shrink-0" />
                <div
                  className="serif text-[34px] leading-none"
                  style={{ color: "hsl(var(--cl2-paper))", fontWeight: 500, letterSpacing: "-0.02em" }}
                >
                  cl
                  <em className="italic-serif" style={{ color: "hsl(var(--cl2-accent-soft))" }}>
                    2
                  </em>
                </div>
              </div>
              <p className="text-[13px] leading-[1.65] max-w-[340px]">
                Inteligencia legislativa con memoria institucional para la Asamblea Legislativa
                de Costa Rica.
              </p>
              <p
                className="text-[11px] font-mono uppercase tracking-wider"
                style={{ color: "hsl(var(--cl2-paper) / 0.45)" }}
              >
                Un proyecto de Shift
              </p>
              <p className="text-[12px] mt-6" style={{ color: "hsl(var(--cl2-paper) / 0.55)" }}>
                © {new Date().getFullYear()} Shift S.A. · San José · Costa Rica
              </p>
            </AnimatedContainer>

            {/* Link columns */}
            <div className="mt-8 grid grid-cols-2 gap-8 md:grid-cols-3 xl:col-span-2 xl:mt-0">
              {footerLinks.map((section, i) => (
                <AnimatedContainer key={section.label} delay={0.1 + i * 0.1}>
                  <div
                    className="text-[11px] uppercase tracking-widest mb-4 font-semibold"
                    style={{ color: "hsl(var(--cl2-paper) / 0.5)" }}
                  >
                    {section.label}
                  </div>
                  <ul className="flex flex-col gap-2.5 text-[13px]">
                    {section.links.map((link) => (
                      <li key={link.title}>
                        <a
                          href={link.href}
                          className="inline-flex items-center gap-2 transition-colors hover:text-cl2-paper"
                          style={{ color: "hsl(var(--cl2-paper) / 0.75)" }}
                        >
                          {link.icon && <link.icon className="w-3.5 h-3.5" />}
                          {link.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                </AnimatedContainer>
              ))}
            </div>
          </div>

          {/* Build line */}
          <div
            className="mt-14 pt-7 flex justify-between items-center gap-6 flex-wrap text-[11px]"
            style={{
              borderTop: "1px solid hsl(var(--cl2-paper) / 0.1)",
              color: "hsl(var(--cl2-paper) / 0.5)",
            }}
          >
            <div className="font-mono tracking-wider">
              Construido con archivo público · 27 años indexados
            </div>
            <div className="flex items-center gap-3.5 font-mono text-[10.5px]">
              <span className="dot dot-coral live-dot" style={{ width: 6, height: 6 }} />
              <span>cl2 · v1.0.0 · alpha</span>
              <span>·</span>
              <span>build 4f3a91d</span>
            </div>
          </div>
        </div>

        {/* Giant decorative wordmark */}
        <AnimatedContainer
          delay={0.3}
          className="pointer-events-none select-none mt-14 hidden md:block"
        >
          <div
            className="serif text-center leading-none"
            style={{
              fontSize: "clamp(120px, 22vw, 320px)",
              letterSpacing: "-0.04em",
              fontWeight: 500,
              background:
                "linear-gradient(180deg, hsl(var(--cl2-paper) / 0.08), hsl(var(--cl2-paper) / 0))",
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              color: "transparent",
            }}
          >
            cl
            <em className="italic-serif">2</em>
          </div>
        </AnimatedContainer>
      </footer>
    </>
  );
};
