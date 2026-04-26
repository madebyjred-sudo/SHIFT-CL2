/**
 * /landing — public marketing surface.
 *
 * Public route: renders BEFORE the auth gate in App.tsx. Eventually the
 * apex agentescl2.com will 302 / serve this content; for now we live
 * under /landing alongside the SPA.
 *
 * Copy follows docs/LANDING-CONTEXT.md. Hard rules:
 *   - Spanish from Costa Rica (vos, acá, plenario, fracción, dictamen)
 *   - Editorial, NOT corporate. Newsreader display + Figtree body.
 *   - NO AI hype. NO "RAG/embeddings/vector". NO "powered by GPT/Claude".
 *   - Concrete verifiable numbers only. If unsure, "decenas de miles".
 *   - "el operador escribe lineamientos editoriales" — never "extracts
 *     insights from your conversations". The flywheel narrative is
 *     internal-only.
 *   - CTA = "Agendá una demo de 30 minutos", NOT "regístrate gratis".
 *
 * Hero embeds <DemoChatFrame> — a real conversation against /api/public/
 * demo-chat (Lexa, capped at 5 prompts/IP/24h with extra server-side
 * safeguards). Visitors see the product, not a video.
 */
import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import {
  ArrowRight,
  Calendar,
  CheckCircle2,
  FileText,
  Library,
  Radio,
  Scale,
  ShieldCheck,
  Sparkles,
  Sun,
  Moon,
} from 'lucide-react';
import { useTheme } from '@/lib/theme-context';
import { navigate } from '@/lib/router';
import { cn } from '@/lib/utils';
import { DemoChatFrame } from '@/components/landing/DemoChatFrame';

// Calendly placeholder. Swap when the real link is provisioned.
const DEMO_URL = 'https://calendly.com/shift-cl2/demo-30min';

