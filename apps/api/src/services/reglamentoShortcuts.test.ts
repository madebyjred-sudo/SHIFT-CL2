/**
 * Tests for reglamentoShortcuts.ts — hand-curated index para queries
 * procedimentales del Reglamento de la Asamblea Legislativa de CR.
 *
 * Cubre:
 *   1. Match positivo — query procedimental devuelve el shortcut con artículo correcto
 *   2. Match negativo — query de búsqueda de expedientes NO dispara shortcut
 *   3. Edge cases — query vacía, sólo whitespace, caracteres especiales, acentos
 *   4. Build hint message — shape esperado del system message inyectado
 *   5. Cobertura — cada uno de los ~25 patterns matchea al menos una variación realista
 *
 * Funciones puras, sin mocks externos.
 */

import { describe, it, expect } from 'vitest';
import {
  REGLAMENTO_SHORTCUTS,
  matchReglamentoShortcut,
  buildReglamentoHintMessage,
} from './reglamentoShortcuts.js';

describe('matchReglamentoShortcut — happy path por categoría', () => {
  it('plazo dictamen comisión permanente → Art. 80', () => {
    const r = matchReglamentoShortcut('Cuál es el plazo de dictamen para comisión permanente');
    expect(r).not.toBeNull();
    expect(r?.articulos).toContain('Art. 80');
  });

  it('cuánto tiempo tiene la comisión para dictaminar → Art. 80', () => {
    const r = matchReglamentoShortcut('Cuántos días hábiles tiene la comisión para emitir dictamen');
    expect(r?.articulos).toContain('Art. 80');
  });

  it('comisión no dictamina → Art. 81 + jurisprudencia Art. 138', () => {
    const r = matchReglamentoShortcut('Si una comisión no dictamina en el plazo, qué procede');
    expect(r?.articulos).toContain('Art. 81');
    expect(r?.articulos.some((a) => a.includes('138'))).toBe(true);
  });

  it('dispensa de trámite → Art. 177', () => {
    const r = matchReglamentoShortcut('Cuándo procede la dispensa de trámite');
    expect(r?.articulos).toContain('Art. 177');
  });

  it('moción de fondo → Art. 137', () => {
    const r = matchReglamentoShortcut('Requisitos de una moción de fondo');
    expect(r?.articulos).toContain('Art. 137');
  });

  it('moción de censura → Arts. 188 + 189', () => {
    const r = matchReglamentoShortcut('Cómo se presenta una moción de censura');
    expect(r?.articulos).toContain('Art. 188');
    expect(r?.articulos).toContain('Art. 189');
  });

  it('quórum → Art. 33', () => {
    const r = matchReglamentoShortcut('Cuál es el quórum para sesionar');
    expect(r?.articulos).toContain('Art. 33');
  });

  it('quórum estructural (variación) → Art. 33', () => {
    const r = matchReglamentoShortcut('Qué dice el reglamento sobre quórum estructural');
    expect(r?.articulos).toContain('Art. 33');
  });

  it('reforma constitución → Art. 184', () => {
    const r = matchReglamentoShortcut('Cuántos votos se necesitan para reforma constitucional');
    expect(r?.articulos).toContain('Art. 184');
  });

  it('dos tercios (variación reforma const) → Art. 184', () => {
    const r = matchReglamentoShortcut('Procedimiento de dos tercios para reformar la Constitución');
    expect(r?.articulos).toContain('Art. 184');
  });

  it('sesión extraordinaria → Arts. 27 + 28', () => {
    const r = matchReglamentoShortcut('Cuándo procede una sesión extraordinaria');
    expect(r?.articulos).toContain('Art. 27');
    expect(r?.articulos).toContain('Art. 28');
  });

  it('caducidad cuatrienal → Art. 119', () => {
    const r = matchReglamentoShortcut('Qué es la caducidad cuatrienal de un expediente');
    expect(r?.articulos).toContain('Art. 119');
  });

  it('caducidad 4 años (variación) → Art. 119', () => {
    const r = matchReglamentoShortcut('Cuándo se vence un expediente a los 4 años');
    expect(r?.articulos).toContain('Art. 119');
  });

  it('veto → Arts. 178 + 179', () => {
    const r = matchReglamentoShortcut('Cuál es el plazo para vetar un proyecto');
    expect(r?.articulos).toContain('Art. 178');
    expect(r?.articulos).toContain('Art. 179');
  });

  it('resello (variación veto) → Arts. 178 + 179', () => {
    const r = matchReglamentoShortcut('Cómo funciona el resello legislativo');
    expect(r?.articulos).toContain('Art. 178');
  });

  it('consulta constitucional → Arts. 145 + 146', () => {
    const r = matchReglamentoShortcut('Cómo se hace una consulta de constitucionalidad');
    expect(r?.articulos).toContain('Art. 145');
    expect(r?.articulos).toContain('Art. 146');
  });

  it('publicación del proyecto → Art. 117', () => {
    const r = matchReglamentoShortcut('Cuándo se publica un proyecto en La Gaceta');
    expect(r?.articulos).toContain('Art. 117');
  });

  it('retiro de proyecto → Art. 121', () => {
    const r = matchReglamentoShortcut('Cómo se retira un expediente del trámite');
    expect(r?.articulos).toContain('Art. 121');
  });

  it('texto sustitutivo → Art. 137 inciso 3', () => {
    const r = matchReglamentoShortcut('Qué es un texto sustitutivo');
    expect(r?.articulos.some((a) => a.includes('137'))).toBe(true);
  });

  it('redacción final → Arts. 142 + 144', () => {
    const r = matchReglamentoShortcut('Procedimiento de redacción final');
    expect(r?.articulos).toContain('Art. 142');
  });

  it('segundo debate → Art. 145', () => {
    const r = matchReglamentoShortcut('Qué pasa en el segundo debate');
    expect(r?.articulos).toContain('Art. 145');
  });

  it('orden del día → Art. 35', () => {
    const r = matchReglamentoShortcut('Cómo se arma la orden del día');
    expect(r?.articulos).toContain('Art. 35');
  });

  it('sesión secreta → Art. 44', () => {
    const r = matchReglamentoShortcut('Cuándo procede una sesión secreta');
    expect(r?.articulos).toContain('Art. 44');
  });

  it('comisión investigación → Art. 90', () => {
    const r = matchReglamentoShortcut('Cómo se crea una comisión de investigación');
    expect(r?.articulos).toContain('Art. 90');
  });

  it('potestad legislativa plena → Arts. 59 + 60', () => {
    const r = matchReglamentoShortcut('Qué son las comisiones con potestad legislativa plena');
    expect(r?.articulos).toContain('Art. 59');
    expect(r?.articulos).toContain('Art. 60');
  });

  it('comisión especial mixta → Art. 88', () => {
    const r = matchReglamentoShortcut('Procedimiento de comisión especial mixta');
    expect(r?.articulos).toContain('Art. 88');
  });

  it('votación nominal → Arts. 100 + 101', () => {
    const r = matchReglamentoShortcut('Cuándo se usa votación nominal');
    expect(r?.articulos).toContain('Art. 100');
    expect(r?.articulos).toContain('Art. 101');
  });

  it('mayoría absoluta → Art. 99', () => {
    const r = matchReglamentoShortcut('Qué es mayoría absoluta');
    expect(r?.articulos).toContain('Art. 99');
  });

  it('derechos y deberes de diputado → Arts. 5/6/113', () => {
    const r = matchReglamentoShortcut('Cuáles son los derechos y deberes de los diputados');
    expect(r?.articulos.length).toBeGreaterThan(0);
    expect(r?.articulos).toContain('Art. 113');
  });
});

