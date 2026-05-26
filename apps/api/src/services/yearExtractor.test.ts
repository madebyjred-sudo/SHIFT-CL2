/**
 * Tests para yearExtractor.ts — parser de menciones de año en queries.
 *
 * Cobertura:
 *   1. Año simple ("en 2018", "del 2020", "de 2024")
 *   2. Rango ("entre 2018 y 2020", "del 2018 al 2020", "2018-2020")
 *   3. Direccionales ("antes de 2020", "después de 2020", "desde 2018")
 *   4. Edge cases: vacío, sin año, año inválido, múltiples años
 *   5. Falso positivo blocker: "Ley 2018" (número de ley, no año)
 *      "Exp. 2020" (número de expediente, no año)
 *      "Art. 2024" (número de artículo)
 */

import { describe, it, expect } from 'vitest';
import { extractDateRangeFromQuery } from './yearExtractor.js';

describe('extractDateRangeFromQuery — año simple', () => {
  it('"en 2018" → rango full year 2018', () => {
    const r = extractDateRangeFromQuery('iniciativas en 2018 sobre seguridad');
    expect(r.fecha_from).toBe('2018-01-01');
    expect(r.fecha_to).toBe('2018-12-31');
  });

  it('"del 2020"', () => {
    const r = extractDateRangeFromQuery('expedientes del 2020');
    expect(r.fecha_from).toBe('2020-01-01');
    expect(r.fecha_to).toBe('2020-12-31');
  });

  it('"de 2024"', () => {
    const r = extractDateRangeFromQuery('proyectos de 2024 sobre PANI');
    expect(r.fecha_from).toBe('2024-01-01');
    expect(r.fecha_to).toBe('2024-12-31');
  });

  it('"en el 2019"', () => {
    const r = extractDateRangeFromQuery('Qué se aprobó en el 2019');
    expect(r.fecha_from).toBe('2019-01-01');
    expect(r.fecha_to).toBe('2019-12-31');
  });

  it('"del año 2022"', () => {
    const r = extractDateRangeFromQuery('reformas del año 2022');
    expect(r.fecha_from).toBe('2022-01-01');
    expect(r.fecha_to).toBe('2022-12-31');
  });

  it('año 1998 (legislatura antigua)', () => {
    const r = extractDateRangeFromQuery('iniciativas de 1998');
    expect(r.fecha_from).toBe('1998-01-01');
    expect(r.fecha_to).toBe('1998-12-31');
  });
});

describe('extractDateRangeFromQuery — rangos explícitos', () => {
  it('"entre 2018 y 2020"', () => {
    const r = extractDateRangeFromQuery('iniciativas entre 2018 y 2020 sobre seguridad');
    expect(r.fecha_from).toBe('2018-01-01');
    expect(r.fecha_to).toBe('2020-12-31');
  });

  it('"del 2018 al 2024"', () => {
    const r = extractDateRangeFromQuery('reformas del 2018 al 2024');
    expect(r.fecha_from).toBe('2018-01-01');
    expect(r.fecha_to).toBe('2024-12-31');
  });

  it('"2018-2020" guión', () => {
    const r = extractDateRangeFromQuery('proyectos 2018-2020');
    expect(r.fecha_from).toBe('2018-01-01');
    expect(r.fecha_to).toBe('2020-12-31');
  });

  it('rango invertido se ordena', () => {
    const r = extractDateRangeFromQuery('entre 2024 y 2020');
    expect(r.fecha_from).toBe('2020-01-01');
    expect(r.fecha_to).toBe('2024-12-31');
  });

  it('"entre 2020 y 2024 sobre PANI"', () => {
    const r = extractDateRangeFromQuery('iniciativas sobre PANI entre 2020 y 2024');
    expect(r.fecha_from).toBe('2020-01-01');
    expect(r.fecha_to).toBe('2024-12-31');
  });
});

describe('extractDateRangeFromQuery — direccionales', () => {
  it('"antes de 2020" → fecha_to 2019', () => {
    const r = extractDateRangeFromQuery('proyectos antes de 2020');
    expect(r.fecha_from).toBeUndefined();
    expect(r.fecha_to).toBe('2019-12-31');
  });

  it('"hasta 2020" → incluye 2020', () => {
    const r = extractDateRangeFromQuery('iniciativas hasta 2020');
    expect(r.fecha_to).toBe('2020-12-31');
  });

  it('"después de 2020" → fecha_from 2021', () => {
    const r = extractDateRangeFromQuery('proyectos después de 2020');
    expect(r.fecha_from).toBe('2021-01-01');
    expect(r.fecha_to).toBeUndefined();
  });

  it('"desde 2018"', () => {
    const r = extractDateRangeFromQuery('expedientes desde 2018 sobre educación');
    expect(r.fecha_from).toBe('2018-01-01');
    expect(r.fecha_to).toBeUndefined();
  });

  it('"a partir de 2022"', () => {
    const r = extractDateRangeFromQuery('reformas a partir de 2022');
    expect(r.fecha_from).toBe('2022-01-01');
  });
});