export function LandingPage() {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-mesh text-[#0e1745] dark:text-white font-sans relative overflow-x-hidden transition-colors duration-500">
      <div className="pointer-events-none absolute inset-0 bg-pixel-dots opacity-50 z-0" />
      <LandingNav />
      <main className="relative z-10">
        <Hero />
        <Problem />
        <Capabilities />
        <ThreeSouls />
        <Comparison />
        <DespachoMemory />
        <Manifesto />
        <FinalCta />
      </main>
      <LandingFooter />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Nav
// ─────────────────────────────────────────────────────────────────────

function LandingNav() {
  const { theme, toggleTheme } = useTheme();
  return (
    <header className="sticky top-0 z-[80] px-4 sm:px-6 md:px-8 pt-3">
      <div className="mx-auto max-w-[1280px] rounded-2xl border border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white/80 dark:bg-[#231f1f]/80 backdrop-blur-md shadow-[0_4px_20px_rgba(14,23,69,0.04)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.18)] px-3 md:px-4 py-2 md:py-2.5 flex items-center justify-between gap-3">
        <a href="/landing" className="flex items-center gap-2.5 min-w-0">
          <div className="relative h-9 w-9 rounded-xl overflow-hidden shrink-0">
            <div className="absolute inset-0 bg-gradient-to-br from-cl2-accent to-cl2-accent-soft" />
            <div
              className="absolute inset-0 opacity-30"
              style={{
                backgroundImage:
                  'radial-gradient(circle, rgba(255,255,255,0.4) 1px, transparent 1px)',
                backgroundSize: '5px 5px',
              }}
            />
            <div className="relative h-full w-full flex items-center justify-center text-white font-heading font-extrabold text-xs tracking-tight">
              CL2
            </div>
          </div>
          <div className="hidden sm:flex flex-col leading-tight">
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#0e1745]/40 dark:text-white/40">
              Inteligencia Legislativa
            </span>
            <span className="text-[11.5px] font-medium text-[#0e1745]/75 dark:text-white/75">
              Asamblea de Costa Rica
            </span>
          </div>
        </a>

        <nav className="hidden md:flex items-center gap-1">
          <NavLink href="#problema">El problema</NavLink>
          <NavLink href="#tres-almas">Los tres asesores</NavLink>
          <NavLink href="#comparativa">Antes / con CL2</NavLink>
          <NavLink href="#memoria">Memoria curada</NavLink>
        </nav>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={toggleTheme}
            className="h-9 w-9 flex items-center justify-center rounded-full bg-white/70 dark:bg-white/5 hover:bg-white dark:hover:bg-white/10 border border-white/70 dark:border-white/10 text-[#0e1745]/60 dark:text-white/60 hover:text-[#0e1745] dark:hover:text-white transition-all"
            aria-label="Cambiar tema"
          >
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
          <button
            type="button"
            onClick={() => navigate('/')}
            className="hidden sm:inline-flex h-9 px-3 items-center text-[12.5px] font-medium text-[#0e1745]/75 dark:text-white/75 hover:text-[#0e1745] dark:hover:text-white transition-colors"
          >
            Ingresar
          </button>
          <a
            href={DEMO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-md bg-cl2-accent hover:bg-cl2-accent-hover text-white text-[12.5px] font-semibold shadow-sm transition-colors"
          >
            <Calendar size={13} />
            Agendar demo
          </a>
        </div>
      </div>
    </header>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      className="px-3 py-1.5 rounded-md text-[12.5px] font-medium text-[#0e1745]/65 dark:text-white/65 hover:text-[#0e1745] dark:hover:text-white hover:bg-[#0e1745]/[0.04] dark:hover:bg-white/[0.06] transition-colors"
    >
      {children}
    </a>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Hero — display headline, then the live demo. Lede sits between to
// frame what the visitor is about to interact with.
// ─────────────────────────────────────────────────────────────────────

function Hero() {
  const reduced = useReducedMotion();
  return (
    <section className="px-4 sm:px-6 md:px-8 pt-12 md:pt-20 pb-16 md:pb-24">
      <div className="mx-auto max-w-[1280px]">
        <motion.div
          initial={reduced ? false : { opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          className="text-center max-w-[920px] mx-auto"
        >
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-cl2-accent/30 bg-cl2-accent/[0.06] text-cl2-accent dark:text-cl2-accent-soft text-[11px] font-semibold uppercase tracking-[0.18em] mb-7">
            <Sparkles size={11} />
            Inteligencia legislativa · Costa Rica
          </div>
          <h1 className="font-display font-light text-[42px] sm:text-[60px] md:text-[78px] leading-[1.02] tracking-[-0.02em] text-[#0e1745] dark:text-white">
            Tu despacho ya{' '}
            <em className="not-italic font-normal italic text-cl2-burgundy dark:text-cl2-accent-soft">
              pensó esto antes
            </em>
            . CL2 lo recuerda.
          </h1>
          <p className="mt-7 max-w-[62ch] mx-auto text-[16.5px] md:text-[18px] leading-[1.6] text-[#0e1745]/72 dark:text-white/72">
            Tres asesores legislativos especializados que leen el SIL, el Reglamento y las
            plenarias en vivo — y aprenden cómo le gusta trabajar a tu despacho. Cada
            respuesta lleva la cita.{' '}
            <span className="text-[#0e1745] dark:text-white font-medium">
              Si no la encuentran, te dicen que no la encontraron.
            </span>
          </p>
        </motion.div>

        {/* Live demo */}
        <motion.div
          initial={reduced ? false : { opacity: 0, y: 28 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.85, delay: 0.18, ease: [0.22, 1, 0.36, 1] }}
          className="relative mt-12 md:mt-16 max-w-[1180px] mx-auto"
        >
          <div
            aria-hidden
            className="absolute inset-0 -z-10 pointer-events-none"
            style={{
              background:
                'radial-gradient(ellipse 60% 50% at 50% 35%, rgba(122,59,71,0.16), transparent 65%), radial-gradient(ellipse 35% 30% at 30% 50%, rgba(249,53,73,0.08), transparent 70%)',
              filter: 'blur(40px)',
            }}
          />
          <DemoChatFrame />
          <p className="mt-5 text-center text-[11.5px] font-mono uppercase tracking-[0.18em] text-[#0e1745]/45 dark:text-white/45">
            Conversación real con Lexa · 5 consultas de demo · sin registro
          </p>
        </motion.div>

        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <a
            href={DEMO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="group inline-flex items-center gap-2 px-5 py-3 rounded-md bg-cl2-accent hover:bg-cl2-accent-hover text-white text-[14px] font-semibold shadow-sm transition-colors"
          >
            Solicitar acceso al piloto
            <ArrowRight size={15} className="transition-transform group-hover:translate-x-0.5" />
          </a>
          <span className="text-[11px] font-mono uppercase tracking-[0.18em] text-[#0e1745]/45 dark:text-white/45">
            por invitación · sin cobro durante el piloto · respuesta en 48h
          </span>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Problem — what they do today the hard way. Editorial framing.
// ─────────────────────────────────────────────────────────────────────

function Problem() {
  return (
    <section
      id="problema"
      className="px-4 sm:px-6 md:px-8 py-16 md:py-24 bg-[#0e1745]/[0.02] dark:bg-white/[0.012] scroll-mt-20"
    >
      <div className="mx-auto max-w-[1280px]">
        <SectionLead
          eyebrow="01 · El problema"
          headline={
            <>
              El archivo está abierto.{' '}
              <em className="not-italic italic font-normal text-cl2-burgundy dark:text-cl2-accent-soft">
                Y aún así ilegible.
              </em>
            </>
          }
          body="La información existe, pero se pierde en el ruido del SIL, en cuatro horas de YouTube por sesión y en un Reglamento que nadie quiere abrir un viernes a las once de la noche."
        />
        <div className="mt-10 md:mt-14 grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-5">
          <ProblemCard
            label="SIL público pero ilegible"
            body="Veintiún mil expedientes, búsqueda por número y nada más. Sin texto completo, sin cruces, sin alertas. La pestaña de Chrome se queda abierta horas."
            metric="21,620"
            metricSub="expedientes catalogados"
          />
          <ProblemCard
            label="Plenarias en YouTube sin transcripción"
            body="Si querés citar lo que dijo X en el debate de marzo, te tocaba ver las cuatro horas — o citarlo de memoria y rezar."
            metric="120+"
            metricSub="sesiones transcritas con timecode"
          />
          <ProblemCard
            label="Reglamento en PDF de 96 artículos"
            body="Nadie lo revisa porque hay que leerlo de seguido. Y la pregunta procedimental siempre llega cuando ya estás corriendo."
            metric="96"
            metricSub="artículos indexados artículo por artículo"
          />
          <ProblemCard
            label="Memoria institucional dispersa"
            body="Equipos de fracción reinventan el mismo briefing cada semana. La doctrina del despacho vive en Word docs sueltos en cuatro laptops distintas."
            metric="∞"
            metricSub="reuniones para llegar a la misma conclusión"
          />
        </div>
      </div>
    </section>
  );
}

function ProblemCard({
  label,
  body,
  metric,
  metricSub,
}: {
  label: string;
  body: string;
  metric: string;
  metricSub: string;
}) {
  return (
    <article className="rounded-2xl border border-[#0e1745]/[0.07] dark:border-white/[0.06] bg-white/85 dark:bg-white/[0.025] p-6 flex flex-col">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-cl2-accent dark:text-cl2-accent-soft mb-3">
        {label}
      </div>
      <p className="text-[14.5px] leading-relaxed text-[#0e1745]/80 dark:text-white/80 flex-1">
        {body}
      </p>
      <div className="mt-5 pt-4 border-t border-dashed border-[#0e1745]/15 dark:border-white/15 flex items-baseline gap-3">
        <div className="font-display font-light text-[36px] tabular-nums text-[#0e1745] dark:text-white leading-none">
          {metric}
        </div>
        <div className="text-[11.5px] text-[#0e1745]/55 dark:text-white/55">{metricSub}</div>
      </div>
    </article>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Capabilities — Capa 1, "datos vivos". Numbers + sources, not buzzwords.
// ─────────────────────────────────────────────────────────────────────

function Capabilities() {
  return (
    <section className="px-4 sm:px-6 md:px-8 py-16 md:py-24">
      <div className="mx-auto max-w-[1280px]">
        <SectionLead
          eyebrow="02 · Datos vivos"
          headline={
            <>
              Cuatro fuentes conectadas.{' '}
              <em className="not-italic italic font-normal text-cl2-burgundy dark:text-cl2-accent-soft">
                Una sola conversación.
              </em>
            </>
          }
          body="No es un wrapper sobre un buscador. Es la base sobre la que los tres asesores trabajan — todo lo que respondan tiene que poder citarse acá."
        />
        <div className="mt-10 md:mt-14 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
          <CapabilityTile
            icon={<Library size={16} />}
            title="SIL conectado"
            metric="1998 → hoy"
            body="Catálogo completo desde que el SIL tiene texto digital recuperable. Filtros por comisión, estado, año, proponente."
          />
          <CapabilityTile
            icon={<Radio size={16} />}
            title="Plenarias en vivo"
            metric="2022 – 2026"
            body="Sesiones de la legislatura activa con transcripción navegable y timecode. Cada cita lleva al segundo exacto del video."
          />
          <CapabilityTile
            icon={<FileText size={16} />}
            title="Reglamento indexado"
            metric="96 art."
            body="Artículo por artículo. Pregunta procedimental se responde con el número exacto del Reglamento — no con paráfrasis."
          />
          <CapabilityTile
            icon={<ShieldCheck size={16} />}
            title="Cita verificable"
            metric="100%"
            body="Regla guardrail, no aspiración. Si el archivo no respalda el dato, el agente te dice que no encontró. Punto."
            emphasis
          />
        </div>
      </div>
    </section>
  );
}

function CapabilityTile({
  icon,
  title,
  metric,
  body,
  emphasis,
}: {
  icon: React.ReactNode;
  title: string;
  metric: string;
  body: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-2xl border p-5',
        emphasis
          ? 'border-cl2-accent/30 bg-cl2-accent/[0.05] dark:bg-cl2-accent/[0.10]'
          : 'border-[#0e1745]/[0.07] dark:border-white/[0.06] bg-white/85 dark:bg-white/[0.025]',
      )}
    >
      <div
        className={cn(
          'inline-flex items-center justify-center w-8 h-8 rounded-full mb-3',
          emphasis
            ? 'bg-cl2-accent/15 text-cl2-accent dark:text-cl2-accent-soft'
            : 'bg-[#0e1745]/[0.05] dark:bg-white/[0.06] text-[#0e1745]/70 dark:text-white/70',
        )}
      >
        {icon}
      </div>
      <div className="font-display font-light text-[26px] tabular-nums leading-none mb-1 text-[#0e1745] dark:text-white">
        {metric}
      </div>
      <h3 className="text-[13px] font-semibold text-[#0e1745] dark:text-white">{title}</h3>
      <p className="mt-1.5 text-[12.5px] leading-snug text-[#0e1745]/65 dark:text-white/65">
        {body}
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Tres almas — Lexa, Atlas, Centinela. Brand color per agent, rule
// quotes verbatim from the agent YAMLs.
// ─────────────────────────────────────────────────────────────────────

function ThreeSouls() {
  return (
    <section
      id="tres-almas"
      className="px-4 sm:px-6 md:px-8 py-16 md:py-24 bg-[#0e1745]/[0.02] dark:bg-white/[0.012] scroll-mt-20"
    >
      <div className="mx-auto max-w-[1280px]">
        <SectionLead
          eyebrow="03 · Quién responde"
          headline={
            <>
              Mismo archivo en el centro.{' '}
              <em className="not-italic italic font-normal text-cl2-burgundy dark:text-cl2-accent-soft">
                Tres lecturas alrededor.
              </em>
            </>
          }
          body="No tres prompts iguales con nombres distintos. Tres asesores con personalidad, modelo, herramientas y umbrales propios — uno para análisis plenario, uno para comisiones y datos, uno para alertas y deep insight."
        />
        <div className="mt-10 md:mt-14 grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-5">
          <SoulCard
            agent="Lexa"
            icon={<Scale size={18} />}
            color="burgundy"
            role="Plenario"
            tagline="Cita actas con timecode."
            rule="«Si el archivo no respalda, me detengo. Decir 'no encontré' es respuesta válida.»"
            tools={['Plenarias indexadas', 'Reglamento', 'Actas + video']}
          />
          <SoulCard
            agent="Atlas"
            icon={<Library size={18} />}
            color="ochre"
            role="Comisiones"
            tagline="Cruza dictámenes con votación nominal."
            rule="«Solo hablo de leyes que estén en SIL. Si no está, no existe para mí.»"
            tools={['SIL completo', 'Dictámenes', 'Votaciones']}
          />
          <SoulCard
            agent="Centinela"
            icon={<Radio size={18} />}
            color="rose"
            role="Watchlist"
            tagline="Bandera de confianza explícita."
            rule="«Penalizo prensa, prefiero el acta. Si voy con baja confianza, lo digo.»"
            tools={['Monitoreo cruzado', 'Patrones de votación', 'Riesgo reputacional']}
          />
        </div>
      </div>
    </section>
  );
}

type SoulColor = 'burgundy' | 'ochre' | 'rose';
const SOUL_COLORS: Record<
  SoulColor,
  { ring: string; text: string; bg: string; ribbon: string }
> = {
  burgundy: {
    ring: 'border-cl2-burgundy/30 dark:border-[#d8a4ad]/20',
    text: 'text-cl2-burgundy dark:text-[#d8a4ad]',
    bg: 'bg-cl2-burgundy/[0.04] dark:bg-[#d8a4ad]/[0.05]',
    ribbon: 'bg-cl2-burgundy dark:bg-[#d8a4ad]',
  },
  ochre: {
    ring: 'border-[#8B6E54]/30',
    text: 'text-[#6E5742] dark:text-[#c9a98a]',
    bg: 'bg-[#8B6E54]/[0.05] dark:bg-[#c9a98a]/[0.05]',
    ribbon: 'bg-[#8B6E54]',
  },
  rose: {
    ring: 'border-[#F43F5E]/30',
    text: 'text-[#be1738] dark:text-[#fda4b4]',
    bg: 'bg-[#F43F5E]/[0.05] dark:bg-[#F43F5E]/[0.10]',
    ribbon: 'bg-[#F43F5E]',
  },
};

function SoulCard({
  agent,
  icon,
  color,
  role,
  tagline,
  rule,
  tools,
}: {
  agent: string;
  icon: React.ReactNode;
  color: SoulColor;
  role: string;
  tagline: string;
  rule: string;
  tools: string[];
}) {
  const c = SOUL_COLORS[color];
  return (
    <article
      className={cn(
        'relative rounded-2xl border bg-white/80 dark:bg-white/[0.025] backdrop-blur-sm',
        'p-5 md:p-6 flex flex-col gap-3 transition-all',
        'hover:shadow-[0_4px_30px_rgba(14,23,69,0.06)] dark:hover:shadow-[0_4px_30px_rgba(0,0,0,0.25)]',
        c.ring,
      )}
    >
      <div className={cn('absolute left-0 top-6 bottom-6 w-[3px] rounded-r', c.ribbon)} />
      <div className="flex items-center gap-2 pl-2">
        <span className={cn('inline-flex items-center justify-center w-7 h-7 rounded-full', c.bg, c.text)}>
          {icon}
        </span>
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-[#0e1745]/55 dark:text-white/55">
          {role}
        </span>
      </div>
      <h3
        className={cn(
          'font-display font-normal text-[28px] md:text-[32px] leading-none tracking-tight pl-2 italic',
          c.text,
        )}
      >
        {agent}
      </h3>
      <p className="text-[14px] font-medium text-[#0e1745] dark:text-white pl-2">{tagline}</p>
      <blockquote
        className={cn(
          'pl-3 ml-2 border-l-2 italic text-[12.5px] leading-snug text-[#0e1745]/72 dark:text-white/72',
          c.ring.replace('border-', 'border-l-'),
        )}
      >
        {rule}
      </blockquote>
      <div className="flex flex-wrap gap-1.5 pl-2 mt-1">
        {tools.map((t) => (
          <span
            key={t}
            className={cn(
              'inline-flex items-center px-2 py-0.5 rounded-full text-[10.5px] font-medium border',
              c.bg,
              c.ring,
              c.text,
            )}
          >
            {t}
          </span>
        ))}
      </div>
    </article>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Comparison — antes / con CL2. Four concrete cases.
// ─────────────────────────────────────────────────────────────────────

function Comparison() {
  return (
    <section id="comparativa" className="px-4 sm:px-6 md:px-8 py-16 md:py-24 scroll-mt-20">
      <div className="mx-auto max-w-[1280px]">
        <SectionLead
          eyebrow="04 · Casos concretos"
          headline={
            <>
              Lo que toca hacer hoy{' '}
              <em className="not-italic italic font-normal text-cl2-burgundy dark:text-cl2-accent-soft">
                vs. lo que tomaría con CL2.
              </em>
            </>
          }
          body="Los cuatro flujos donde los despachos pierden más horas — y cómo se ven cuando los tres asesores los resuelven con cita inline."
        />
        <div className="mt-10 md:mt-14 space-y-4 md:space-y-5">
          <Case
            title="Briefing nocturno antes de votar"
            before="Tres horas leyendo dictámenes en PDF para cuatro expedientes. Mañana 9 a.m. votación."
            after="«Atlas: dame minoría + mayoría del Exp. 24.018 con argumentos clave.»"
            timing="30 segundos"
            tag="Atlas"
            color="ochre"
          />
          <Case
            title="Pregunta procedimental"
            before="«¿Cuál es el plazo de dictamen?» — bajar PDF del Reglamento, hacer Ctrl+F, leer con cuidado."
            after="«Lexa: plazo dictamen comisión.» Devuelve [Art. 113] con el texto completo."
            timing="instantáneo"
            tag="Lexa"
            color="burgundy"
          />
          <Case
            title="Citar plenario en vivo"
            before="«Creo que Calderón dijo algo del art 14» — abrir cuatro horas de YouTube y rezar."
            after="«Lexa: qué dijo Calderón sobre el art 14.» [2] (1:57:26) con link al segundo exacto."
            timing="20 segundos"
            tag="Lexa"
            color="burgundy"
          />
          <Case
            title="Cálculo estratégico"
            before="Reuniones de fracción para estimar votos a ojo de pájaro."
            after="«Centinela: ¿cuánto apoyo tendría una moción de censura?» Rango cualitativo + bandera de confianza."
            timing="2 minutos"
            tag="Centinela"
            color="rose"
          />
        </div>
      </div>
    </section>
  );
}

function Case({
  title,
  before,
  after,
  timing,
  tag,
  color,
}: {
  title: string;
  before: string;
  after: string;
  timing: string;
  tag: string;
  color: SoulColor;
}) {
  const c = SOUL_COLORS[color];
  return (
    <article className="rounded-2xl border border-[#0e1745]/[0.07] dark:border-white/[0.06] bg-white/85 dark:bg-white/[0.025] overflow-hidden">
      <div className="flex items-center gap-3 px-5 md:px-6 py-3 border-b border-[#0e1745]/[0.05] dark:border-white/[0.05]">
        <h3 className="font-display font-normal text-[18px] md:text-[19px] tracking-tight text-[#0e1745] dark:text-white flex-1">
          {title}
        </h3>
        <span
          className={cn(
            'inline-flex items-center px-2 py-0.5 rounded-full text-[10.5px] font-semibold border',
            c.bg, c.ring, c.text,
          )}
        >
          {tag}
        </span>
        <span className="text-[11px] tabular-nums text-[#0e1745]/55 dark:text-white/55">
          {timing}
        </span>
      </div>
      <div className="grid md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-[#0e1745]/[0.05] dark:divide-white/[0.05]">
        <div className="px-5 md:px-6 py-4 md:py-5">
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#0e1745]/45 dark:text-white/45 mb-1.5">
            Antes
          </div>
          <p className="text-[13.5px] leading-snug text-[#0e1745]/72 dark:text-white/72">
            {before}
          </p>
        </div>
        <div className={cn('px-5 md:px-6 py-4 md:py-5', c.bg)}>
          <div className={cn('text-[10px] font-semibold uppercase tracking-[0.18em] mb-1.5', c.text)}>
            Con CL2
          </div>
          <p className="text-[13.5px] leading-snug text-[#0e1745] dark:text-white font-medium">
            {after}
          </p>
        </div>
      </div>
    </article>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Memoria curada — the editorial framing of curaduría. Never mention
// "extracts insights" / "learns from your conversations".
// ─────────────────────────────────────────────────────────────────────

function DespachoMemory() {
  return (
    <section
      id="memoria"
      className="px-4 sm:px-6 md:px-8 py-16 md:py-24 bg-[#0e1745]/[0.02] dark:bg-white/[0.012] scroll-mt-20"
    >
      <div className="mx-auto max-w-[920px] text-center">
        <SectionLead
          eyebrow="05 · Memoria curada"
          centered
          headline={
            <>
              El equipo aprende a hablar{' '}
              <em className="not-italic italic font-normal text-cl2-burgundy dark:text-cl2-accent-soft">
                como tu despacho.
              </em>
            </>
          }
          body="La jefatura escribe los lineamientos editoriales — qué tono usar, qué fuentes priorizar, cómo cerrar un briefing. Esos lineamientos quedan en el contexto base de los tres asesores. Para siempre."
        />
        <div className="mt-10 grid grid-cols-1 sm:grid-cols-3 gap-3 md:gap-4 text-left">
          <MemoryStep
            num="01"
            title="Definí los lineamientos"
            body="«Briefings cierran con la pregunta política, no con la legal.» «Citá al menos un voto en contra cuando exista.» Reglas del despacho, en lenguaje natural."
          />
          <MemoryStep
            num="02"
            title="Inyectados al system prompt"
            body="Cada lineamiento publicado entra al contexto base de los tres asesores. Lexa, Atlas y Centinela los respetan en cada respuesta."
          />
          <MemoryStep
            num="03"
            title="Lock-in editorial"
            body="A los seis meses, la versión de CL2 del despacho A no es intercambiable con la del despacho B. Esa diferencia editorial es la firma."
          />
        </div>
      </div>
    </section>
  );
}

function MemoryStep({ num, title, body }: { num: string; title: string; body: string }) {
  return (
    <article className="rounded-2xl border border-[#0e1745]/[0.07] dark:border-white/[0.06] bg-white/85 dark:bg-white/[0.025] p-5 md:p-6">
      <div className="font-display font-light text-[26px] tabular-nums text-cl2-accent dark:text-cl2-accent-soft leading-none">
        {num}
      </div>
      <h3 className="mt-3 font-semibold text-[15px] text-[#0e1745] dark:text-white">{title}</h3>
      <p className="mt-1.5 text-[13px] leading-snug text-[#0e1745]/70 dark:text-white/70">
        {body}
      </p>
    </article>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Manifesto — closing editorial block. Sharp, short. No bullets.
// ─────────────────────────────────────────────────────────────────────

function Manifesto() {
  return (
    <section className="px-4 sm:px-6 md:px-8 py-20 md:py-28">
      <div className="mx-auto max-w-[860px]">
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-cl2-accent dark:text-cl2-accent-soft mb-4">
          Manifiesto
        </div>
        <div className="space-y-6 font-display font-light text-[24px] sm:text-[28px] md:text-[34px] leading-[1.18] tracking-tight text-[#0e1745] dark:text-white">
          <p>
            La inteligencia legislativa{' '}
            <em className="not-italic italic font-normal text-cl2-burgundy dark:text-cl2-accent-soft">
              no es un buscador más rápido.
            </em>
          </p>
          <p>
            Es un equipo que lee con vos.{' '}
            <em className="not-italic italic font-normal text-cl2-burgundy dark:text-cl2-accent-soft">
              Que cita.
            </em>{' '}
            Que cuando no sabe, te lo dice — y eso vale tanto como la respuesta.
          </p>
          <p>
            Lo construimos porque los despachos costarricenses se merecen{' '}
            <em className="not-italic italic font-normal text-cl2-burgundy dark:text-cl2-accent-soft">
              herramientas a su altura.
            </em>{' '}
            No copias maquilladas de productos hechos para otra cosa.
          </p>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Final CTA
// ─────────────────────────────────────────────────────────────────────

function FinalCta() {
  return (
    <section
      id="cta"
      className="px-4 sm:px-6 md:px-8 py-20 md:py-28 bg-[#0e1745]/[0.02] dark:bg-white/[0.012] scroll-mt-20"
    >
      <div className="mx-auto max-w-[920px] text-center">
        <h2 className="font-display font-light text-[34px] sm:text-[48px] leading-[1.05] tracking-tight text-[#0e1745] dark:text-white max-w-[18ch] mx-auto">
          Tu próxima votación{' '}
          <em className="not-italic italic font-normal text-cl2-burgundy dark:text-cl2-accent-soft">
            está la semana que viene.
          </em>
        </h2>
        <p className="mt-5 text-[15.5px] leading-relaxed text-[#0e1745]/72 dark:text-white/72 max-w-[54ch] mx-auto">
          Llegás con un caso real. Treinta minutos. Si no te parece, perdiste media hora; si
          te parece, ganaste un equipo de tres.
        </p>
        <div className="mt-9 flex flex-wrap justify-center items-center gap-3">
          <a
            href={DEMO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="group inline-flex items-center gap-2 px-6 py-3.5 rounded-md bg-cl2-accent hover:bg-cl2-accent-hover text-white text-[14.5px] font-semibold shadow-sm transition-colors"
          >
            Agendá tu demo
            <ArrowRight size={15} className="transition-transform group-hover:translate-x-0.5" />
          </a>
          <button
            type="button"
            onClick={() => navigate('/')}
            className="inline-flex items-center gap-2 px-5 py-3 rounded-md border border-[#0e1745]/[0.10] dark:border-white/[0.10] bg-white/60 dark:bg-white/[0.04] hover:bg-white dark:hover:bg-white/[0.08] text-[13.5px] font-medium text-[#0e1745] dark:text-white transition-colors"
          >
            Ya soy usuario · Ingresar
          </button>
        </div>
        <div className="mt-6 inline-flex flex-wrap items-center justify-center gap-3 font-mono text-[10.5px] uppercase tracking-[0.18em] text-[#0e1745]/45 dark:text-white/45">
          <span className="inline-flex items-center gap-1.5">
            <CheckCircle2 size={11} /> sin cobro durante el piloto
          </span>
          <span className="inline-block w-[3px] h-[3px] rounded-full bg-[#0e1745]/25 dark:bg-white/25" />
          <span>respuesta en 48h</span>
          <span className="inline-block w-[3px] h-[3px] rounded-full bg-[#0e1745]/25 dark:bg-white/25" />
          <span>acceso por invitación</span>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Footer
// ─────────────────────────────────────────────────────────────────────

function LandingFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t border-[#0e1745]/[0.06] dark:border-white/[0.06] px-4 sm:px-6 md:px-8 py-10 mt-4 relative z-10">
      <div className="mx-auto max-w-[1280px] flex flex-wrap items-center gap-y-3 gap-x-6 text-[12px] text-[#0e1745]/55 dark:text-white/55">
        <div className="flex items-center gap-2">
          <ShieldCheck size={13} />
          <span className="font-semibold text-[#0e1745]/75 dark:text-white/75">CL2 · Shift</span>
        </div>
        <span className="hidden sm:inline">San José, Costa Rica</span>
        <span className="ml-auto">© {year} Shift. Todos los derechos reservados.</span>
      </div>
    </footer>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function SectionLead({
  eyebrow,
  headline,
  body,
  centered,
  compact,
}: {
  eyebrow: string;
  headline: React.ReactNode;
  body: string;
  centered?: boolean;
  compact?: boolean;
}) {
  const reduced = useReducedMotion();
  const [visible, setVisible] = useState(false);
  // Cheap one-shot reveal — the page is short enough that everything
  // ends up in viewport quickly; no need for IntersectionObserver.
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 50);
    return () => clearTimeout(t);
  }, []);
  return (
    <motion.div
      initial={reduced ? false : { opacity: 0, y: 16 }}
      animate={visible ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
      className={cn('max-w-[60ch]', centered && 'mx-auto text-center')}
    >
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-cl2-accent dark:text-cl2-accent-soft mb-3">
        {eyebrow}
      </div>
      <h2
        className={cn(
          'font-display font-light tracking-tight text-[#0e1745] dark:text-white',
          compact
            ? 'text-[26px] md:text-[32px] leading-[1.08]'
            : 'text-[32px] md:text-[44px] leading-[1.04]',
        )}
      >
        {headline}
      </h2>
      <p
        className={cn(
          'mt-4 text-[#0e1745]/72 dark:text-white/72 leading-relaxed',
          compact ? 'text-[14.5px]' : 'text-[15.5px]',
        )}
      >
        {body}
      </p>
    </motion.div>
  );
}
