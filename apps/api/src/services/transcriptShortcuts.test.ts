/**
 * Tests for transcriptShortcuts.ts — hand-curated index para queries
 * sobre transcripciones plenarias donde el semantic search NO surface
 * el chunk relevante.
 *
 * Cubre:
 *   1. Match positivo por categoría (votación, censura, Sala IV, etc.)
 *   2. Match negativo — queries irrelevantes no disparan
 *   3. Edge cases — vacía, whitespace, capitalización, acentos
 *   4. buildTranscriptHintMessage — shape correcto del HINT INTERNO
 *   5. Integridad del array TRANSCRIPT_SHORTCUTS
 *
 * Sin mocks externos.
 */

import { describe, it, expect } from 'vitest';
import {
  TRANSCRIPT_SHORTCUTS,
  matchTranscriptShortcut,
  buildTranscriptHintMessage,
} from './transcriptShortcuts.js';

describe('matchTranscriptShortcut — happy path', () => {
  it('"votación" simple → fire vote pattern', () => {
    const r = matchTranscriptShortcut('Con qué votación se aprobó el expediente 24.642');
    expect(r).not.toBeNull();
    expect(r?.hint).toContain('votos a favor cero en contra');
  });

  it('"cuántos votos" → fire vote pattern', () => {
    const r = matchTranscriptShortcut('Cuántos votos a favor tuvo el proyecto');
    expect(r).not.toBeNull();
    expect(r?.hint).toContain('votos a favor');
  });

  it('"cómo votó X partido" → fire vote pattern', () => {
    const r = matchTranscriptShortcut('Cómo votó el Frente Amplio en segundo debate');
    expect(r).not.toBeNull();
    expect(r?.hint).toContain('votos a favor');
  });

  it('"nominal" → fire vote pattern', () => {
    const r = matchTranscriptShortcut('Hubo votación nominal en esa sesión');
    expect(r).not.toBeNull();
  });

  it('"moción de censura" → fire censura pattern', () => {
    const r = matchTranscriptShortcut('Se presentó alguna moción de censura el 20 de mayo');
    expect(r).not.toBeNull();
    expect(r?.hint).toContain('moción de censura');
  });

  it('"interpelación" → fire censura pattern', () => {
    const r = matchTranscriptShortcut('Hubo interpelación al ministro de Hacienda');
    expect(r).not.toBeNull();
    expect(r?.hint).toContain('interpelaci');
  });

  it('"consulta constitucional" → fire Sala IV pattern', () => {
    const r = matchTranscriptShortcut('Cuándo se hizo la consulta constitucional sobre el 24.009');
    expect(r).not.toBeNull();
    expect(r?.hint).toContain('Sala Constitucional');
  });

  it('"qué dijo diputado X" → fire intervención pattern', () => {
    const r = matchTranscriptShortcut('Qué dijo el diputado Rodrigo Arias sobre presupuesto');
    expect(r).not.toBeNull();
    expect(r?.hint).toContain('nombre exacto');
  });

  it('"intervención de diputado" → fire intervención pattern', () => {
    const r = matchTranscriptShortcut('Cuál fue la intervención del diputado Alpízar');
    expect(r).not.toBeNull();
  });

  it('"aprobado en segundo debate" → fire aprobación pattern', () => {
    const r = matchTranscriptShortcut('Qué se aprobó en segundo debate el 21 de mayo');
    expect(r).not.toBeNull();
    expect(r?.hint).toContain('aprobado segundo debate');
  });

  it('"aprobado en primer debate" → fire aprobación pattern', () => {
    const r = matchTranscriptShortcut('Expedientes aprobados en primer debate la semana pasada');
    expect(r).not.toBeNull();
  });

  it('"moción aprobada" → fire moción pattern', () => {
    const r = matchTranscriptShortcut('Qué mociones se aprobaron en la sesión');
    expect(r).not.toBeNull();
    expect(r?.hint).toMatch(/moci[óo]n aprobada/);
  });

  it('"moción rechazada" → fire moción pattern', () => {
    const r = matchTranscriptShortcut('Hubo moción rechazada por unanimidad');
    expect(r).not.toBeNull();
  });
});

describe('matchTranscriptShortcut — match negativo', () => {
  it('"detalle expediente 23.234" → null (no es transcript query)', () => {
    expect(matchTranscriptShortcut('Dame el detalle del expediente 23.234')).toBeNull();
  });

  it('"plazo dictamen" → null (es Reglamento)', () => {
    expect(matchTranscriptShortcut('Cuál es el plazo para dictamen de comisión')).toBeNull();
  });

  it('"cuántos votos requiere reforma constitucional" → DISPARA (overlap aceptado)', () => {
    // Query ambigua: pide votos (transcript shortcut SÍ) Y es sobre RAL
    // (reglamento shortcut también). Comportamiento esperado: ambos
    // shortcuts disparan, openRouterStream inyecta ambos hints. Reglamento
    // domina semánticamente (Art 184). El transcript hint es harmless.
    // Si querés query negativa pura, usá una que no mencione votos:
    const r = matchTranscriptShortcut('Cuántos votos requiere una reforma constitucional');
    expect(r).not.toBeNull();
    expect(r?.hint).toContain('votos a favor');
  });

  it('"requisitos de moción sin votación" → null (es procedural pura)', () => {
    // Esta sí es null porque no menciona votos.
    expect(matchTranscriptShortcut('Requisitos formales de una moción de fondo')).toBeNull();
  });

  it('"qué dice el reglamento" → null', () => {
    expect(matchTranscriptShortcut('Qué dice el Reglamento sobre dispensa')).toBeNull();
  });

  it('query genérica no procedimental ni de votación → null', () => {
    expect(matchTranscriptShortcut('hola, cómo va el trabajo')).toBeNull();
  });
});

