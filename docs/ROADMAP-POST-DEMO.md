# CL2 — Roadmap Post-Demo

**Última actualización:** 2026-04-25
**Audiencia:** Juanma (director Shift) + futuras sesiones de coding
**Status:** Documento vivo. NO compartir con Oscar — interno.

---

## Propósito

Este documento registra **funcionalidades fuera de scope para el demo del 2026-05-08** que valen la pena construir después. El demo se enfoca en pipeline base (5 agentes + ingest SIL + Atlas básico). Todo lo aquí listado es post-demo, ordenado por prioridad estratégica al final.

Regla: **no se descarta ninguna idea**. Si algo no entra al MVP, queda acá con criterios concretos para retomarlo.

---

## 1. Predictor de aprobación de proyectos

- 📌 **Qué es:** modelo ML que estima la probabilidad de que un expediente llegue a ley aprobada. Output ejemplo: *"Exp. 24.183 — 23% probabilidad de aprobación, principal factor: comisión de Hacendarios + proponente sin votos suficientes en su fracción"*.
- 💡 **Por qué vale:** transforma a Lexa de descriptor a predictivo. Es el feature que justifica un pricing tier "Pro" para estudios jurídicos y consultoras políticas. Defensibilidad: el modelo mejora con cada ciclo legislativo, competidor 57 no tiene nada equivalente.
- ⚙️ **Implementación:** logistic regression baseline + XGBoost si aporta. Dataset: `sil_expedientes` con `estado` final como label binario (aprobado/no). Features candidatas: comisión asignada, fracción del proponente, tipo de iniciativa, mes de presentación, número de mociones recibidas, tiempo en cola, co-firmantes. Pipeline: notebook de training + endpoint `/api/predict/expediente/:id` en BFF + tarjeta en Atlas.
- ⏱️ **Esfuerzo:** 8–12h (4h feature engineering, 3h training+validación, 3h endpoint+UI, 2h documentación del modelo).
- 🚧 **Prerequisitos:** corpus completo de `sil_expedientes` con estados estabilizados (>2 ciclos legislativos visibles), labels limpios. No se puede entrenar sobre los 25k actuales si el 60% está "en trámite".
- 📈 **Métrica de éxito:** AUC ≥ 0.75 sobre holdout de últimos 6 meses, calibración decente (Brier score < 0.20).
- 📅 **Cuándo construir:** post-demo + 1 sprint, una vez Oscar valide que el feature mueve la aguja en su flujo.

---

## 2. Network graph de proponentes

- 📌 **Qué es:** grafo interactivo de diputados conectados por co-firmas y co-mociones. Permite ver clusters, brokers, convergencias cross-fracción.
- 💡 **Por qué vale:** visual narrativa potente. Es lo que un periodista o un consultor político paga por ver. Diferenciación clara vs. herramientas SIL oficiales que solo muestran tablas.
- ⚙️ **Implementación:** matriz de adyacencia construida desde `sil_iniciativas.recibido_por` + co-firmantes en mociones. Render frontend con d3-force o cytoscape.js dentro de Atlas. Filtros: período, tema, fracción. Click en nodo → drilldown a expedientes compartidos.
- ⏱️ **Esfuerzo:** 6–8h (2h query + matriz, 4h render+UX, 1h filtros).
- 🚧 **Prerequisitos:** tabla `sil_iniciativas` con co-firmantes parseados (verificar que el ingest los esté capturando, no solo el proponente principal).
- 📈 **Métrica de éxito:** detectar al menos 3 convergencias cross-fracción no obvias en demo a usuarios reales.
- 📅 **Cuándo construir:** post-demo + 1 sprint. Es bajo riesgo y alto impacto visual — buen candidato para sprint inmediato post-validación.

---

## 3. Centinela live alerts (push notifications)

- 📌 **Qué es:** worker cron que cada 2h lee deltas de `sil_crawl_runs`, matchea con watchlists del usuario, dispara push (email + Slack + futuro WhatsApp).
- 💡 **Por qué vale:** **es lo que justifica que Centinela sea un agente separado**. Sin alertas live, Centinela es solo un buscador. Con alertas, es el motor de retención del producto — el usuario abre la app porque le llegó algo.
- ⚙️ **Implementación:** nueva tabla `sil_watchlists (user_id, query_dsl, channels, last_notified)`. Worker en BFF (node-cron o BullMQ) cada 2h. Diff sobre el último crawl. Render del email/slack con plantillas mustache. Endpoint REST para CRUD de watchlists.
- ⏱️ **Esfuerzo:** 8–10h (2h schema + migración, 3h worker + diff, 2h plantillas notif, 2h CRUD UI, 1h tests).
- 🚧 **Prerequisitos:** `sil_crawl_runs` debe tener timestamps confiables y diffing limpio. Cuenta de envío email (Resend/Postmark) y webhook Slack del usuario.
- 📈 **Métrica de éxito:** ≥ 1 alerta accionada/usuario/semana (open rate > 40%).
- 📅 **Cuándo construir:** post-demo + 1 sprint. Es el segundo feature en construir tras grafo de proponentes.

