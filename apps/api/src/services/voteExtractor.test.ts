/**
 * Tests para voteExtractor.ts — heurística que asocia chunks de votación
 * con expediente. Cobertura:
 *
 *   1. extractExpedienteMentions: formatos de expediente, false-positive
 *      blocker (números aislados, leyes), múltiples menciones.
 *   2. isVoteChunk: vote results vs intención previa.
 *   3. linkVotesToExpedientes: state machine (último mencionado), vote sin
 *      contexto previo, vote con expediente in-chunk.
 *   4. Casos reales del lawyer audit (L9).
 */

import { describe, it, expect } from 'vitest';
import {
  extractExpedienteMentions,
  isVoteChunk,
  linkVotesToExpedientes,
} from './voteExtractor.js';

describe('extractExpedienteMentions — formatos básicos', () => {
  it('"expediente 24.567"', () => {
    expect(extractExpedienteMentions('discutimos el expediente 24.567')).toEqual(['24.567']);
  });

  it('"expediente N° 24.567"', () => {
    expect(extractExpedienteMentions('el expediente N° 24.567 dice')).toEqual(['24.567']);
  });

  it('"expediente número 24.567"', () => {
    expect(extractExpedienteMentions('expediente número 24.567 sobre PANI')).toEqual(['24.567']);
  });

  it('"expediente nº 24.567" (lowercase)', () => {
    expect(extractExpedienteMentions('expediente nº 24.567')).toEqual(['24.567']);
  });

  it('"Exp. 24.567"', () => {
    expect(extractExpedienteMentions('Exp. 24.567 está en plenario')).toEqual(['24.567']);
  });

  it('"exp 24.567" (sin punto)', () => {
    expect(extractExpedienteMentions('exp 24.567 dictaminado')).toEqual(['24.567']);
  });

  it('"proyecto 24.567"', () => {
    expect(extractExpedienteMentions('aprobamos el proyecto 24.567 ayer')).toEqual(['24.567']);
  });

  it('"iniciativa 24.567"', () => {
    expect(extractExpedienteMentions('la iniciativa 24.567 propone')).toEqual(['24.567']);
  });
});

describe('extractExpedienteMentions — normalización de separador', () => {
  it('"24567" sin separador', () => {
    expect(extractExpedienteMentions('expediente 24567')).toEqual(['24.567']);
  });

  it('"24,567" coma como separador', () => {
    expect(extractExpedienteMentions('expediente 24,567')).toEqual(['24.567']);
  });

  it('"24.567" punto (canonical)', () => {
    expect(extractExpedienteMentions('expediente 24.567')).toEqual(['24.567']);
  });
});

describe('extractExpedienteMentions — múltiples menciones', () => {
  it('dos expedientes distintos en orden', () => {
    const r = extractExpedienteMentions('los expedientes 22.111 y el proyecto 22.222');
    expect(r).toEqual(['22.111', '22.222']);
  });

  it('mismo expediente dos veces → dedupe', () => {
    const r = extractExpedienteMentions('el expediente 24.567 y nuevamente el expediente 24.567');
    expect(r).toEqual(['24.567']);
  });

  it('tres expedientes en orden', () => {
    const r = extractExpedienteMentions('exp 22.111, expediente 22.222, proyecto 22.333');
    expect(r).toEqual(['22.111', '22.222', '22.333']);
  });
});

describe('extractExpedienteMentions — falsos positivos bloqueados', () => {
  it('número aislado sin contexto', () => {
    expect(extractExpedienteMentions('el 24.567 está pendiente')).toEqual([]);
  });

  it('Ley 8987 — palabra "Ley" no es ancla', () => {
    expect(extractExpedienteMentions('la Ley 8987 reforma el código')).toEqual([]);
  });

  it('fecha en formato 24.567 (improbable) — sin ancla léxica', () => {
    expect(extractExpedienteMentions('día 24.567 de la legislatura')).toEqual([]);
  });

  it('artículo del Reglamento', () => {
    expect(extractExpedienteMentions('el artículo 137 del Reglamento')).toEqual([]);
  });

  it('número de página', () => {
    expect(extractExpedienteMentions('en la página 24.567 del documento')).toEqual([]);
  });

  it('texto vacío', () => {
    expect(extractExpedienteMentions('')).toEqual([]);
  });

  it('"presupuesto de 240.567 colones" — número sin ancla', () => {
    expect(extractExpedienteMentions('presupuesto de 240.567 colones')).toEqual([]);
  });
});