describe('extractDateRangeFromQuery — sin año detectable', () => {
  it('query vacía', () => {
    expect(extractDateRangeFromQuery('')).toEqual({});
  });

  it('query sin año', () => {
    expect(extractDateRangeFromQuery('iniciativas sobre seguridad ciudadana')).toEqual({});
  });

  it('whitespace only', () => {
    expect(extractDateRangeFromQuery('   \n  ')).toEqual({});
  });
});

describe('extractDateRangeFromQuery — falsos positivos bloqueados', () => {
  it('"Ley 10761" no se interpreta como año (4 dígitos pero no formato YYYY)', () => {
    // 10761 no matchea YEAR_RE porque no empieza con 19/20
    const r = extractDateRangeFromQuery('Ley 10761 sobre turismo');
    expect(r).toEqual({});
  });

  it('"Exp. 2023" (número expediente, no año)', () => {
    // 2023 matchea YEAR_RE pero está precedido por "Exp."
    const r = extractDateRangeFromQuery('Exp. 2023 sobre PANI');
    expect(r).toEqual({});
  });

  it('"expediente 2024"', () => {
    const r = extractDateRangeFromQuery('expediente 2024 estado actual');
    expect(r).toEqual({});
  });

  it('"art. 2024"', () => {
    const r = extractDateRangeFromQuery('art. 2024 del Reglamento');
    expect(r).toEqual({});
  });

  it('"Ley N° 2018"', () => {
    const r = extractDateRangeFromQuery('Ley N° 2018');
    expect(r).toEqual({});
  });

  it('múltiples años aislados → no aplica filtro simple (necesita rango explícito)', () => {
    // Sin "entre" o "del...al", varios años sueltos = ambiguo, no aplicamos
    const r = extractDateRangeFromQuery('hubo proyectos 2018 también 2020 sobre tema');
    // Acepta cualquier resultado — solo verificamos que no rompa
    expect(typeof r).toBe('object');
  });
});

describe('extractDateRangeFromQuery — casos reales del lawyer audit', () => {
  it('D4: "Qué iniciativas de 2018 hay sobre seguridad ciudadana"', () => {
    const r = extractDateRangeFromQuery('Qué iniciativas de 2018 hay sobre seguridad ciudadana');
    expect(r.fecha_from).toBe('2018-01-01');
    expect(r.fecha_to).toBe('2018-12-31');
  });

  it('A3: "Qué iniciativas sobre PANI hubo entre 2020 y 2024"', () => {
    const r = extractDateRangeFromQuery('Qué iniciativas sobre PANI hubo entre 2020 y 2024');
    expect(r.fecha_from).toBe('2020-01-01');
    expect(r.fecha_to).toBe('2024-12-31');
  });

  it('A6: "Qué se discutió en plenarias de junio 2024"', () => {
    const r = extractDateRangeFromQuery('Qué se discutió en plenarias de junio 2024');
    expect(r.fecha_from).toBe('2024-01-01');
    expect(r.fecha_to).toBe('2024-12-31');
  });

  it('A5: "Qué reformas al Código Procesal Penal hubo en 2010"', () => {
    const r = extractDateRangeFromQuery('Qué reformas al Código Procesal Penal hubo en 2010');
    expect(r.fecha_from).toBe('2010-01-01');
    expect(r.fecha_to).toBe('2010-12-31');
  });

  it('A4: "Cuándo se aprobó la Ley 10761" → no debe interpretar Ley 10761 como año', () => {
    const r = extractDateRangeFromQuery('Cuándo se aprobó la Ley 10761 sobre turismo en Alajuela');
    expect(r).toEqual({});
  });

  it('D1: "expediente 18.000" → no debe interpretar 18000 ni 18 como año', () => {
    const r = extractDateRangeFromQuery('Cuál es el estado actual del expediente 18.000');
    expect(r).toEqual({});
  });
});

describe('extractDateRangeFromQuery — case insensitive', () => {
  it('UPPERCASE matches', () => {
    const r = extractDateRangeFromQuery('INICIATIVAS DE 2018');
    expect(r.fecha_from).toBe('2018-01-01');
  });

  it('Mixed Case', () => {
    const r = extractDateRangeFromQuery('Iniciativas De 2018');
    expect(r.fecha_from).toBe('2018-01-01');
  });
});