---

## 4. Multi-tenant cross-pollination (Lexa + Punto Medio)

- 📌 **Qué es:** Lexa puede traer patrones consolidados de Garnier (anonimizados) cuando aplican al contexto legislativo. Ej: *"Otros sectores tipicamente subestiman fricción en última milla — ver pattern PM-0142"*.
- 💡 **Por qué vale:** activa el flywheel real. Cada cliente nuevo de Punto Medio mejora Lexa y viceversa. Defensibilidad compuesta — esto es lo que un competidor no puede replicar sin años de datos.
- ⚙️ **Implementación:** consulta a Cerebro (Punto Medio) vía endpoint existente, filtro por categorías cross-applicables, PII scrubber sobre el output, inyección como contexto adicional en el prompt de Lexa.
- ⏱️ **Esfuerzo:** 4h una vez Punto Medio tenga consolidaciones aprobadas y la API expuesta.
- 🚧 **Prerequisitos:** **N ≥ 50 insights aprobados manualmente en Punto Medio**. PII scrubber probado. Categorías cross-domain definidas (ver feature 6).
- 📈 **Métrica de éxito:** ≥ 1 insight cross-domain citado por respuesta de Lexa en el 15% de queries relevantes, sin que sea ruido (verificar tasa de thumbs-down).
- 📅 **Cuándo construir:** disparador concreto = umbral de 50 insights aprobados. No antes.

---

## 5. Replicación geográfica LATAM — POSPUESTO INDEFINIDAMENTE

> ⚠️ **DISCLAIMER:** el user dijo explícitamente *"no me interesa pasarlo a un proyecto nivel LATAM"*. Esta sección queda registrada por completitud. **NO trabajar en esto salvo reactivación explícita del user.**

- 📌 **Qué es:** el playbook CL2 (scrape SIL → ingest → 5 agentes) es portable a cualquier asamblea con SharePoint default exposure. Candidatos identificados: Honduras, Guatemala, Panamá, Ecuador, República Dominicana.
- 💡 **Por qué vale (en abstracto):** mercado total expandido ~5x, mismo stack, mismo go-to-market.
- ⚙️ **Implementación (si se reactivara):** scraper genérico parametrizable + tenant isolation a nivel DB + i18n mínimo en Atlas.
- ⏱️ **Esfuerzo (si se reactivara):** 4–6 sprints por país nuevo (mayoritariamente parsing-specific).
- 📅 **Cuándo construir:** **N/A — pospuesto indefinidamente**.

---

## 6. Taxonomía legislativa paralela en Punto Medio

- 📌 **Qué es:** las 4 categorías actuales del Peaje (Riesgos Ciegos, Patrones Sectoriales, Gaps Productividad, Vectores Aceleración) están pensadas para consultoría B2B. Para CL2 conviene **agregar (no reemplazar)** 4 categorías legislativas paralelas:
  1. **Patrones de Voto** — clusters de comportamiento en votaciones nominales.
  2. **Riesgos Procedimentales** — mociones que históricamente matan proyectos (consultas, archivo, etc.).
  3. **Convergencias Inesperadas** — co-firmas cross-fracción atípicas.
  4. **Ventanas de Oportunidad Legislativa** — momentos del calendario con mayor tasa de aprobación por tipo de iniciativa.
- 💡 **Por qué vale:** sin taxonomía propia, los insights legislativos se diluyen en categorías B2B que no aplican. Esto también prepara el terreno para el cross-pollination (feature 4) — define qué cruza y qué no.
- ⚙️ **Implementación:** modificar `peaje/extractor.py` para emitir categorías nuevas según el tipo de fuente (legislativa vs. corporativa). Migración Cerebro DB para extender el enum `insight_category`. Update del scoring/ranking para no mezclar categorías al ranking principal.
- ⏱️ **Esfuerzo:** ~2h código + 1h migración + 1h validación.
- 🚧 **Prerequisitos:** ninguno técnico. Sí necesitamos data real (2–3 meses de uso) para validar que las categorías están bien definidas antes de codificarlas hard.
- 📈 **Métrica de éxito:** los insights nuevos se distribuyen razonablemente entre las 4 (ninguna < 10%, ninguna > 50%).
- 📅 **Cuándo construir:** post-demo + 2–3 meses de uso real. No antes — necesitamos data para validar.