describe('isVoteChunk — vote results', () => {
  it('"X votos a favor"', () => {
    expect(isVoteChunk('Concluida la votación: 38 votos a favor.')).toBe(true);
  });

  it('"X votos en contra"', () => {
    expect(isVoteChunk('Quedan 10 votos en contra.')).toBe(true);
  });

  it('"X votos afirmativos"', () => {
    expect(isVoteChunk('Cuarenta y cinco votos afirmativos.')).toBe(false); // sin dígitos
  });

  it('"45 votos afirmativos" (con dígitos)', () => {
    expect(isVoteChunk('45 votos afirmativos contra cero negativos.')).toBe(true);
  });

  it('"se aprueba"', () => {
    expect(isVoteChunk('Se aprueba por unanimidad.')).toBe(true);
  });

  it('"se rechaza"', () => {
    expect(isVoteChunk('La moción se rechaza.')).toBe(true);
  });

  it('"queda aprobado"', () => {
    expect(isVoteChunk('El expediente queda aprobado en primer debate.')).toBe(true);
  });

  it('"queda rechazado"', () => {
    expect(isVoteChunk('La iniciativa queda rechazada.')).toBe(true);
  });

  it('"queda desechado"', () => {
    expect(isVoteChunk('El proyecto queda desechado.')).toBe(true);
  });

  it('"votación nominal"', () => {
    expect(isVoteChunk('Procedemos a la votación nominal.')).toBe(true);
  });

  it('"por 38 votos"', () => {
    expect(isVoteChunk('Se aprueba por 38 votos.')).toBe(true);
  });
});

describe('isVoteChunk — no-vote (intención o procedural)', () => {
  it('"vamos a votar"', () => {
    expect(isVoteChunk('Diputados, vamos a votar el siguiente punto.')).toBe(false);
  });

  it('"someter a votación"', () => {
    expect(isVoteChunk('Se somete a votación el proyecto.')).toBe(false);
  });

  it('"votación pendiente"', () => {
    expect(isVoteChunk('La votación está pendiente para la próxima sesión.')).toBe(false);
  });

  it('texto vacío', () => {
    expect(isVoteChunk('')).toBe(false);
  });

  it('discurso general sin votación', () => {
    expect(isVoteChunk('Compañeros diputados, el tema es complejo y requiere debate.')).toBe(false);
  });
});