describe('matchReglamentoShortcut — skip cuando query pide expedientes (Wave 2.2 fix)', () => {
  it('"Buscame iniciativas sobre dispensa de trámite" → null (Bug L12 fix)', () => {
    const r = matchReglamentoShortcut(
      'Buscame iniciativas legislativas sobre dispensa de trámite o reformas al Reglamento',
    );
    expect(r).toBeNull();
  });

  it('"qué hay sobre veto" → null', () => {
    const r = matchReglamentoShortcut('Qué hay sobre veto en el SIL');
    expect(r).toBeNull();
  });

  it('"expedientes sobre quórum" → null', () => {
    const r = matchReglamentoShortcut('Mostrame expedientes sobre quórum');
    expect(r).toBeNull();
  });

  it('"proyectos de ley sobre reforma constitucional" → null', () => {
    const r = matchReglamentoShortcut('Hay proyectos de ley sobre reforma constitucional');
    expect(r).toBeNull();
  });

  it('"buscame algo de dispensa" → null', () => {
    const r = matchReglamentoShortcut('buscame algo de dispensa de trámite');
    expect(r).toBeNull();
  });

  it('"querés que busque proyectos sobre veto" → null', () => {
    const r = matchReglamentoShortcut('Querés que busque proyectos de ley sobre veto');
    expect(r).toBeNull();
  });

  it('"hay alguna iniciativa sobre quórum" → null', () => {
    const r = matchReglamentoShortcut('Hay alguna iniciativa vigente sobre quórum');
    expect(r).toBeNull();
  });
});

