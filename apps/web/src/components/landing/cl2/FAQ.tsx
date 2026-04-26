import { useState } from "react";
import { Icon } from "./Icon";
import { Section, Reveal } from "./Primitives";

const items = [
  { q: "¿Quién puede acceder hoy?", a: "Estamos en piloto cerrado con un grupo acotado de redacciones, despachos legislativos y centros de pensamiento. Solicitá acceso desde el formulario al final de esta página — revisamos cada solicitud manualmente." },
  { q: "¿En qué se diferencia de ChatGPT o Gemini?", a: "cl2 trabaja exclusivamente sobre el archivo legislativo costarricense indexado. No improvisa: si una afirmación no está en el archivo, el sistema responde \"no encuentro evidencia\" y se detiene. Cada respuesta cita el folio o el minuto exacto. Las IAs generales no tienen ese anclaje." },
  { q: "¿Qué tan profundo es el archivo?", a: "Plenarios desde 1998. Expedientes activos en SIL. Dictámenes de comisión digitalizados desde 2010 con cobertura creciente hacia atrás. Audios oficiales de plenario con timestamp para sesiones desde 2022. Trabajamos con la institución para ampliar la cobertura histórica." },
  { q: "¿Las citas son inventadas?", a: "No. La demo de arriba está conectada al archivo real — cada cita lleva al folio o minuto exacto. Si Lexa no encuentra respaldo en el archivo, te dice que no encontró. Esa regla — 'sin cita, sin respuesta' — es el guardrail principal del producto, no un eslogan." },
  { q: "¿El sistema puede equivocarse?", a: "Sí, los modelos generativos pueden equivocarse. cl2 mitiga eso con dos mecanismos: (1) recuperación estricta sobre el archivo antes de generar, (2) lineamientos editoriales escritos por la jefatura del despacho — reglas como 'cuando exista un voto en contra, citarlo' — que quedan inyectadas al system prompt de los tres asesores. Cuando algo sale mal, lo reportamos." },
  { q: "¿Qué datos usa cl2 y qué hace con mis consultas?", a: "cl2 trabaja exclusivamente sobre material público por mandato: actas, expedientes, dictámenes y audios oficiales de la Asamblea. Tus consultas son sesión-locales y se descartan al cerrar — no se usan para entrenar modelos, no se venden a terceros, no se comparten entre despachos." },
  { q: "¿Dónde corre la infraestructura?", a: "Desplegable en regiones acordadas con la institución cliente, sin transferencias inadvertidas a terceros países. Firmamos acuerdos de procesamiento de datos antes de cualquier despliegue institucional. Cada respuesta deja rastro auditable: qué fuente se consultó, qué folio se citó, qué versión del modelo respondió, en qué fecha." },
  { q: "¿Cuánto cuesta?", a: "No publicamos precios todavía. El piloto se contrata por institución con un acuerdo a medida según cobertura, número de usuarios y nivel de soporte. Escribinos para recibir una propuesta." },
  { q: "¿Funciona para empresas?", a: "cl2 está diseñado para periodismo, análisis y trabajo legislativo institucional. Si tu empresa necesita alertas de impacto regulatorio, hay otras herramientas especializadas en eso. Si tu empresa necesita análisis político profundo con cita verificable, sí — habilitamos casos puntuales." },
  { q: "¿Es de código abierto?", a: "Hoy no. Publicamos abiertamente la metodología de indexado, los compromisos de privacidad y las correcciones cuando algo falla. Estamos evaluando abrir partes específicas — la decisión depende del balance entre transparencia y sustentabilidad del proyecto." },
  { q: "¿Quién está detrás?", a: "cl2 es un producto de Shift, una compañía costarricense de inteligencia institucional. Equipo en San José. Trabajamos sobre material público de la Asamblea — no requerimos acuerdo con la institución para indexar lo que ya está abierto, aunque mantenemos el canal abierto con quien quiera colaborar." },
  { q: "¿Cómo evitan sesgos políticos?", a: "El sistema cita lo que el archivo dice — no opina. Si pedís un resumen de posiciones, el sistema te muestra las posiciones citadas, sin ponderarlas. La transparencia de la fuente es la principal defensa contra sesgos: vos podés siempre verificar la cita original." },
  { q: "¿Puedo descargar mis consultas?", a: "Sí. Cada conversación se exporta en PDF o Markdown con citas hipervinculadas. Los reportes generados se pueden archivar para auditoría editorial." },
  { q: "¿Qué pasa con los datos de mi despacho?", a: "Los datos de tu despacho son tuyos. Si subís documentos privados (notas, borradores, briefs), permanecen aislados a tu workspace y no se usan para entrenar nada. Podés exportar y borrar todo en cualquier momento." },
];

export const FAQ = () => {
  const [open, setOpen] = useState<number>(0);

  return (
    <Section id="faq" eyebrow="Preguntas frecuentes" kicker="08 / lo que nos preguntan">
      <div className="grid gap-10 md:gap-16 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-start">
        <Reveal>
          <div>
            <h2 className="display display--lg">
              Lo que vale la pena
              <br />
              <em>preguntarse</em> antes.
            </h2>
            <p className="text-[14px] text-cl2-ink/65 mt-5 leading-[1.65]">
              Si tu pregunta no está acá, escribinos al formulario de acceso. Las respuestas
              reales nos ayudan a iterar la página.
            </p>
          </div>
        </Reveal>

        <div className="border-t border-cl2-ink/10">
          {items.map((it, i) => {
            const isOpen = open === i;
            return (
              <div key={i} className="border-b border-cl2-ink/[0.08]">
                <button
                  onClick={() => setOpen(isOpen ? -1 : i)}
                  className="w-full text-left flex justify-between items-baseline gap-6 py-5 bg-transparent border-none text-cl2-ink"
                >
                  <span className="flex gap-4 items-baseline flex-1">
                    <span className="font-mono text-[11px] text-cl2-ink/40 flex-shrink-0">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span
                      className="serif text-[18px]"
                      style={{ fontWeight: 500, letterSpacing: "-0.01em", lineHeight: 1.35 }}
                    >
                      {it.q}
                    </span>
                  </span>
                  <Icon name={isOpen ? "minus" : "plus"} size={16} className="text-cl2-ink/45 flex-shrink-0" />
                </button>
                {isOpen && (
                  <div
                    className="pl-[47px] pr-4 pb-6 text-[14px] text-cl2-ink/75 leading-[1.7]"
                    style={{ animation: "fadeUp 200ms var(--ease-out)" }}
                  >
                    {it.a}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </Section>
  );
};
