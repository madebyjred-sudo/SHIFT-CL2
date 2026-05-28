/**
 * Tests para silEstadoNormalizer — categorización canonical del estado SIL.
 * Casos reales tomados del top-15 de distribución en prod 2026-05-26.
 */
import { describe, it, expect } from 'vitest';
import { normalizeSilEstado, categorizeSilEstado } from './silEstadoNormalizer.js';

describe('normalizeSilEstado — canonical estados', () => {
  it('"ARCHIVO" → archivo', () => {
    expect(normalizeSilEstado('ARCHIVO')).toBe('archivo');
  });

  it('"Archivado" → archivo (case insensitive)', () => {
    expect(normalizeSilEstado('Archivado')).toBe('archivo');
  });

  it('"archivo" lowercase → archivo', () => {
    expect(normalizeSilEstado('archivo')).toBe('archivo');
  });

  it('"PLENARIO" → plenario', () => {
    expect(normalizeSilEstado('PLENARIO')).toBe('plenario');
  });

  it('"Plenario" mixed case → plenario', () => {
    expect(normalizeSilEstado('Plenario')).toBe('plenario');
  });
});

describe('normalizeSilEstado — comisiones (casos reales prod)', () => {
  it('"MUNICIPALES (ÁREA VIII)" → en_comision', () => {
    expect(normalizeSilEstado('MUNICIPALES (ÁREA VIII)')).toBe('en_comision');
  });

  it('"JURIDICOS (ÁREA VII)" → en_comision', () => {
    expect(normalizeSilEstado('JURIDICOS (ÁREA VII)')).toBe('en_comision');
  });

  it('"SOCIALES (ÁREA II)" → en_comision', () => {
    expect(normalizeSilEstado('SOCIALES (ÁREA II)')).toBe('en_comision');
  });

  it('"GOBIERNO Y ADM. (ÁREA VIII)" → en_comision (con punto)', () => {
    expect(normalizeSilEstado('GOBIERNO Y ADM. (ÁREA VIII)')).toBe('en_comision');
  });

  it('"INTERNACIONALES (ÁREA I)" → en_comision', () => {
    expect(normalizeSilEstado('INTERNACIONALES (ÁREA I)')).toBe('en_comision');
  });

  it('"JUVENTUD (ÁREA II)" → en_comision (caso L9 audit — exp 24.642 PANI)', () => {
    expect(normalizeSilEstado('JUVENTUD (ÁREA II)')).toBe('en_comision');
  });

  it('"SEGURIDAD Y NARCOTR (ÁREA VII)" → en_comision', () => {
    expect(normalizeSilEstado('SEGURIDAD Y NARCOTR (ÁREA VII)')).toBe('en_comision');
  });

  it('"TECNOLOGIA Y EDUCAC (ÁREA V)" → en_comision (sin acentos)', () => {
    expect(normalizeSilEstado('TECNOLOGIA Y EDUCAC (ÁREA V)')).toBe('en_comision');
  });

  it('"AREA III" sin acento + sin paréntesis NO matchea', () => {
    // Conservador: no asumimos comisión sin el patrón completo.
    expect(normalizeSilEstado('AREA III')).toBe(null);
  });

  it('"(área iv)" lowercase también matchea', () => {
    expect(normalizeSilEstado('AMBIENTE (área IV)')).toBe('en_comision');
  });
});

describe('normalizeSilEstado — null / vacío / desconocido', () => {
  it('null', () => {
    expect(normalizeSilEstado(null)).toBe(null);
  });

  it('undefined', () => {
    expect(normalizeSilEstado(undefined)).toBe(null);
  });

  it('string vacío', () => {
    expect(normalizeSilEstado('')).toBe(null);
  });

  it('whitespace only', () => {
    expect(normalizeSilEstado('   ')).toBe(null);
  });

  it('valor desconocido sin patrón comisión → null (conservador)', () => {
    expect(normalizeSilEstado('texto random')).toBe(null);
  });

  it('"PENDIENTE" no es categoría canonical → null', () => {
    expect(normalizeSilEstado('PENDIENTE')).toBe(null);
  });
});

describe('categorizeSilEstado — devuelve estado + ubicacion_detalle', () => {
  it('archivo → estado=archivo, ubicacion_detalle=null', () => {
    expect(categorizeSilEstado('ARCHIVO')).toEqual({
      estado: 'archivo',
      ubicacion_detalle: null,
    });
  });

  it('plenario → estado=plenario, ubicacion_detalle=null', () => {
    expect(categorizeSilEstado('PLENARIO')).toEqual({
      estado: 'plenario',
      ubicacion_detalle: null,
    });
  });

  it('comisión → estado=en_comision, ubicacion_detalle=string original (preserva caso)', () => {
    expect(categorizeSilEstado('JUVENTUD (ÁREA II)')).toEqual({
      estado: 'en_comision',
      ubicacion_detalle: 'JUVENTUD (ÁREA II)',
    });
  });

  it('null → estado=null, ubicacion_detalle=null', () => {
    expect(categorizeSilEstado(null)).toEqual({
      estado: null,
      ubicacion_detalle: null,
    });
  });
});
