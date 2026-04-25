# Una nota sobre el SIL — para Oscar

**Fecha:** 2026-04-25
**De:** Juanma (Shift)
**Asunto:** Descubrimos el camino corto al SIL

---

## El problema que ya conocíamos

Cuando empezamos a planear cómo iba a hablar Cerebro Legislativo 2.0 con el
SIL, había un consenso en el aire que iba más o menos así:

> *"El SIL no tiene API pública. Para usarlo en tiempo casi-real, la única
> opción es montar bots que naveguen el sitio como un humano — abrir
> ventanas, llenar formularios, esperar respuestas. Eso es frágil, lento y
> hay que mantenerlo cada vez que la Asamblea cambia algo en su web."*

Es lo que se había explorado antes. Y técnicamente es cierto: si la única
manera de acceder al SIL es a través de su pantalla de búsqueda, hay que
simular un navegador. Eso significa una flota de bots tipo "robot que abre
Chrome", lentos (30 segundos por consulta), caros (cada bot consume RAM y
CPU), y que se rompen cada vez que la Asamblea hace un cambio cosmético en
el sitio.

Es la solución estándar cuando no hay API. Y es la peor opción de todas
las opciones posibles.

## Lo que descubrimos esta semana

Antes de escribir una sola línea de bot, nuestro equipo de ingeniería hizo
algo que nadie había hecho hasta ahora: abrió el SIL **con la mentalidad
de un desarrollador, no de un usuario**. Lo que encontramos cambió el
tablero completo.

**Hallazgo 1.** El sitio principal del SIL (`asamblea.go.cr/glcp`) corre
sobre un sistema llamado SharePoint, que Microsoft vende a empresas e
instituciones desde hace 15 años. SharePoint, por diseño, expone
automáticamente toda su información estructurada (mociones, dictámenes,
leyes aprobadas, iniciativas) a través de una **interfaz de datos directa
y abierta**. No es un secreto — es una característica documentada que
viene incluida. Solo hay que saber dónde mirar.

> Dicho fácil: la información de las mociones, dictámenes y leyes ya
> está disponible en formato consumible por máquinas, sin necesidad de
> simular un navegador. Es como descubrir que la puerta de servicio
> estaba abierta mientras todos peleaban con el candado de la puerta
> principal.

**Hallazgo 2.** El sistema secundario (`consultassil3`) que guarda los
expedientes históricos — los 25 mil expedientes desde el inicio del SIL —
está construido con tecnología Microsoft pre-2010. Eso suena mal, pero en
realidad es una ventaja: esa tecnología se comunica de forma simple y
predecible, sin las complicaciones modernas de páginas dinámicas.
Podemos consultarlo directamente, sin bots simulando navegadores.

## Qué significa esto en términos prácticos

Lo que iba a tomar **cuatro semanas de ingeniería frágil** se convirtió en
**dos a tres días de scrapers HTTP simples y robustos**. Y lo más
importante:

| | Estrategia anterior (bots tipo Playwright) | Estrategia que descubrimos |
|---|---|---|
| Tiempo de implementación | 4-6 semanas | 2-3 días |
| Velocidad por consulta | 15-30 segundos | 200-500 ms |
| Estabilidad ante cambios cosméticos del SIL | Se rompe seguido | Se rompe solo si rediseñan toda la arquitectura |
| Costo de servidor | Alto (browsers virtuales corriendo) | Mínimo (peticiones HTTP normales) |
| Cobertura de datos | Limitada a lo que un humano vería en pantalla | Acceso completo al data model público |

Para tu demo del 8 de mayo: **vamos a tener los 25 mil expedientes
indexados, buscables, citables, con link directo al SIL para verificación
en cada respuesta.** El toggle "Análisis Profundo" (que internamente usa
nuestro modelo más potente) va a poder leer el texto completo de los
proyectos de ley y los dictámenes de mayoría/minoría — no solo los
títulos.

## Lo que esto NO resuelve, y lo que recomendamos para mediano plazo

Esta solución es robusta y ética: usamos solo datos públicos bajo licencia
Creative Commons (CC BY 4.0, atribuyendo a la Asamblea), sin saltar
ningún sistema de autenticación, sin sobrecargar al SIL con tráfico
agresivo. Pero es una solución **basada en consumir un servicio que la
Asamblea ofrece sin haberlo pensado como API formal**.

Para los próximos 6-12 meses esto es suficiente. Para horizonte más
largo, mi recomendación es:

> **No pidamos a la Asamblea que nos haga una API nueva** — eso es caro,
> lento y políticamente complicado. **Pidamos credenciales formales para
> el endpoint que ya existe**. Es un papel firmado, no un proyecto de
> ingeniería. Te blinda contractualmente sin que nadie de TI tenga que
> escribir código.

Esa conversación la podemos abrir cuando la herramienta ya esté
funcionando y tu equipo tenga 6 meses de uso real para argumentar valor.

---

**Próximo paso inmediato:** terminar la indexación de los expedientes y
sus PDFs en los próximos dos días. La demo del 8 de mayo va con SIL
completo y citable.

Cualquier duda técnica más fina, te la respondemos sin jerga.

— Juanma + equipo Shift
