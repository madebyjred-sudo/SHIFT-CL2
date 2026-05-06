import { useState } from "react";
import { Icon } from "./Icon";
import { Section, Reveal } from "./Primitives";

const items = [
  { q: "¿Quién puede acceder hoy?", a: "Estamos en piloto cerrado con un grupo acotado de despachos legislativos, redacciones políticas y centros de pensamiento. Solicitá acceso desde el formulario — revisamos cada solicitud manualmente. Buscamos despachos que quieran trabajar serio, no probar diez herramientas." },
  { q: "¿Qué hace cl2 que no haga un asistente de IA general?", a: "cl2 trabaja exclusivamente sobre el archivo legislativo costarricense. Conoce el SIL, el Reglamento, las plenarias y la agenda. Cuando responde, cita el folio o el minuto exacto. Si no encuentra respaldo en el archivo, dice 'no encontré' y se detiene — nunca inventa. Un asistente general responde sobre cualquier cosa, pero no sabe nada de tu institución." },
  { q: "¿Qué es un workspace de trabajo?", a: "Una página donde armás todo un proyecto de ley en un solo lugar: texto base, dictámenes, votaciones cruzadas, posiciones de bancada, notas de tu equipo. Atlas te ayuda a llenarlo desde el archivo. Lo retomás semanas después como si nunca te hubieras ido." },
  { q: "¿Qué tipo de avisos da Centinela?", a: "Cuatro: cuando un expediente que vigilás cambia de estado, cuando se acerca un plazo importante, cuando te mencionan en una sesión plenaria, y cuando un expediente vigilado entra al orden del día. Sin alertas que se borran sin leer — solo lo sustantivo." },
  { q: "¿Las presentaciones tienen mi marca?", a: "cl2 te entrega la presentación con el tono, la audiencia y los lineamientos del despacho que vos le indiques. La marca visual concreta — logo, paleta — la podés aplicar editando la presentación una vez generada, y guardar esa plantilla como referencia para la próxima." },
  { q: "¿Qué tan profundo es el archivo?", a: "Veintiún mil seiscientos veinte expedientes del SIL leídos como una sola continuidad. Doscientas treinta y cinco sesiones plenarias transcritas con marca de tiempo. Los noventa y seis artículos del Reglamento. La agenda de plenario y comisiones, actualizada. Todo conectado para que una pregunta no requiera abrir catorce documentos." },
  { q: "¿Las citas son inventadas?", a: "No. Cada respuesta de cl2 lleva una cita al folio del archivo o al minuto exacto del video oficial. Si cl2 no encuentra respaldo en el archivo, te dice que no encontró y se detiene. Esa regla — 'sin cita, sin respuesta' — es el guardrail principal del producto, no un eslogan." },
  { q: "¿cl2 puede equivocarse?", a: "Sí. Lo mitigamos con dos cosas: cl2 solo responde sobre lo que tiene en archivo, y los lineamientos del despacho — escritos por tu jefatura — quedan inyectados en cada respuesta para mantener la voz y los criterios de tu equipo. Cuando algo sale mal, lo reportamos abiertamente." },
  { q: "¿Qué hace cl2 con mis consultas?", a: "cl2 trabaja sobre material público por mandato: actas, expedientes, dictámenes y audios oficiales de la Asamblea. Tus consultas son privadas. No se usan para entrenar modelos, no se venden a terceros, no se comparten entre despachos." },
  { q: "¿Cuánto cuesta?", a: "No publicamos precios todavía. El piloto se contrata por institución con un acuerdo a medida según número de usuarios y nivel de soporte. Durante el piloto no hay cobro." },
  { q: "¿Funciona para empresas?", a: "cl2 está diseñado para periodismo político, análisis legislativo y trabajo de despacho. Si tu empresa necesita análisis político profundo con cita verificable, abrimos casos puntuales — escribinos." },
  { q: "¿Quién está detrás?", a: "cl2 es un producto de Shift, una compañía costarricense de inteligencia institucional. Equipo en San José. Trabajamos sobre material público de la Asamblea — no requerimos acuerdo con la institución para indexar lo que ya está abierto." },
  { q: "¿Cómo evitan sesgos políticos?", a: "cl2 cita lo que el archivo dice — no opina. Si pedís un resumen de posiciones, te muestra las posiciones citadas, sin ponderarlas. La transparencia de la fuente es la principal defensa contra sesgos: vos podés verificar la cita original siempre." },
  { q: "¿Puedo descargar mis trabajos?", a: "Sí. Cada conversación se exporta con citas hipervinculadas. Cada workspace se descarga como Word o presentación. Los lineamientos de tu despacho son tuyos, exportables y borrables en cualquier momento." },
  { q: "¿Qué pasa con los datos de mi despacho?", a: "Los datos de tu despacho son tuyos. Notas, borradores, briefs y lineamientos permanecen privados y no se usan para entrenar nada. Podés exportarlos y borrarlos cuando quieras." },
];

export const FAQ = () => {
  const [open, setOpen] = useState<number>(0);

  return (
    <Section id="faq" eyebrow="Preguntas frecuentes" kicker="07 / lo que nos preguntan">
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