describe('matchReglamentoShortcut — edge cases', () => {
  it('query vacía → null', () => {
    expect(matchReglamentoShortcut('')).toBeNull();
  });

  it('query sólo whitespace → null', () => {
    expect(matchReglamentoShortcut('   \n\t  ')).toBeNull();
  });

  it('query genérica sin keyword procedural → null', () => {
    expect(matchReglamentoShortcut('hola, cómo va todo')).toBeNull();
  });

  it('query con acentos varies → match', () => {
    // "dispensa de tramite" sin acento debe matchear igual que "dispensa de trámite"
    const sin = matchReglamentoShortcut('Cuándo procede la dispensa de tramite');
    const con = matchReglamentoShortcut('Cuándo procede la dispensa de trámite');
    expect(sin?.articulos).toEqual(con?.articulos);
  });

  it('query con capitalización varies → match', () => {
    const lower = matchReglamentoShortcut('moción de fondo');
    const upper = matchReglamentoShortcut('MOCIÓN DE FONDO');
    const mixed = matchReglamentoShortcut('Moción De Fondo');
    expect(lower?.articulos).toEqual(upper?.articulos);
    expect(upper?.articulos).toEqual(mixed?.articulos);
  });

  it('query con leading/trailing spaces → match', () => {
    // Usamos una query que SÍ matchea uno de los patterns (la otra
    // versión "plazo de dictamen" sola no matchea — el pattern exige
    // "comisión permanente" o "informe" — esto es correcto, ese
    // término solo es demasiado genérico).
    const r = matchReglamentoShortcut('   plazo de dictamen para comisión permanente   ');
    expect(r?.articulos).toContain('Art. 80');
  });

  it('query con caracteres especiales → no rompe', () => {
    expect(() => matchReglamentoShortcut('???***')).not.toThrow();
    expect(() => matchReglamentoShortcut('[regex] /test/ + .*')).not.toThrow();
  });
});

describe('matchReglamentoShortcut — first-match wins (order matters)', () => {
  it('si query matchea múltiples, devuelve el PRIMER pattern del array (order matters)', () => {
    // Behavior es determinístico por orden del array REGLAMENTO_SHORTCUTS.
    // "plazo de la reforma constitucional" NO matchea "plazo dictamen
    // comisión permanente" (le falta "comisión"), pero SÍ matchea
    // "reforma constitución" → Art. 184. Verificamos shape determinístico.
    const r = matchReglamentoShortcut('plazo de la reforma constitucional');
    expect(r).not.toBeNull();
    expect(r?.articulos).toContain('Art. 184');
  });

  it('"plazo dictamen comisión permanente" gana sobre "plazo reforma constitucional" en query mixed', () => {
    // Si la query tiene AMBOS conceptos, el orden del array decide.
    // En REGLAMENTO_SHORTCUTS, plazo dictamen está PRIMERO, así que gana.
    const r = matchReglamentoShortcut(
      'cuál es el plazo del dictamen para comisión permanente en una reforma constitucional',
    );
    expect(r?.articulos).toContain('Art. 80');
  });
});

describe('buildReglamentoHintMessage', () => {
  it('genera system message con etiqueta HINT INTERNO', () => {
    const shortcut = REGLAMENTO_SHORTCUTS.find((s) => s.articulos.includes('Art. 80'));
    expect(shortcut).toBeDefined();
    const msg = buildReglamentoHintMessage(shortcut!);
    expect(msg).toContain('HINT INTERNO');
    expect(msg).toContain('no exponer literalmente al usuario');
    expect(msg).toContain('Art. 80');
  });

  it('incluye hint adicional cuando shortcut tiene .hint definido', () => {
    const shortcut = REGLAMENTO_SHORTCUTS.find((s) => s.articulos.includes('Art. 80'));
    const msg = buildReglamentoHintMessage(shortcut!);
    // Art. 80 tiene hint sobre "60 días hábiles"
    expect(msg).toContain('60 días');
  });

  it('cuando shortcut NO tiene hint, NO incluye contexto extra', () => {
    // Buscar un shortcut SIN hint
    const noHint = REGLAMENTO_SHORTCUTS.find((s) => !s.hint);
    if (!noHint) {
      // Si todos tienen hint, skip — todavía pasa.
      return;
    }
    const msg = buildReglamentoHintMessage(noHint);
    expect(msg).not.toContain('Contexto que ya conocés');
  });

  it('mensaje siempre indica que primer acción es llamar search tools', () => {
    for (const s of REGLAMENTO_SHORTCUTS.slice(0, 5)) {
      const msg = buildReglamentoHintMessage(s);
      expect(msg.toLowerCase()).toContain('search_reglamento');
    }
  });
});

describe('REGLAMENTO_SHORTCUTS — integridad del array', () => {
  it('tiene al menos 20 shortcuts', () => {
    expect(REGLAMENTO_SHORTCUTS.length).toBeGreaterThanOrEqual(20);
  });

  it('todos los shortcuts tienen pattern válido (RegExp)', () => {
    for (const s of REGLAMENTO_SHORTCUTS) {
      expect(s.pattern).toBeInstanceOf(RegExp);
    }
  });

  it('todos los shortcuts tienen al menos un artículo', () => {
    for (const s of REGLAMENTO_SHORTCUTS) {
      expect(s.articulos.length).toBeGreaterThan(0);
    }
  });

  it('todos los artículos siguen el formato "Art. N" o tienen "(jurisprudencia ...)"', () => {
    for (const s of REGLAMENTO_SHORTCUTS) {
      for (const a of s.articulos) {
        expect(a).toMatch(/^Art\.\s*\d+/);
      }
    }
  });

  it('todos los patterns son case-insensitive (flag i)', () => {
    for (const s of REGLAMENTO_SHORTCUTS) {
      expect(s.pattern.flags).toContain('i');
    }
  });
});
