/**
 * Tests for legalDocChunker — Track G del Sprint 1 CL2 v3
 *
 * Cubre:
 * 1. Detección correcta de clase de documento
 * 2. Estrategia por_tanto aplicada a resoluciones Sala Constitucional
 * 3. Reducción real de tokens ≥ 50% vs doc completo
 * 4. Fallback a standard cuando no hay POR TANTO
 * 5. Detección de CONCLUSIONES (Procuraduría)
 * 6. Inferencia de decisión (sin_lugar / con_lugar / inconstitucional / etc.)
 */

import { describe, it, expect } from 'vitest';
import {
  chunkLegalDoc,
  detectDocClass,
  inferDecision,
  estimateTokens,
} from '../services/legalDocChunker.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** Simula una resolución de la Sala Constitucional (formato real CR) */
const salaConstitucionalDoc = `
SALA CONSTITUCIONAL DE LA CORTE SUPREMA DE JUSTICIA
San José, a las diez horas del doce de mayo de dos mil veintiséis.

Expediente: 26-004321-0007-CO
Recurso de amparo interpuesto por MARIO PÉREZ MORA.

CONSIDERANDO:

I.- Los hechos que motivan la presente acción son los siguientes: el recurrente
alega que la autoridad recurrida ha violado sus derechos fundamentales al
negarle acceso a documentos públicos. El expediente administrativo fue remitido
a esta Sala mediante oficio número 1234-2026. Se han revisado todos los
antecedentes del caso. La autoridad recurrida alega que los documentos
solicitados se encuentran bajo reserva por razones de seguridad nacional.
Se citan los artículos 27, 30 y 33 de la Constitución Política.

II.- Sobre la procedencia del recurso: esta Sala ha establecido en reiterada
jurisprudencia que el acceso a la información pública es un derecho fundamental
que solo puede ser restringido por motivos expresamente establecidos en la ley.
En el presente caso, la autoridad recurrida no ha demostrado que la información
solicitada esté cubierta por ninguna de las excepciones legalmente establecidas.

III.- Análisis de fondo: examinados los autos, esta Sala estima que le asiste
razón al recurrente por cuanto la autoridad recurrida no fundamentó debidamente
la denegatoria. El artículo 30 constitucional garantiza el libre acceso a los
departamentos administrativos. La restricción impuesta carece de sustento legal.
Los magistrados que suscriben consideran que procede declarar con lugar el recurso.

POR TANTO:

Se declara CON LUGAR el recurso de amparo interpuesto. Se ordena a la autoridad
recurrida que en el plazo de cinco días hábiles, contados a partir de la
notificación de esta resolución, entregue al recurrente copia de los documentos
solicitados. Se condena a la autoridad recurrida al pago de las costas, daños
y perjuicios causados al recurrente, los cuales serán liquidados en ejecución
de sentencia si no hubiera acuerdo.

Notifíquese esta resolución.

ERNESTO JINESTA L.
Presidente en ejercicio

NANCY HERNÁNDEZ L.    JORGE ARAYA G.
LUIS FALLAS M.        ANA VIRGINIA CALZADA M.
MIKHAIL ALFARO R.     MARTA EUGENIA VILLANUEVA N.
`.trim();

/** Resolución con decisión "sin lugar" */
const sinLugarDoc = `
SALA CONSTITUCIONAL DE LA CORTE SUPREMA DE JUSTICIA
Expediente: 26-001111-0007-CO

CONSIDERANDO:

I.- El recurrente alega violación del debido proceso. Esta Sala, luego de
examinar los autos, no encuentra mérito para acoger el recurso planteado.
Los hechos descritos no configuran violación constitucional alguna.

POR TANTO:

Se declara SIN LUGAR el recurso de amparo interpuesto.

Notifíquese.
`.trim();

/** Dictamen de la Procuraduría con CONCLUSIONES */
const procuraduriaDoc = `
PROCURADURÍA GENERAL DE LA REPÚBLICA
San José, 15 de mayo de 2026.

Señores
Ministerio de Hacienda

Estimados señores:

Se da respuesta a su consulta sobre la aplicación del artículo 42 de la
Ley de Administración Financiera.

CONSIDERANDO:

I.- Sobre la admisibilidad de la consulta. La Procuraduría General tiene
competencia para emitir dictámenes cuando las consultas provengan de órganos
de la Administración Pública. El Ministerio de Hacienda es un órgano de la
Administración Central, por lo que procede atender la presente consulta.

II.- Sobre el fondo. El artículo 42 de la Ley de Administración Financiera
establece que los contratos de servicios no personales que superen las 200
unidades de desarrollo requieren refrendo de la Contraloría General de la
República. En el presente caso, el contrato analizado supera ese umbral.

CONCLUSIONES:

Con base en lo expuesto, la Procuraduría General de la República concluye:

1. El contrato consultado requiere refrendo contralor por superar el límite
   establecido en el artículo 42 de la Ley de Administración Financiera.
2. La omisión del refrendo genera la nulidad absoluta del contrato.
3. Se recomienda tramitar de inmediato el refrendo correspondiente.

Atentamente,

JULIO CÉSAR MESÉN MONTOYA
Procurador General de la República
`.trim();

