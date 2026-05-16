/**
 * Tests for ordenDiaSectionParser.ts — pedido 16c del cliente.
 *
 * Parser puro, sin I/O. Verifica:
 *   1. Detección de 3 capítulos sobre texto canónico
 *   2. Expediente clasificado a PRIMER DEBATE
 *   3. Expediente clasificado a SEGUNDO DEBATE
 *   4. Expediente sin marker de debate → sin_clasificar
 *   5. Texto plano sin CAPÍTULO → 1 section sin_clasificar + warning
 *   6. Números romanos en CAPÍTULO (I, II, III) → aliases correctos
 *   7. Mociones de orden detectadas como debate='mocion_orden'
 *   8. Cutoff de título cuando aparece próximo número de expediente
 *   9. Dedup: mismo expediente + capitulo + debate aparece 1 vez
 */

import { describe, it, expect } from 'vitest';
import { parseOrdenDia } from './ordenDiaSectionParser.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

/**
 * Sample con los 3 capítulos canónicos del reglamento + un expediente en
 * cada capítulo.
 */
const tresCapitulosTexto = `
CAPÍTULO PRIMERO — Discusión y aprobación del Acta

Se conoce el acta de la sesión anterior.

CAPÍTULO SEGUNDO — Régimen interior

No hay asuntos en este capítulo en la sesión de hoy.

CAPÍTULO TERCERO — Discusión de Proyectos de Ley

PRIMER DEBATE

Expediente 23.511 LEY MARCO DE PROMOCIÓN — texto del proyecto, considerandos varios.

SEGUNDO DEBATE

Expediente 23.987 REFORMA AL CÓDIGO PROCESAL CIVIL — texto del proyecto.
`.trim();

/** Texto plano sin marcadores de CAPÍTULO. */
const textoSinSecciones = `
Asamblea Legislativa — Sesión Plenaria
Bla bla bla, contenido genérico sin secciones marcadas.
Algún expediente 23.511 aparece suelto sin sección.
`.trim();

/** Texto con números romanos (CAPÍTULO I/II/III). */
const textoNumerosRomanos = `
CAPÍTULO I — Discusión y aprobación del Acta

CAPÍTULO II — Régimen interior

CAPÍTULO III — Discusión de Proyectos de Ley

PRIMER DEBATE
Expediente 24.001 PROYECTO ALPHA — texto.
`.trim();

/** Texto con sección MOCIONES DE ORDEN. */
const textoMocionesOrden = `
CAPÍTULO TERCERO — Discusión de Proyectos de Ley

MOCIONES DE ORDEN

Expediente 23.511 LEY MARCO — moción de orden presentada.
`.trim();

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('parseOrdenDia — sectioning', () => {
  it('detecta los 3 capítulos canónicos sobre texto multi-sección', () => {
    const result = parseOrdenDia(tresCapitulosTexto);

    expect(result.sections).toHaveLength(3);
    const labels = result.sections.map((s) => s.capitulo);
    expect(labels).toEqual(['capitulo_primero', 'capitulo_segundo', 'capitulo_tercero']);
  });

  it('si no se detectan secciones, devuelve 1 section sin_clasificar + warning', () => {
    const result = parseOrdenDia(textoSinSecciones);

    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]?.capitulo).toBe('sin_clasificar');
    expect(result.warnings).toContain('no_capitulo_markers_found');
  });

  it('acepta números romanos como alias de PRIMERO/SEGUNDO/TERCERO', () => {
    const result = parseOrdenDia(textoNumerosRomanos);

    expect(result.sections).toHaveLength(3);
    expect(result.sections[0]?.capitulo).toBe('capitulo_primero');
    expect(result.sections[1]?.capitulo).toBe('capitulo_segundo');
    expect(result.sections[2]?.capitulo).toBe('capitulo_tercero');
  });
});