describe('linkVotesToExpedientes — state machine básico', () => {
  it('expediente seguido de vote → linkage', () => {
    const r = linkVotesToExpedientes([
      { id: 'c1', chunk_index: 0, content: 'discutimos el expediente 24.567 que propone' },
      { id: 'c2', chunk_index: 1, content: 'el debate continúa con argumentos a favor' },
      { id: 'c3', chunk_index: 2, content: 'concluida la votación: 38 votos a favor' },
    ]);
    expect(r).toEqual([
      { chunk_id: 'c3', votando_expediente: '24.567' },
    ]);
  });

  it('vote sin expediente previo → omitido', () => {
    const r = linkVotesToExpedientes([
      { id: 'c1', chunk_index: 0, content: 'compañeros, iniciamos sesión' },
      { id: 'c2', chunk_index: 1, content: 'se aprueba la propuesta' },
    ]);
    expect(r).toEqual([]);
  });

  it('vote con expediente in-chunk → usa el in-chunk', () => {
    const r = linkVotesToExpedientes([
      { id: 'c1', chunk_index: 0, content: 'expediente 22.111 sobre educación' },
      { id: 'c2', chunk_index: 1, content: 'el expediente 22.222 se aprueba por 38 votos' },
    ]);
    expect(r).toEqual([
      { chunk_id: 'c2', votando_expediente: '22.222' },
    ]);
  });

  it('múltiples votes en orden con cambios de expediente', () => {
    const r = linkVotesToExpedientes([
      { id: 'c1', chunk_index: 0, content: 'expediente 22.111' },
      { id: 'c2', chunk_index: 1, content: 'se aprueba con 40 votos a favor' },
      { id: 'c3', chunk_index: 2, content: 'pasamos al expediente 22.222' },
      { id: 'c4', chunk_index: 3, content: 'queda aprobado este expediente' },
    ]);
    expect(r).toEqual([
      { chunk_id: 'c2', votando_expediente: '22.111' },
      { chunk_id: 'c4', votando_expediente: '22.222' },
    ]);
  });

  it('chunks sin orden → se reordenan por chunk_index', () => {
    const r = linkVotesToExpedientes([
      { id: 'c3', chunk_index: 2, content: 'queda aprobado el expediente' },
      { id: 'c1', chunk_index: 0, content: 'expediente 22.111' },
      { id: 'c2', chunk_index: 1, content: 'el debate avanza' },
    ]);
    expect(r).toEqual([
      { chunk_id: 'c3', votando_expediente: '22.111' },
    ]);
  });

  it('chunks vacíos no rompen el flujo', () => {
    const r = linkVotesToExpedientes([
      { id: 'c1', chunk_index: 0, content: 'expediente 22.111' },
      { id: 'c2', chunk_index: 1, content: '' },
      { id: 'c3', chunk_index: 2, content: 'se rechaza' },
    ]);
    expect(r).toEqual([
      { chunk_id: 'c3', votando_expediente: '22.111' },
    ]);
  });

  it('array vacío', () => {
    expect(linkVotesToExpedientes([])).toEqual([]);
  });

  it('último expediente persiste a través de chunks neutrales', () => {
    const r = linkVotesToExpedientes([
      { id: 'c1', chunk_index: 0, content: 'expediente 22.111 sobre tema A' },
      { id: 'c2', chunk_index: 1, content: 'el debate sobre el tema continúa' },
      { id: 'c3', chunk_index: 2, content: 'argumentos de los diputados' },
      { id: 'c4', chunk_index: 3, content: 'más debate' },
      { id: 'c5', chunk_index: 4, content: 'concluida la votación: 38 votos a favor' },
    ]);
    expect(r).toEqual([
      { chunk_id: 'c5', votando_expediente: '22.111' },
    ]);
  });
});

describe('linkVotesToExpedientes — casos del lawyer audit L9', () => {
  it('plenaria 21 may: expediente + vote en chunks separados', () => {
    // Simula el escenario real: el expediente se menciona temprano, el debate
    // ocupa varios chunks, y la votación se anuncia ~30s después.
    const r = linkVotesToExpedientes([
      { id: 'p21-1', chunk_index: 0, content: 'pasamos al expediente 24.567 sobre la reforma del PANI' },
      { id: 'p21-2', chunk_index: 1, content: 'el diputado X presenta argumentos a favor' },
      { id: 'p21-3', chunk_index: 2, content: 'el diputado Y argumenta en contra' },
      { id: 'p21-4', chunk_index: 3, content: 'se procede a la votación nominal' },
      { id: 'p21-5', chunk_index: 4, content: 'concluida la votación: 56 votos a favor, 0 en contra' },
    ]);
    // El chunk 4 (votación nominal) Y el chunk 5 (resultado) son ambos vote.
    expect(r).toEqual([
      { chunk_id: 'p21-4', votando_expediente: '24.567' },
      { chunk_id: 'p21-5', votando_expediente: '24.567' },
    ]);
  });

  it('vote chunk sin expediente cercano (sesión administrativa)', () => {
    // Algunas plenarias tienen votaciones de aprobación de acta, no asociadas
    // a expedientes. NO debemos forzar linkage.
    const r = linkVotesToExpedientes([
      { id: 'a1', chunk_index: 0, content: 'compañeros, iniciamos la sesión' },
      { id: 'a2', chunk_index: 1, content: 'se aprueba el acta de la sesión anterior' },
    ]);
    expect(r).toEqual([]);
  });
});
