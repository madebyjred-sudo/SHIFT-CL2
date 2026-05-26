/**
 * Tests para ingestConstitucionLoal — Wave 4 #2.
 *
 * Cubre solo la función pura `parseArticles`. El orchestrator
 * `runIngestConstitucionLoal` se prueba con --dry / --probe vía CLI
 * (apps/api/scripts/ingest-constitucion-loal.ts) porque depende de Vertex
 * y Supabase con creds reales — no agrega valor mockear toda esa
 * superficie cuando el script tiene una modalidad dry-run nativa.
 *
 * Si en el futuro queremos cubrir el insert path con mocks, replicar el
 * patrón de listaDespachoMatcher.test.ts (mock supabase chain captor).
 */

import { describe, it, expect } from 'vitest';
import { parseArticles } from './ingestConstitucionLoal.js';

// ─── Fixtures (texto verbatim de fuentes oficiales) ──────────────────────────

// Snippet real del PDF TSE de la Constitución — incluye TÍTULO, Capítulo,
// nota de reforma. Validamos que el parser no mete la nota como artículo
// nuevo y que captura el titulo_seccion del artículo 1.
const CONSTITUCION_SNIPPET = `
                                       TÍTULO I
                                   LA REPÚBLICA


                                    Capítulo Único


Artículo 1- Costa Rica es una República democrática, libre, independiente,
multiétnica y pluricultural.
Nota: Reformado el artículo 1 por la Ley n.° 9305 del 24 de agosto de 2015.



Artículo 2- La soberanía reside exclusivamente en la Nación.


Artículo 3- Nadie puede arrogarse la soberanía; el que lo hiciere cometerá
el delito de traición a la Patria.
`.trim();

// Snippet inventado pero con la forma estructural del LOAL (RAL convention:
// "Artículo N.-"). El parser tiene que matchear ambos formatos.
const LOAL_SNIPPET = `
Capítulo I - Disposiciones generales

Artículo 1.- La Asamblea Legislativa es el órgano supremo del Poder Legislativo
de la República.

Artículo 2.- Los diputados juramentarán su cargo ante el Presidente de la
Asamblea en sesión solemne.

Capítulo II - De las sesiones

Artículo 11.- Las sesiones ordinarias se celebrarán durante los períodos que
establece la Constitución.
`.trim();

// Snippet para el caso de "Artículo 121 inciso 4" — el numerador es solo
// el artículo, los incisos van en el body. Validamos que el parser NO
// confunde el inciso con otro artículo.
const CONSTITUCION_ART_121 = `
Artículo 121.- Además de las otras atribuciones que le confiere esta
Constitución, corresponden exclusivamente a la Asamblea Legislativa las
siguientes:

1) Dictar las leyes, reformarlas, derogarlas, y darles interpretación
auténtica, salvo lo dicho en el capítulo referente al Tribunal Supremo
de Elecciones.

4) Aprobar o improbar los convenios internacionales, tratados públicos y
concordatos.

Artículo 122.- Es prohibido a la Asamblea dar votos de aplauso.
`.trim();

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('parseArticles — Constitución', () => {
  it('captura 3 artículos del snippet de TÍTULO I', () => {
    const arts = parseArticles(CONSTITUCION_SNIPPET);
    expect(arts.length).toBe(3);
    expect(arts.map((a) => a.articulo_numero_int)).toEqual([1, 2, 3]);
  });

  it('preserva el header normalizado "Artículo N.-"', () => {
    const arts = parseArticles(CONSTITUCION_SNIPPET);
    expect(arts[0].articulo_header).toBe('Artículo 1.-');
    expect(arts[1].articulo_header).toBe('Artículo 2.-');
  });

  it('captura titulo_seccion del bloque arriba del artículo', () => {
    const arts = parseArticles(CONSTITUCION_SNIPPET);
    // El último encabezado arriba del Art. 1 es "Capítulo Único" (más
    // cercano que "TÍTULO I"). El comportamiento aceptado es: la sección
    // más reciente arriba.
    expect(arts[0].titulo_seccion).toBe('Capítulo Único');
  });

  it('incluye la nota de reforma como parte del artículo 1', () => {
    const arts = parseArticles(CONSTITUCION_SNIPPET);
    expect(arts[0].content).toContain('Nota: Reformado el artículo 1');
  });

  it('no inventa un artículo nuevo en la "Nota:"', () => {
    const arts = parseArticles(CONSTITUCION_SNIPPET);
    // Solo 3 artículos reales, ninguno con número "Nota" ni otro extra.
    expect(arts.every((a) => Number.isInteger(a.articulo_numero_int))).toBe(true);
    expect(arts.length).toBe(3);
  });

  it('Art. 121 con incisos numerados no se rompe en sub-artículos', () => {
    const arts = parseArticles(CONSTITUCION_ART_121);
    // 121 + 122 = 2 artículos. Los incisos "1)", "4)" NO son headers
    // porque el regex de header exige "Artículo" o "Art." al inicio.
    expect(arts.length).toBe(2);
    expect(arts[0].articulo_numero_int).toBe(121);
    expect(arts[1].articulo_numero_int).toBe(122);
    // El inciso 4 (tratados internacionales) tiene que estar dentro del
    // body del art. 121 — eso es lo que Lexa cita cuando responde sobre
    // tratados.
    expect(arts[0].content).toContain('convenios internacionales');
    expect(arts[0].content).toContain('tratados públicos');
  });
});