describe('matchTranscriptShortcut — edge cases', () => {
  it('query vacía → null', () => {
    expect(matchTranscriptShortcut('')).toBeNull();
  });

  it('whitespace only → null', () => {
    expect(matchTranscriptShortcut('   \n\t  ')).toBeNull();
  });

  it('capitalización varies → match consistente', () => {
    const lower = matchTranscriptShortcut('cuántos votos a favor');
    const upper = matchTranscriptShortcut('CUÁNTOS VOTOS A FAVOR');
    expect(lower?.hint).toEqual(upper?.hint);
  });

  it('con acentos varies → match consistente', () => {
    const con = matchTranscriptShortcut('hubo votación nominal');
    const sin = matchTranscriptShortcut('hubo votacion nominal');
    expect(con?.hint).toEqual(sin?.hint);
  });

  it('caracteres especiales → no throw', () => {
    expect(() => matchTranscriptShortcut('???***')).not.toThrow();
    expect(() => matchTranscriptShortcut('[test] /votacion/')).not.toThrow();
  });

  it('leading/trailing spaces → match', () => {
    const r = matchTranscriptShortcut('   cuántos votos a favor   ');
    expect(r).not.toBeNull();
  });
});

describe('matchTranscriptShortcut — first-match wins', () => {
  it('query con "votación" + "moción" → primer pattern (votación) gana', () => {
    // En TRANSCRIPT_SHORTCUTS, votación está PRIMERO en el array
    const r = matchTranscriptShortcut('Cuál fue la votación de la moción de censura');
    expect(r).not.toBeNull();
    // Tanto vote como censura matchean; el array tiene vote primero
    expect(r?.hint).toContain('votos a favor');
  });
});

describe('buildTranscriptHintMessage', () => {
  it('genera system message con etiqueta HINT INTERNO', () => {
    const shortcut = TRANSCRIPT_SHORTCUTS[0];
    const msg = buildTranscriptHintMessage(shortcut);
    expect(msg).toContain('HINT INTERNO');
    expect(msg).toContain('no exponer literalmente al usuario');
  });

  it('incluye el hint del shortcut', () => {
    const shortcut = TRANSCRIPT_SHORTCUTS[0];
    const msg = buildTranscriptHintMessage(shortcut);
    expect(msg).toContain(shortcut.hint);
  });
});

describe('Wave 3.1 — vote hint reforzado (L9 fix)', () => {
  it('vote hint contiene directivas explícitas ("CRÍTICO", "PROTOCOLO OBLIGATORIO")', () => {
    const r = matchTranscriptShortcut('cuántos votos a favor');
    expect(r?.hint).toContain('CRÍTICO');
    expect(r?.hint).toContain('PROTOCOLO OBLIGATORIO');
  });

  it('vote hint exige llamada explícita a search_transcripts (no solo sugerencia)', () => {
    const r = matchTranscriptShortcut('votación 21 de mayo');
    expect(r?.hint).toContain('SIEMPRE llamá AMBAS tools');
    expect(r?.hint).toContain('search_transcripts');
  });

  it('vote hint provee query EXACTA "votos a favor cero en contra"', () => {
    const r = matchTranscriptShortcut('cómo votó el Frente Amplio');
    expect(r?.hint).toContain('"votos a favor cero en contra"');
  });

  it('vote hint advierte contra terminar sin la llamada', () => {
    const r = matchTranscriptShortcut('votos a favor');
    // /s flag (dotall) porque el hint tiene line breaks entre "termines" y "sin"
    expect(r?.hint).toMatch(/NUNCA termines.*sin haber\s+llamado/is);
  });

  it('vote hint clarifica que resumen ejecutivo NO contiene cifras de votación', () => {
    const r = matchTranscriptShortcut('cuántos votos');
    expect(r?.hint).toMatch(/resumen ejecutivo NO contiene cifras/i);
  });
});

describe('TRANSCRIPT_SHORTCUTS — integridad', () => {
  it('tiene al menos 5 shortcuts', () => {
    expect(TRANSCRIPT_SHORTCUTS.length).toBeGreaterThanOrEqual(5);
  });

  it('todos los shortcuts tienen pattern válido (RegExp)', () => {
    for (const s of TRANSCRIPT_SHORTCUTS) {
      expect(s.pattern).toBeInstanceOf(RegExp);
    }
  });

  it('todos los shortcuts tienen hint no vacío', () => {
    for (const s of TRANSCRIPT_SHORTCUTS) {
      expect(typeof s.hint).toBe('string');
      expect(s.hint.length).toBeGreaterThan(0);
    }
  });

  it('todos los patterns son case-insensitive', () => {
    for (const s of TRANSCRIPT_SHORTCUTS) {
      expect(s.pattern.flags).toContain('i');
    }
  });
});
