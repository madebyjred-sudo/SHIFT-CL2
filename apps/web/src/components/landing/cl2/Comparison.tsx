import { useState } from "react";
import { Icon } from "./Icon";
import { Section, Reveal } from "./Primitives";

type Cell = string | "check" | "cross" | "partial" | "manual";

const rows: [string, Cell, Cell, Cell, Cell][] = [
  ["Pensado para", "Despachos legislativos, prensa, análisis", "Empresas con monitoreo regulatorio", "Uso general", "Quien tenga tiempo"],
  ["Cobertura del archivo", "SIL + comisiones + plenarias desde 1998", "Proyectos en curso, decretos", "Lo que esté en internet abierto", "PDFs descargados a mano"],
  ["Citas verificables", "check", "partial", "cross", "manual"],
  ["Cita al folio / minuto", "check", "cross", "cross", "manual"],
  ["Voto nominal cruzable", "check", "cross", "cross", "manual"],
  ["Diff entre versiones", "check", "cross", "cross", "manual"],
  ["Adaptación al despacho", "check", "cross", "cross", "cross"],
  ["Tiempo a una respuesta", "~ 2 segundos", "~ 1 día (por reportes)", "~ 30 segundos sin cita", "~ días"],
];

const cols = [
  { name: "cl2", hint: "memoria institucional", ours: true },
  { name: "Alertas corporativas", hint: "monitoreo de impacto", ours: false },
  { name: "IA general", hint: "asistente abierto", ours: false },
  { name: "Status quo manual", hint: "PDFs + carpetas", ours: false },
];

const renderCell = (v: Cell, ours: boolean) => {
  if (v === "check") return <Icon name="check" size={16} stroke={2} className="cmp-check" />;
  if (v === "cross") return <Icon name="x" size={16} stroke={2} className="cmp-cross" />;
  if (v === "partial") return <Icon name="minus" size={16} stroke={2} className="cmp-partial" />;
  if (v === "manual") return <span className="font-mono text-[11px] text-cl2-ink/50">manual</span>;
  return (
    <span
      className="text-[12.5px]"
      style={{
        color: ours ? "hsl(var(--cl2-ink))" : "hsl(var(--cl2-ink) / 0.7)",
        fontWeight: ours ? 500 : 400,
      }}
    >
      {v}
    </span>
  );
};

export const Comparison = () => {
  const [hoverRow, setHoverRow] = useState<number | null>(null);
  const [hoverOursCol, setHoverOursCol] = useState(false);

  return (
    <Section id="comparativa" eyebrow="Comparativa honesta" kicker="05 / contra qué">
      <Reveal>
        <div className="flex items-end justify-between gap-8 flex-wrap mb-10">
          <h2 className="display display--lg max-w-[720px]">
            No competimos por alertas.
            <br />
            <em>Competimos por la cita.</em>
          </h2>
          <p className="lede max-w-[380px] text-[15px]">
            Cada herramienta resuelve algo. Esta tabla muestra qué resuelve cada una mejor.
          </p>
        </div>
      </Reveal>

      <Reveal delay={120}>
        <div
          className="overflow-x-auto rounded-2xl bg-white border border-cl2-ink/[0.08] transition-shadow duration-300"
          style={{
            boxShadow: hoverOursCol
              ? "0 20px 50px hsl(var(--cl2-burgundy) / 0.12), 0 4px 16px hsl(var(--cl2-burgundy) / 0.08)"
              : "var(--shadow-ink-subtle)",
          }}
        >
          <table className="w-full font-sans text-[13.5px]" style={{ minWidth: 760, borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th
                  className="text-left px-5 pt-5 pb-4 border-b border-cl2-ink/10 font-medium text-[11px] uppercase tracking-widest text-cl2-ink/40"
                  style={{ width: "24%" }}
                >
                  Aspecto
                </th>
                {cols.map((c) => (
                  <th
                    key={c.name}
                    onMouseEnter={() => c.ours && setHoverOursCol(true)}
                    onMouseLeave={() => c.ours && setHoverOursCol(false)}
                    className="text-left px-5 pt-5 pb-4 border-b border-cl2-ink/10 transition-colors"
                    style={{
                      width: "19%",
                      background: c.ours
                        ? hoverOursCol
                          ? "hsl(var(--cl2-burgundy) / 0.08)"
                          : "hsl(var(--cl2-burgundy) / 0.04)"
                        : "transparent",
                      borderLeft: c.ours ? "1px solid hsl(var(--cl2-burgundy) / 0.18)" : "none",
                      borderRight: c.ours ? "1px solid hsl(var(--cl2-burgundy) / 0.18)" : "none",
                    }}
                  >
                    <div
                      className="serif text-[17px]"
                      style={{
                        color: c.ours ? "hsl(var(--cl2-burgundy))" : "hsl(var(--cl2-ink))",
                        fontWeight: 500,
                        fontStyle: c.ours ? "italic" : "normal",
                      }}
                    >
                      {c.name}
                    </div>
                    <div className="text-[10.5px] text-cl2-ink/45 mt-0.5 uppercase tracking-wider font-mono">
                      {c.hint}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={i}
                  onMouseEnter={() => setHoverRow(i)}
                  onMouseLeave={() => setHoverRow(null)}
                  className="transition-colors"
                  style={{
                    background: hoverRow === i ? "hsl(var(--cl2-burgundy) / 0.025)" : "transparent",
                  }}
                >
                  <td
                    className="px-5 py-3.5 text-[12.5px] text-cl2-ink/65"
                    style={{ borderTop: i ? "1px solid hsl(var(--cl2-ink) / 0.06)" : "none" }}
                  >
                    {r[0]}
                  </td>
                  {(r.slice(1) as Cell[]).map((v, j) => (
                    <td
                      key={j}
                      className="px-5 py-3.5"
                      style={{
                        borderTop: i ? "1px solid hsl(var(--cl2-ink) / 0.06)" : "none",
                        background: cols[j].ours
                          ? hoverOursCol
                            ? "hsl(var(--cl2-burgundy) / 0.08)"
                            : "hsl(var(--cl2-burgundy) / 0.04)"
                          : "transparent",
                        borderLeft: cols[j].ours ? "1px solid hsl(var(--cl2-burgundy) / 0.18)" : "none",
                        borderRight: cols[j].ours ? "1px solid hsl(var(--cl2-burgundy) / 0.18)" : "none",
                      }}
                    >
                      {renderCell(v, cols[j].ours)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Reveal>

      <p className="mt-5 text-[11.5px] text-cl2-ink/50 font-mono">
        Comparativa basada en pruebas internas · marzo 2026 · sin nombrar marcas comerciales
      </p>
    </Section>
  );
};