describe('parseArticles — LOAL (formato "Artículo N.-")', () => {
  it('captura los 3 artículos del snippet LOAL', () => {
    const arts = parseArticles(LOAL_SNIPPET);
    expect(arts.length).toBe(3);
    expect(arts.map((a) => a.articulo_numero_int)).toEqual([1, 2, 11]);
  });

  it('asigna la sección más reciente arriba', () => {
    const arts = parseArticles(LOAL_SNIPPET);
    // Arts. 1 y 2 → "Capítulo I". Art. 11 → "Capítulo II".
    expect(arts[0].titulo_seccion).toMatch(/Capítulo I/);
    expect(arts[2].titulo_seccion).toMatch(/Capítulo II/);
  });

  it('el content incluye el cuerpo completo del artículo', () => {
    const arts = parseArticles(LOAL_SNIPPET);
    expect(arts[1].content).toContain('juramentarán');
    expect(arts[1].content).toContain('sesión solemne');
  });
});

describe('parseArticles — robustez', () => {
  it('texto vacío devuelve array vacío', () => {
    expect(parseArticles('')).toEqual([]);
  });

  it('texto sin headers devuelve array vacío', () => {
    const t = 'Esto es un párrafo normal sin estructura legal.';
    expect(parseArticles(t)).toEqual([]);
  });

  it('acepta variante en mayúsculas "ARTÍCULO 5.-"', () => {
    const t = 'ARTÍCULO 5.- Esto es un artículo en mayúsculas.';
    const arts = parseArticles(t);
    expect(arts.length).toBe(1);
    expect(arts[0].articulo_numero_int).toBe(5);
  });

  it('acepta abreviatura "Art. 10."', () => {
    const t = 'Art. 10. Texto del artículo 10.';
    const arts = parseArticles(t);
    expect(arts.length).toBe(1);
    expect(arts[0].articulo_numero_int).toBe(10);
  });

  it('NO matchea "artículo N" lowercase a mitad de párrafo', () => {
    // Bug real visto en el PDF TSE de la Constitución entre Art. 48 y 49:
    // wrap del párrafo dejó "artículo 10." en línea propia (continuación
    // de "...la Sala indicada en el / artículo 10."). El parser viejo,
    // con flag /i, lo tomaba como header y duplicaba Art. 10. Con la
    // forma actual (sin /i, A mayúscula obligatoria) ese caso desaparece.
    const t = [
      'Artículo 48.- Toda persona tiene derecho al recurso de hábeas corpus',
      'para garantizar su libertad e integridad personales, y al recurso',
      'de amparo. Ambos recursos serán de competencia de la Sala indicada en el',
      'artículo 10.',
      'Nota: Reformado el artículo 48 por la Ley N.° 7128.',
      '',
      'Artículo 49.- Establécese la jurisdicción contencioso-administrativa.',
    ].join('\n');
    const arts = parseArticles(t);
    expect(arts.length).toBe(2);
    expect(arts.map((a) => a.articulo_numero_int)).toEqual([48, 49]);
    // El cuerpo del art. 48 incluye la frase "artículo 10." sin partirlo.
    expect(arts[0].content).toContain('artículo 10.');
  });

  it('limpia footer repetido del PDF TSE', () => {
    const t = `
Artículo 1- Primera línea del artículo.

                      ________________________________________________________
                             CONSTITUCIÓN POLÍTICA DE LA REPÚBLICA DE COSTA RICA
                                     Tribunal Supremo de Elecciones
                                              www.tse.go.cr

Artículo 2- Segunda línea del artículo.
    `.trim();
    const arts = parseArticles(t);
    expect(arts.length).toBe(2);
    // El cleanup quita las líneas de footer del cuerpo del Art. 1.
    expect(arts[0].content).not.toContain('Tribunal Supremo de Elecciones');
    expect(arts[0].content).not.toContain('www.tse.go.cr');
    expect(arts[0].content).toContain('Primera línea del artículo');
  });
});
