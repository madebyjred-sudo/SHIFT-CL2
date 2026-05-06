import { useState } from "react";
import { Icon } from "./Icon";
import { Section, Reveal } from "./Primitives";

type Cell = string | "check" | "cross" | "partial" | "manual";

const rows: [string, Cell, Cell, Cell, Cell][] = [
  ["Pensado para", "Despachos legislativos costarricenses", "Cualquiera", "Quien sepa buscar", "Quien tenga tiempo"],
  ["Conoce el archivo de la Asamblea", "check", "cross", "partial", "manual"],
  ["Cita verificable al folio o minuto", "check", "cross", "cross", "manual"],
  ["No inventa cuando no sabe", "check", "cross", "cross", "manual"],
  ["Recuerda las posiciones de tu despacho", "check", "cross", "cross", "cross"],
  ["Vigila lo que cambia mientras dormís", "check", "cross", "cross", "cross"],
  ["Te entrega el brief y la presentación", "check", "cross", "partial", "manual"],
  ["Tiempo a una respuesta útil", "~ 2 segundos", "~ 30 segundos sin cita", "~ horas buscando", "~ días"],
];

const cols = [
  { name: "cl2", hint: "memoria institucional", ours: true },
  { name: "IA general", hint: "responde sobre todo, no sabe nada de la Asamblea", ours: false },
  { name: "El archivo nativo", hint: "guarda los documentos, no los lee", ours: false },
  { name: "El método tradicional", hint: "carpetas, PDFs y memoria del asesor", ours: false },
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
    <Section id="comparativa" eyebrow="cl2 vs lo que ya usaban" kicker="05 / contra qué">
      <Reveal>
        <div className="flex items-end justify-between gap-8 flex-wrap mb-10">
          <h2 className="display display--lg max-w-[720px]">
            Lo que ya tenían
            <br />
            <em>no estaba pensado para esto.</em>
          </h2>
          <p className="lede max-w-[380px] text-[15px]">
            Cada alternativa resuelve algo. Ninguna estaba diseñada para el día a día de un despacho legislativo costarricense — hasta cl2.
          </p>
        </div>
      </Reveal>

      {/* Mobile: stacked rows — one block per aspect with the four
          column values listed. The full table needs ~760px and would
          force horizontal scroll, which kills comparison legibility. */}
      <Reveal delay={120}>
        <div className="md:hidden space-y-3">
          {rows.map((r, i) => (
            <div
              key={i}
              className="rounded-xl bg-white border border-cl2-ink/[0.08] overflow-hidden"
              style={{ boxShadow: "var(--shadow-ink-subtle)" }}
            >
              <div className="px-4 py-2.5 border-b border-cl2-ink/[0.06] bg-cl2-ink/[0.015] font-mono text-[10.5px] uppercase tracking-widest text-cl2-ink/65">
                {r[0]}
              </div>
              <div className="divide-y divide-cl2-ink/[0.05]">
                {(r.slice(1) as Cell[]).map((v, j) => (
                  <div
                    key={j}
                    className="flex items-start justify-between gap-3 px-4 py-2.5"
                    style={{
                      background: cols[j].ours ? "hsl(var(--cl2-burgundy) / 0.04)" : "transparent",
                    }}
                  >
                    <div className="flex-1 min-w-0">
                      <div
                        className="serif text-[14px] leading-tight"
                        style={{
                          color: cols[j].ours ? "hsl(var(--cl2-burgundy))" : "hsl(var(--cl2-ink))",
                          fontWeight: 500,
                          fontStyle: cols[j].ours ? "italic" : "normal",
                        }}
                      >
                        {cols[j].name}
                      </div>
                      <div className="text-[10px] text-cl2-ink/45 mt-0.5 uppercase tracking-wider font-mono">
                        {cols[j].hint}
                      </div>
                    </div>
                    <div className="flex-shrink-0 self-center text-right max-w-[55%]">
                      {renderCell(v, cols[j].ours)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Reveal>

      {/* Desktop: original table — md+ */}
      <Reveal delay={120}>
        <div
          className="hidden md:block overflow-x-auto rounded-2xl bg-white border border-cl2-ink/[0.08] transition-shadow duration-300"
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
        Tabla honesta · sin nombrar marcas · cada herramienta hace bien lo que fue diseñada para hacer
      </p>
    </Section>
  );
};