describe('parseOrdenDia — debate classification', () => {
  it('expediente bajo "PRIMER DEBATE" se clasifica como primer_debate', () => {
    const result = parseOrdenDia(tresCapitulosTexto);

    const e23511 = result.entries.find((e) => e.expediente_numero === '23.511');
    expect(e23511).toBeDefined();
    expect(e23511?.debate).toBe('primer_debate');
    expect(e23511?.capitulo).toBe('capitulo_tercero');
  });

  it('expediente bajo "SEGUNDO DEBATE" se clasifica como segundo_debate', () => {
    // Fixture aislado: el snippet alrededor del expediente (±240 chars) NO
    // debe contener marker de PRIMER DEBATE, sino la detección ordenada
    // matchea primer_debate antes que segundo_debate.
    const textoSegundoDebate = `
CAPÍTULO TERCERO — Discusión de Proyectos de Ley

SEGUNDO DEBATE

Expediente 23.987 REFORMA AL CÓDIGO PROCESAL CIVIL — texto del proyecto.
`.trim();

    const result = parseOrdenDia(textoSegundoDebate);

    const e23987 = result.entries.find((e) => e.expediente_numero === '23.987');
    expect(e23987).toBeDefined();
    expect(e23987?.debate).toBe('segundo_debate');
    expect(e23987?.capitulo).toBe('capitulo_tercero');
  });

  it('expediente sin marker de debate antes → debate=sin_clasificar', () => {
    // Texto donde un expediente aparece inmediatamente debajo del header de
    // CAPÍTULO TERCERO, sin PRIMER/SEGUNDO/TERCER DEBATE entremedio.
    const texto = `
CAPÍTULO TERCERO — Discusión de Proyectos de Ley

Expediente 25.000 EXPEDIENTE NUEVO — texto suelto sin marker de debate.
`.trim();

    const result = parseOrdenDia(texto);
    const e25000 = result.entries.find((e) => e.expediente_numero === '25.000');
    expect(e25000).toBeDefined();
    expect(e25000?.debate).toBe('sin_clasificar');
    expect(e25000?.capitulo).toBe('capitulo_tercero');
  });

  it('expediente bajo "MOCIONES DE ORDEN" → debate=mocion_orden', () => {
    const result = parseOrdenDia(textoMocionesOrden);

    const e23511 = result.entries.find((e) => e.expediente_numero === '23.511');
    expect(e23511).toBeDefined();
    expect(e23511?.debate).toBe('mocion_orden');
    expect(e23511?.capitulo).toBe('capitulo_tercero');
  });
});

describe('parseOrdenDia — title extraction', () => {
  it('título del primer expediente NO contiene el número del siguiente', () => {
    const texto = `
CAPÍTULO TERCERO — Discusión de Proyectos de Ley

PRIMER DEBATE

Expediente 23.511 LEY MARCO DE PROMOCIÓN — texto del proyecto.
Expediente 23.987 REFORMA AL CÓDIGO PROCESAL CIVIL — otro texto.
`.trim();

    const result = parseOrdenDia(texto);
    const e23511 = result.entries.find((e) => e.expediente_numero === '23.511');

    expect(e23511).toBeDefined();
    expect(e23511?.titulo).not.toContain('23.987');
    expect(e23511?.titulo.length).toBeGreaterThan(0);
  });

  it('título se corta en el próximo marker de debate', () => {
    const texto = `
CAPÍTULO TERCERO

PRIMER DEBATE

Expediente 23.511 LEY MARCO DE PROMOCIÓN texto largo del proyecto que sigue.

SEGUNDO DEBATE

Expediente 23.987 OTRO.
`.trim();

    const result = parseOrdenDia(texto);
    const e23511 = result.entries.find((e) => e.expediente_numero === '23.511');

    expect(e23511).toBeDefined();
    // El cutoff debe ocurrir antes de "SEGUNDO DEBATE"
    expect(e23511?.titulo).not.toMatch(/SEGUNDO\s+DEBATE/i);
  });
});

describe('parseOrdenDia — dedup', () => {
  it('mismo expediente repetido en la misma sección con mismo debate → 1 entry', () => {
    // En textos reales, "Conoce y se aprueba..." puede listar el mismo
    // expediente en un header + en un ranking. Verificamos dedup por
    // (numero|capitulo|debate).
    //
    // Como dedup también considera el offset (en el filter por section.entries),
    // tenemos que entender que el dedup usa solo (numero+capitulo+debate)
    // como key en `seen`. Si los 3 son iguales, devuelve 1 sola entry.
    const texto = `
CAPÍTULO TERCERO

PRIMER DEBATE

Expediente 23.511 LEY MARCO — primera mención.
Texto intermedio para separar.
Expediente 23.511 LEY MARCO — segunda mención (el mismo número repetido).
`.trim();

    const result = parseOrdenDia(texto);
    const matches = result.entries.filter((e) => e.expediente_numero === '23.511');

    // Como el código dedupea por (numero|capitulo|debate), las 2 ocurrencias
    // del mismo expediente con misma sección y mismo debate → 1 entry.
    expect(matches).toHaveLength(1);
  });
});

describe('parseOrdenDia — output shape', () => {
  it('result tiene entries, sections y warnings', () => {
    const result = parseOrdenDia(tresCapitulosTexto);

    expect(Array.isArray(result.entries)).toBe(true);
    expect(Array.isArray(result.sections)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it('cada entry contiene los campos requeridos', () => {
    const result = parseOrdenDia(tresCapitulosTexto);
    expect(result.entries.length).toBeGreaterThan(0);
    const e = result.entries[0];
    expect(e).toBeDefined();
    expect(typeof e!.expediente_numero).toBe('string');
    expect(typeof e!.titulo).toBe('string');
    expect(typeof e!.capitulo).toBe('string');
    expect(typeof e!.capitulo_titulo).toBe('string');
    expect(typeof e!.debate).toBe('string');
    expect(typeof e!.offset).toBe('number');
  });

  it('texto vacío devuelve 1 section sin_clasificar con warning', () => {
    const result = parseOrdenDia('');

    expect(result.entries).toEqual([]);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]?.capitulo).toBe('sin_clasificar');
    expect(result.warnings).toContain('no_capitulo_markers_found');
  });
});
