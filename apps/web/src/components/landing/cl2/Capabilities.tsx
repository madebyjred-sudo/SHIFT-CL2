import { useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/landing/ui/card";
import { cn } from "@/lib/utils";
import { Section, Reveal } from "./Primitives";
import { Icon } from "./Icon";

/* ─── Types ─────────────────────────────── */
type Cap = {
  n: string;
  agent: "Lexa" | "Atlas" | "Centinela" | "Operador";
  icon: Parameters<typeof Icon>[0]["name"];
  title: string;
  description: string;
  prompt: string;
  reply: { lead: string; cite?: string; tail?: string };
  tags: string[];
};

type Axis = {
  key: string;
  label: string;
  blurb: string;
  tone: string;
  caps: Cap[];
};

/* ─── Content ─────────────────────────────── */
const axes: Axis[] = [
  {
    key: "dia-a-dia",
    label: "El día a día",
    blurb: "Trabajá un proyecto entero en un solo lugar. Citá al folio.",
    tone: "hsl(var(--cl2-burgundy))",
    caps: [
      {
        n: "01",
        agent: "Atlas",
        icon: "archive",
        title: "Un proyecto, un solo espacio.",
        description:
          "Toda la información del expediente vive en una sola página de trabajo. Texto base, dictámenes, votaciones cruzadas, posiciones de bancada. Lo armás en una mañana. Lo retomás cuatro meses después como si nunca te hubieras ido.",
        prompt: "Armame el espacio del Exp. 24.018.",
        reply: {
          lead: "Espacio creado. Texto base, tres dictámenes (mayoría, minoría FA, técnico), votación de 19-sep y posiciones de bancada — listos para revisar.",
          cite: "exp. 24.018",
          tail: "Reanudable. Editable. Compartible con tu equipo.",
        },
        tags: ["Un solo espacio", "Memoria del proyecto", "Reanudable"],
      },
      {
        n: "02",
        agent: "Lexa",
        icon: "quote",
        title: "Cita verificable, sin invento.",
        description:
          "Pregunta corta, dato exacto. cl2 cita el folio o el minuto del plenario. Si no está en el archivo, dice 'no encontré' y se detiene.",
        prompt: "Cobertura del Exp. 24.018 desde su entrada al archivo.",
        reply: {
          lead: "Ingresó el 12-mar-2024 a Hacendarios. Tres dictámenes hasta hoy: mayoría (07-ago), minoría FA (07-ago), revisión técnica (19-sep).",
          cite: "exp. 24.018 fl. 1.247",
          tail: "Las tres versiones disponibles para comparar.",
        },
        tags: ["Cita al folio", "Sin invento", "Cobertura entera"],
      },
    ],
  },
  {
    key: "durante-sesion",
    label: "Durante la sesión",
    blurb: "Mientras la sesión sigue, vos te adelantás.",
    tone: "hsl(var(--cl2-ochre))",
    caps: [
      {
        n: "03",
        agent: "Lexa",
        icon: "play",
        title: "Mientras la sesión sigue, vos te adelantás.",
        description:
          "Sin salir del plenario, una consulta corta te trae el dato exacto para tu próximo turno. Qué dijo el otro diputado en marzo. Qué dice el reglamento sobre lo que están proponiendo. Llegás más fuerte improvisando que el otro habiéndose preparado tres días.",
        prompt: "¿Qué dijo Calderón sobre el art. 14 en la última plenaria?",
        reply: {
          lead: "Sesión 142, 22-abr-2026. Cuestionó el inciso b) por incompatibilidad con el art. 7 constitucional.",
          cite: "acta 142 §31",
          tail: "Link al minuto 1:57:26. Tres minutos de contexto antes y después.",
        },
        tags: ["En plenario", "Consulta corta", "Link al minuto"],
      },
      {
        n: "04",
        agent: "Lexa",
        icon: "compass",
        title: "Lo que dijo el otro, en segundos.",
        description:
          "Cualquier diputado, cualquier intervención. cl2 lo encuentra y te trae el contexto antes de que el otro termine de hablar.",
        prompt: "¿Cuántas veces ha votado Hernández contra reformas tributarias?",
        reply: {
          lead: "Cuatro veces este período. Tres por motivos fiscales (24.018, 24.087, 23.901). Una por procedimiento (24.155).",
          cite: "actas 134, 137, 141, 144",
          tail: "Resumen de argumentos por cada votación, a un click.",
        },
        tags: ["Histórico", "Comparativo", "Por diputado"],
      },
    ],
  },
  {
    key: "antes-votacion",
    label: "Antes de la votación",
    blurb: "El brief y la presentación de mañana, listos esta noche.",
    tone: "hsl(var(--cl2-rose))",
    caps: [
      {
        n: "05",
        agent: "Atlas",
        icon: "scale",
        title: "El brief para mañana, listo esta noche.",
        description:
          "Pedile el análisis: posición de cada bancada, riesgo reputacional, dos argumentos a favor y dos en contra. cl2 lo escribe en una página de trabajo. Vos lo revisás, lo retocás, lo presentás. Llegás a la reunión a hablar, no a leer.",
        prompt: "Brief del 24.018: posición de cada bancada, dos argumentos por lado.",
        reply: {
          lead: "Mayoría (PUSC, PLN): viabilidad fiscal, alineación con la regla del 6%. Minoría (FA, RN): regresividad del inciso c), sin evaluación de impacto.",
          cite: "exp. 24.018 fl. 1.106",
          tail: "Tres argumentos por bando + riesgo reputacional, listos para imprimir.",
        },
        tags: ["Brief nocturno", "Argumentos por bando", "Listo para reunión"],
      },
      {
        n: "06",
        agent: "Atlas",
        icon: "sparkles",
        title: "La presentación lista, con tu tono.",
        description:
          "Decile la audiencia, el tono y los lineamientos del despacho. cl2 te entrega la presentación editable, con la voz de tu fracción mantenida en cada slide.",
        prompt: "Pasá esto a presentación. Audiencia: comisión Hacendarios. Tono: persuasivo.",
        reply: {
          lead: "Doce slides listas. Cubrimos las dos posturas, el riesgo fiscal, dos casos comparados. Mantengo la voz de tu fracción y los lineamientos publicados.",
          cite: "brief Exp. 24.018",
          tail: "Editable. Lista para descargar o compartir.",
        },
        tags: ["Presentación editable", "Con tu tono", "En cuatro minutos"],
      },
    ],
  },
  {
    key: "memoria-despacho",
    label: "Memoria del despacho",
    blurb: "Lo que tu despacho aprendió, escrito. Lo que importa, vigilado.",
    tone: "hsl(var(--cl2-burgundy-deep))",
    caps: [
      {
        n: "07",
        agent: "Centinela",
        icon: "radar",
        title: "Lo que importa pasa cuando no estás mirando.",
        description:
          "Decile qué seguir — un expediente, un diputado, un tema. cl2 vigila el archivo y la agenda 24 horas. Cuando algo cambia de verdad, te avisa con el contexto pegado. Te enterás del cambio antes que la prensa.",
        prompt: "Avisame si cambia el dictamen del 24.087.",
        reply: {
          lead: "Vigilancia activa. Última alerta: 18-abr-2026, 09:14. Sustitución del dictamen mayoritario; cambió el art. 9 y se eliminó el transitorio II.",
          cite: "exp. 24.087 fl. 0.418",
          tail: "Solo lo sustantivo. Sin ruido. Sin alertas que se borran sin leer.",
        },
        tags: ["Vigilancia 24/7", "Solo lo sustantivo", "Antes que la prensa"],
      },
      {
        n: "08",
        agent: "Operador",
        icon: "book",
        title: "El conocimiento se queda, aunque tu equipo cambie.",
        description:
          "Lo que tu despacho aprendió queda escrito en cl2. Posiciones tomadas, argumentos usados, precedentes citados. Cuando entra alguien nuevo, no empieza de cero. Cuando se va alguien, no se lleva la institución encima.",
        prompt: "Publicar lineamiento — todo brief abre con postura, dos pros, dos contras.",
        reply: {
          lead: "Lineamiento #14 publicado. cl2 lo aplica en cada brief desde ya. Aplica a Lexa y Atlas. Versión anterior archivada.",
          cite: "lineamiento 14 · activo",
          tail: "Editable cuando quieras. Auditable siempre.",
        },
        tags: ["Voz del despacho", "Permanente", "Memoria recuperada"],
      },
    ],
  },
];

/* ─── helpers ─────────────────────────────── */
const soft = (tone: string, alpha: number) => tone.replace(")", ` / ${alpha})`);

/* ─── Decorator (corner crosses) ───────────── */
const CardDecorator = ({ tone }: { tone: string }) => {
  const cross = (pos: string) => (
    <span
      aria-hidden
      className={cn("absolute h-3 w-3 opacity-50 pointer-events-none", pos)}
      style={{
        background:
          `linear-gradient(${tone}, ${tone}) center/100% 1px no-repeat,` +
          `linear-gradient(${tone}, ${tone}) center/1px 100% no-repeat`,
      }}
    />
  );
  return (
    <>
      {cross("-top-1.5 -left-1.5")}
      {cross("-top-1.5 -right-1.5")}
      {cross("-bottom-1.5 -left-1.5")}
      {cross("-bottom-1.5 -right-1.5")}
    </>
  );
};

/* ─── Reply overlay (chat simulation, shows on hover) ───── */
const ReplyOverlay = ({ cap, tone, show }: { cap: Cap; tone: string; show: boolean }) => (
  <div
    className={cn(
      "absolute inset-0 flex flex-col transition-all duration-300 pointer-events-none",
      show ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1"
    )}
    style={{
      background: "white",
      borderTop: `2px solid ${tone}`,
    }}
  >
    {/* Chat header */}
    <div
      className="flex items-center justify-between px-5 py-2.5 border-b border-cl2-ink/[0.06]"
      style={{ background: soft(tone, 0.04) }}
    >
      <div className="flex items-center gap-2">
        <span
          className="w-5 h-5 rounded-full inline-flex items-center justify-center text-[9px] font-mono font-bold text-white"
          style={{ background: tone }}
        >
          {cap.agent[0]}
        </span>
        <span className="font-mono text-[10.5px] uppercase tracking-wider" style={{ color: tone, fontWeight: 600 }}>
          {cap.agent}
        </span>
        <span
          className="w-1.5 h-1.5 rounded-full animate-pulse"
          style={{ background: "hsl(142 70% 45%)" }}
        />
        <span className="font-mono text-[10px] text-cl2-ink/45">en línea</span>
      </div>
      <span className="font-mono text-[10px]" style={{ color: tone }}>
        / {cap.n}
      </span>
    </div>

    {/* Chat thread */}
    <div className="flex-1 flex flex-col gap-3 px-5 py-4 overflow-hidden">
      {/* User bubble (right) */}
      <div className="flex justify-end animate-fade-in" style={{ animationDelay: "60ms", animationFillMode: "both" }}>
        <div className="flex flex-col items-end max-w-[82%]">
          <span className="font-mono text-[9.5px] text-cl2-ink/40 mb-1 mr-1 uppercase tracking-wider">
            tú · 11:47pm
          </span>
          <div
            className="rounded-2xl rounded-tr-sm px-3.5 py-2 text-[12.5px] leading-snug"
            style={{
              background: "hsl(var(--cl2-ink))",
              color: "hsl(var(--cl2-paper))",
            }}
          >
            {cap.prompt}
          </div>
        </div>
      </div>

      {/* Agent bubble (left) */}
      <div className="flex justify-start animate-fade-in" style={{ animationDelay: "220ms", animationFillMode: "both" }}>
        <div className="flex flex-col items-start max-w-[88%]">
          <span className="font-mono text-[9.5px] mb-1 ml-1 uppercase tracking-wider" style={{ color: tone }}>
            {cap.agent} · 11:47pm
          </span>
          <div
            className="rounded-2xl rounded-tl-sm px-3.5 py-2.5 text-[12.5px] leading-[1.5] space-y-2"
            style={{
              background: soft(tone, 0.08),
              color: "hsl(var(--cl2-ink))",
              borderLeft: `2px solid ${tone}`,
            }}
          >
            <p>{cap.reply.lead}</p>
            {cap.reply.cite && (
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <span
                  className="font-mono text-[10px] px-1.5 py-0.5 rounded"
                  style={{ background: "white", color: tone, border: `1px solid ${soft(tone, 0.3)}` }}
                >
                  [{cap.reply.cite}]
                </span>
                {cap.reply.tail && (
                  <span className="text-[11px] text-cl2-ink/65 italic">{cap.reply.tail}</span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>

    {/* Footer */}
    <div className="px-5 py-2 border-t border-dashed border-cl2-ink/10 flex items-center justify-between">
      <span className="font-mono text-[9.5px] text-cl2-ink/40 uppercase tracking-wider">
        conversación simulada
      </span>
      <span className="font-mono text-[9.5px] text-cl2-ink/40">
        100% con cita verificable
      </span>
    </div>
  </div>
);

/* ─── Card ────────────────────────────────── */
const FeatureCard = ({ cap, tone }: { cap: Cap; tone: string }) => {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      tabIndex={0}
      className="relative outline-none focus-visible:ring-2 focus-visible:ring-cl2-ink/20"
    >
      <CardDecorator tone={tone} />
      <Card
        className="relative h-full min-h-[260px] rounded-none border border-cl2-ink/[0.08] shadow-none transition-all duration-300 overflow-hidden"
        style={{
          background: hover ? "white" : "hsl(var(--cl2-paper))",
          boxShadow: hover ? "var(--shadow-ink-raised)" : "none",
        }}
      >
        {/* Resting state */}
        <CardContent
          className={cn(
            "relative p-7 lg:p-8 flex flex-col gap-4 h-full transition-opacity duration-200",
            hover ? "opacity-0" : "opacity-100"
          )}
        >
          <CardHeader className="p-0 space-y-3">
            <div className="flex items-center justify-between">
              <span
                className="inline-flex items-center justify-center w-9 h-9 rounded-md"
                style={{ background: soft(tone, 0.10), color: tone }}
              >
                <Icon name={cap.icon} size={18} />
              </span>
              <span className="font-mono text-[10.5px] tracking-widest" style={{ color: tone }}>
                / {cap.n} <span className="opacity-50">de 08</span>
              </span>
            </div>
            <h3
              className="serif text-[22px] leading-tight text-cl2-ink"
              style={{ fontWeight: 500, letterSpacing: "-0.015em" }}
            >
              {cap.title}
            </h3>
            <p className="text-[13.5px] leading-[1.6] text-cl2-ink/[0.72]">{cap.description}</p>
          </CardHeader>

          <div className="flex flex-wrap gap-1.5 mt-auto pt-4 border-t border-dashed border-cl2-ink/10">
            {cap.tags.map((t) => (
              <span
                key={t}
                className="text-[10.5px] px-2 py-0.5 rounded-full"
                style={{ background: "hsl(var(--cl2-ink) / 0.04)", color: "hsl(var(--cl2-ink) / 0.65)" }}
              >
                {t}
              </span>
            ))}
            <span
              className="ml-auto font-mono text-[10px] uppercase tracking-wider opacity-60 transition-opacity"
              style={{ color: tone }}
            >
              hover · ver respuesta →
            </span>
          </div>
        </CardContent>

        {/* Hover overlay with simulated reply */}
        <ReplyOverlay cap={cap} tone={tone} show={hover} />
      </Card>
    </div>
  );
};

/* ─── Axis accordion item ─────────────────── */
const AxisAccordion = ({
  axis,
  idx,
  open,
  onToggle,
}: {
  axis: Axis;
  idx: number;
  open: boolean;
  onToggle: () => void;
}) => (
  <div className="border-t border-cl2-ink/[0.10]">
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="w-full flex items-center gap-4 py-6 lg:py-7 group text-left"
    >
      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: axis.tone }} />
      <span
        className="font-mono text-[10.5px] uppercase tracking-widest font-semibold flex-shrink-0"
        style={{ color: axis.tone }}
      >
        Eje {String.fromCharCode(65 + idx)}
      </span>
      <h3
        className="serif text-cl2-ink text-[22px] lg:text-[26px] leading-none flex-shrink-0"
        style={{ fontWeight: 500, letterSpacing: "-0.015em" }}
      >
        {axis.label}
      </h3>
      <span className="hidden md:inline text-[13px] text-cl2-ink/55 truncate">{axis.blurb}</span>
      <span className="flex-1" />
      <span className="font-mono text-[10.5px] text-cl2-ink/40 uppercase tracking-wider">
        {axis.caps.length} capacidades
      </span>
      <span
        className="inline-flex items-center justify-center w-8 h-8 rounded-full border transition-transform duration-300"
        style={{
          borderColor: soft(axis.tone, 0.35),
          color: axis.tone,
          transform: open ? "rotate(45deg)" : "rotate(0deg)",
        }}
        aria-hidden
      >
        <Icon name="plus" size={14} />
      </span>
    </button>

    <div
      className="grid transition-all duration-500 ease-out"
      style={{
        gridTemplateRows: open ? "1fr" : "0fr",
        opacity: open ? 1 : 0,
      }}
    >
      <div className="overflow-hidden">
        <div className="pb-10 lg:pb-12">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 lg:gap-6">
            {axis.caps.map((cap) => (
              <FeatureCard key={cap.n} cap={cap} tone={axis.tone} />
            ))}
          </div>
        </div>
      </div>
    </div>
  </div>
);

/* ─── Section ─────────────────────────────── */
export const Capabilities = () => {
  const [openKey, setOpenKey] = useState<string | null>(axes[0].key);

  return (
    <Section id="producto" eyebrow="Lo que cambia en tu día" kicker="04 / qué hace">
      <Reveal>
        <div className="mb-12 max-w-[820px]">
          <h2 className="display display--lg">
            La diferencia entre llegar a leer
            <br />
            <em>y llegar a hablar.</em>
          </h2>
          <p className="lede mt-5">
            Ocho situaciones reales del trabajo legislativo, cuatro ejes. Pasá el cursor sobre cada una para ver cómo responde cl2 — son consultas reales contra archivo real.
          </p>
        </div>
      </Reveal>

      <Reveal>
        <div className="border-b border-cl2-ink/[0.10]">
          {axes.map((axis, idx) => (
            <AxisAccordion
              key={axis.key}
              axis={axis}
              idx={idx}
              open={openKey === axis.key}
              onToggle={() => setOpenKey(openKey === axis.key ? null : axis.key)}
            />
          ))}
        </div>
      </Reveal>
    </Section>
  );
};