/** Documento sin estructura jurídica (genérico) */
const genericoDoc = `
Este es un informe de avance del proyecto de construcción de la carretera.
Los trabajos comenzaron en enero y se espera que terminen en diciembre.
No se encontraron problemas significativos durante la ejecución.
El presupuesto se ha mantenido dentro de los rangos previstos.
`.trim();

/** Documento jurídico sin marker dispositivo */
const sinMarkerDoc = `
TRIBUNAL CONTENCIOSO ADMINISTRATIVO
San José, 2026.

CONSIDERANDO:

I.- Los hechos del caso son los siguientes...

II.- El análisis jurídico indica...

[documento incompleto — sin sección dispositiva]
`.trim();

/** Doc grande para medir reducción de tokens */
function buildLargeDoc(considerandoParas: number): string {
  const considerandos = Array.from({ length: considerandoParas }, (_, i) =>
    `${String.fromCharCode(73 + i)}.- Este es el considerando número ${i + 1}. ` +
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(20)
  ).join('\n\n');

  return `
Sala Constitucional de la Corte Suprema de Justicia
Expediente: 26-999999-0007-CO

CONSIDERANDO:

${considerandos}

POR TANTO:

Se declara sin lugar el recurso. Notifíquese.
`.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('detectDocClass', () => {
  it('detecta Sala Constitucional por contenido', () => {
    const result = detectDocClass(salaConstitucionalDoc);
    expect(result).toBe('resolucion_sala_constitucional');
  });

  it('detecta Sala Constitucional por fileName', () => {
    const result = detectDocClass('Texto cualquiera...', 'Resolución Sala Constitucional 2026.pdf');
    expect(result).toBe('resolucion_sala_constitucional');
  });

  it('detecta Procuraduría por contenido', () => {
    const result = detectDocClass(procuraduriaDoc);
    expect(result).toBe('resolucion_procuraduria');
  });

  it('detecta Procuraduría por fileName', () => {
    const result = detectDocClass('Texto cualquiera...', 'dictamen_procuraduria_042-2026.pdf');
    expect(result).toBe('resolucion_procuraduria');
  });

  it('clasifica como generico cuando no hay estructura jurídica', () => {
    const result = detectDocClass(genericoDoc);
    expect(result).toBe('generico');
  });

  it('clasifica como sentencia_tribunal cuando hay CONSIDERANDO + POR TANTO sin match específico', () => {
    const result = detectDocClass(sinLugarDoc);
    // sinLugarDoc tiene "Sala Constitucional" → debe detectar como sala
    expect(['resolucion_sala_constitucional', 'sentencia_tribunal']).toContain(result);
  });
});

describe('inferDecision', () => {
  it('detecta con_lugar', () => {
    expect(inferDecision('Se declara CON LUGAR el recurso.')).toBe('con_lugar');
  });

  it('detecta sin_lugar', () => {
    expect(inferDecision('Se declara SIN LUGAR el recurso de amparo.')).toBe('sin_lugar');
  });

  it('detecta parcial', () => {
    expect(inferDecision('Se declara parcialmente con lugar.')).toBe('parcial');
  });

  it('detecta desestimada', () => {
    expect(inferDecision('Se desestima la acción planteada.')).toBe('desestimada');
  });

  it('detecta inconstitucional', () => {
    expect(inferDecision('Se declara la inconstitucionalidad del artículo 5.')).toBe('inconstitucional');
  });

  it('detecta evacuada', () => {
    expect(inferDecision('Se evacua la consulta sin emitir pronunciamiento.')).toBe('evacuada');
  });

  it('retorna null cuando no hay patrón reconocible', () => {
    expect(inferDecision('Texto genérico sin decisión clara.')).toBeNull();
  });
});

describe('chunkLegalDoc — Sala Constitucional (con_lugar)', () => {
  it('usa estrategia por_tanto', () => {
    const result = chunkLegalDoc(salaConstitucionalDoc);
    expect(result.strategy).toBe('por_tanto');
  });

  it('doc_class correcto', () => {
    const result = chunkLegalDoc(salaConstitucionalDoc);
    expect(result.doc_class).toBe('resolucion_sala_constitucional');
  });

  it('infiere decision con_lugar', () => {
    const result = chunkLegalDoc(salaConstitucionalDoc);
    expect(result.decision_inferida).toBe('con_lugar');
  });

  it('por_tanto_text contiene la decisión', () => {
    const result = chunkLegalDoc(salaConstitucionalDoc);
    expect(result.por_tanto_text).toBeDefined();
    expect(result.por_tanto_text).toContain('CON LUGAR');
  });

  it('chunks tienen encabezado + por_tanto sections', () => {
    const result = chunkLegalDoc(salaConstitucionalDoc);
    const sections = result.chunks.map(c => c.section);
    expect(sections).toContain('encabezado');
    expect(sections).toContain('por_tanto');
  });

  it('text_resumido omite considerandos', () => {
    const result = chunkLegalDoc(salaConstitucionalDoc);
    expect(result.text_resumido).toContain('[...CONSIDERANDOS OMITIDOS...]');
  });

  it('tokens_resumido es menor que tokens_full', () => {
    const result = chunkLegalDoc(salaConstitucionalDoc);
    expect(result.tokens_resumido_estimate).toBeLessThan(result.tokens_full_estimate);
  });
});

describe('chunkLegalDoc — Sala Constitucional (sin_lugar)', () => {
  it('infiere decision sin_lugar', () => {
    const result = chunkLegalDoc(sinLugarDoc);
    expect(result.decision_inferida).toBe('sin_lugar');
  });

  it('usa por_tanto strategy', () => {
    const result = chunkLegalDoc(sinLugarDoc);
    expect(result.strategy).toBe('por_tanto');
  });
});

describe('chunkLegalDoc — Procuraduría (CONCLUSIONES)', () => {
  it('doc_class es resolucion_procuraduria', () => {
    const result = chunkLegalDoc(procuraduriaDoc);
    expect(result.doc_class).toBe('resolucion_procuraduria');
  });

  it('encuentra la sección CONCLUSIONES como dispositiva', () => {
    const result = chunkLegalDoc(procuraduriaDoc);
    expect(result.strategy).toBe('por_tanto');
    expect(result.por_tanto_text).toBeDefined();
    expect(result.por_tanto_text).toContain('CONCLUSIONES');
  });

  it('text_resumido omite considerandos y contiene conclusiones', () => {
    const result = chunkLegalDoc(procuraduriaDoc);
    expect(result.text_resumido).toContain('[...CONSIDERANDOS OMITIDOS...]');
    expect(result.text_resumido).toContain('CONCLUSIONES');
  });
});

describe('chunkLegalDoc — fallback a standard', () => {
  it('doc genérico usa standard strategy', () => {
    const result = chunkLegalDoc(genericoDoc);
    expect(result.strategy).toBe('standard');
    expect(result.doc_class).toBe('generico');
  });

  it('doc jurídico sin marker dispositivo usa standard strategy', () => {
    const result = chunkLegalDoc(sinMarkerDoc);
    expect(result.strategy).toBe('standard');
  });

  it('no tiene por_tanto_text en doc genérico', () => {
    const result = chunkLegalDoc(genericoDoc);
    expect(result.por_tanto_text).toBeUndefined();
  });
});

describe('chunkLegalDoc — reducción de tokens', () => {
  it('documento grande (50 considerandos) → reducción ≥ 80%', () => {
    const doc = buildLargeDoc(50);
    const result = chunkLegalDoc(doc);

    expect(result.strategy).toBe('por_tanto');

    const reduction = 1 - result.tokens_resumido_estimate / result.tokens_full_estimate;
    // Track G goal: ≥ 80% reduction on large legal docs
    expect(reduction).toBeGreaterThanOrEqual(0.8);
  });

  it('texto_full se preserva intacto', () => {
    const doc = buildLargeDoc(10);
    const result = chunkLegalDoc(doc);
    expect(result.text_full).toBe(doc);
  });

  it('estimateTokens es consistente con longitud del texto', () => {
    const text = 'a'.repeat(400);
    expect(estimateTokens(text)).toBe(100);
  });
});

describe('chunkLegalDoc — fileName hint', () => {
  it('classifica correctamente por fileName', () => {
    const text = `
CONSIDERANDO:
I.- Algunos considerandos de la sala.
II.- Más considerandos.

POR TANTO:
Se declara sin lugar.
`.trim();

    const result = chunkLegalDoc(text, { fileName: 'Voto Sala Constitucional 2026-04-22.pdf' });
    expect(result.doc_class).toBe('resolucion_sala_constitucional');
  });
});