---

## 7. Productos verticales premium (líneas de monetización)

Cinco SKUs premium derivados del stack base. Tabla de overview:

| SKU                     | Target                   | Pricing             | Esfuerzo build     | Estado actual    |
|-------------------------|--------------------------|---------------------|--------------------|------------------|
| **Lexa Pro**            | Estudios jurídicos       | $500–2k / mes       | ~1 sprint          | Casi listo       |
| **Centinela Enterprise**| Consultoras políticas    | $1–5k / mes         | 2 sprints          | Necesita feat 3  |
| **Atlas Investigaciones**| Periodismo de datos     | $300–800 / mes      | 1–2 sprints        | Necesita feat 2  |
| **API premium analytics**| Universidades + ONG     | $200–500 / mes      | 1 sprint           | Stub            |
| **Punto Medio Legal CR**| Despachos + legal-tech   | $1–5k setup + uso   | 3 sprints          | Necesita fine-tune Haiku |

**Detalle por SKU:**

- **Lexa Pro:** Lexa actual + predictor (feat 1) + export PDF + branded reports. Esfuerzo incremental: 1 sprint. **Es la primera apuesta de monetización post-demo.**
- **Centinela Enterprise:** Centinela + alertas (feat 3) + watchlists multi-usuario + reportes ejecutivos semanales. Necesita feat 3 listo.
- **Atlas Investigaciones:** Atlas + grafo (feat 2) + export de visualizaciones para uso editorial + créditos por uso. Necesita feat 2 listo.
- **API premium analytics:** endpoints REST limpios sobre la base de datos legislativa, con rate limiting y billing por request. Esfuerzo: documentación OpenAPI + Stripe metered billing.
- **Punto Medio Legal CR:** fine-tune de Haiku con corpus legal CR (jurisprudencia + leyes vigentes + reglamento Asamblea). Producto premium para despachos. Esfuerzo alto pero margen alto.

📅 **Cuándo construir:** post-demo, después de que Oscar valide value prop. Lexa Pro primero (menor esfuerzo, mayor señal de mercado).

---

## Orden de prioridad post-demo

Criterio: **ROI estratégico × inverso del esfuerzo × prerequisitos cumplidos hoy**.

| # | Feature                                  | Orden | Razón                                                                             |
|---|------------------------------------------|-------|-----------------------------------------------------------------------------------|
| 1 | Network graph de proponentes             | 1°    | Bajo esfuerzo, alto impacto visual, prerequisitos casi listos. Quick win.         |
| 2 | Centinela live alerts                    | 2°    | Justifica el agente separado y activa retención. Crítico para Centinela Enterprise. |
| 3 | Lexa Pro (SKU)                           | 3°    | Primera línea de monetización. Construir en paralelo con #1 si hay banda.         |
| 4 | Predictor de aprobación                  | 4°    | Alto valor pero requiere corpus estable. Esperar 1 sprint adicional de ingest.    |
| 5 | Taxonomía legislativa paralela           | 5°    | Necesita 2–3 meses de data real antes de codificar.                               |
| 6 | Multi-tenant cross-pollination           | 6°    | Disparador = N≥50 insights aprobados. No forzar.                                  |
| 7 | Resto de SKUs premium (Centinela Ent., Atlas Inv., API, PM Legal) | 7° | Construir on-demand según señal comercial.                                        |
| — | Replicación LATAM                        | N/A   | Pospuesto indefinidamente por decisión del user.                                  |

---

## Notas de mantenimiento

- Revisar este doc al cierre de cada sprint post-demo. Si una feature ya entró a producción, moverla a `CHANGELOG.md`. Si surge una nueva idea, agregarla acá con la misma estructura (📌 💡 ⚙️ ⏱️ 🚧 📈 📅).
- Si el user reactiva replicación LATAM, abrir un doc separado `ROADMAP-LATAM.md` — no inflar este.
- Cualquier cambio de prioridad documentarlo con fecha y motivo (1 línea) al pie de la tabla.
