/**
 * editorial.test.ts — Sprint 3 Track P.
 *
 * Tests de los parsers de los 3 jobs editoriales. Los parsers son la parte
 * más frágil porque dependen del output del LLM, que puede venir en varios
 * formatos (JSON puro, fenced en markdown, con texto extra alrededor).
 *
 * NO testea las llamadas a Supabase ni a OpenRouter — esas son integradoras
 * y necesitan fixture pesado. Acá nos enfocamos en lo que se rompe primero:
 *   - parseCategoriasLlm
 *   - parseResumenLlm
 *   - parseInformeLlm
 *   - ISO week math (getIsoWeek + isoWeekRange)
 */

import { describe, it, expect } from 'vitest';
import { parseCategoriasLlm } from './categorizeExpedientes.js';
import { parseResumenLlm } from './generateResumenMixto.js';
import {
  parseInformeLlm,
  getIsoWeek,
  isoWeekString,
  isoWeekRange,
} from './generateInformeSemanal.js';

// ── parseCategoriasLlm ──────────────────────────────────────────────────────

describe('parseCategoriasLlm', () => {
  it('parsea JSON puro con 3 categorías', () => {
    const raw = JSON.stringify({
      categorias: [
        { slug: 'ambiente_acuifero', confidence: 0.95, razon: 'Aguas residuales' },
        { slug: 'salud', confidence: 0.6, razon: 'Impacto sanitario' },
        { slug: 'energia', confidence: 0.3, razon: 'Tangencial' },
      ],
    });
    const out = parseCategoriasLlm(raw);
    expect(out).toHaveLength(3);
    expect(out[0]?.slug).toBe('ambiente_acuifero');
    expect(out[0]?.confidence).toBe(0.95);
  });

  it('recupera de markdown fence ```json```', () => {
    const raw = '```json\n{"categorias":[{"slug":"salud","confidence":0.9,"razon":"x"}]}\n```';
    const out = parseCategoriasLlm(raw);
    expect(out).toHaveLength(1);
    expect(out[0]?.slug).toBe('salud');
  });

  it('recupera de texto con prefacio', () => {
    const raw = 'Acá tenés la clasificación:\n{"categorias":[{"slug":"salud","confidence":0.9,"razon":"x"}]}';
    const out = parseCategoriasLlm(raw);
    expect(out).toHaveLength(1);
    expect(out[0]?.slug).toBe('salud');
  });

  it('cap a 3 categorías incluso si LLM devuelve más', () => {
    const raw = JSON.stringify({
      categorias: Array.from({ length: 6 }, (_, i) => ({
        slug: `cat_${i}`,
        confidence: 0.5,
        razon: 'x',
      })),
    });
    const out = parseCategoriasLlm(raw);
    expect(out).toHaveLength(3);
  });

  it('filtra confidence fuera de rango [0,1]', () => {
    const raw = JSON.stringify({
      categorias: [
        { slug: 'a', confidence: 1.5, razon: 'x' }, // fuera de rango
        { slug: 'b', confidence: 0.7, razon: 'x' }, // ok
      ],
    });
    const out = parseCategoriasLlm(raw);
    expect(out).toHaveLength(1);
    expect(out[0]?.slug).toBe('b');
  });

  it('tira con JSON inválido', () => {
    expect(() => parseCategoriasLlm('no es JSON nada')).toThrow();
  });

  it('tira si falta el array categorias', () => {
    expect(() => parseCategoriasLlm('{"otra_cosa": []}')).toThrow();
  });
});

// ── parseResumenLlm ─────────────────────────────────────────────────────────

describe('parseResumenLlm', () => {
  it('parsea resumen + fuentes', () => {
    const raw = JSON.stringify({
      resumen_md: '**Contexto**: proyecto X.\n\n**Posturas**: la mayoría aprueba.\n\n**Próximos pasos**: votación pendiente.',
      fuentes_citadas: [
        { tipo: 'dictamen_mayoria', fecha: '2024-08-15', url: 'http://x', fragmento_citado: 'lorem' },
      ],
    });
    const out = parseResumenLlm(raw);
    expect(out.resumen_md).toContain('**Contexto**');
    expect(out.fuentes).toHaveLength(1);
    expect(out.fuentes[0]?.tipo).toBe('dictamen_mayoria');
  });

  it('acepta fuentes sin url/fecha/fragmento', () => {
    const raw = JSON.stringify({
      resumen_md: 'x',
      fuentes_citadas: [{ tipo: 'sala' }],
    });
    const out = parseResumenLlm(raw);
    expect(out.fuentes).toHaveLength(1);
    expect(out.fuentes[0]?.tipo).toBe('sala');
    expect(out.fuentes[0]?.url).toBeUndefined();
  });

  it('omite fuentes sin tipo', () => {
    const raw = JSON.stringify({
      resumen_md: 'x',
      fuentes_citadas: [{ fecha: '2024-01-01' }, { tipo: 'acta', fecha: '2024-02-01' }],
    });
    const out = parseResumenLlm(raw);
    expect(out.fuentes).toHaveLength(1);
    expect(out.fuentes[0]?.tipo).toBe('acta');
  });

  it('trunca fragmento_citado a 600 chars', () => {
    const raw = JSON.stringify({
      resumen_md: 'x',
      fuentes_citadas: [{ tipo: 'acta', fragmento_citado: 'a'.repeat(1000) }],
    });
    const out = parseResumenLlm(raw);
    expect(out.fuentes[0]?.fragmento_citado).toHaveLength(600);
  });

  it('tira si falta resumen_md', () => {
    expect(() => parseResumenLlm('{"fuentes_citadas":[]}')).toThrow();
  });

  it('recupera de fenced markdown', () => {
    const raw = '```json\n{"resumen_md":"x","fuentes_citadas":[]}\n```';
    const out = parseResumenLlm(raw);
    expect(out.resumen_md).toBe('x');
  });
});

// ── parseInformeLlm ─────────────────────────────────────────────────────────

describe('parseInformeLlm', () => {
  it('separa cuerpo_md del JSON con el separator', () => {
    const raw = [
      '# Informe semanal CL2 — Semana 2026-W20',
      '',
      'Resumen ejecutivo: bla bla.',
      '',
      '---ACCIONES-JSON---',
      '{"acciones_propuestas":[{"tipo":"reunion","expediente":"23.511","urgencia":"alta","sugerencia":"llamá al cliente"}]}',
    ].join('\n');
    const out = parseInformeLlm(raw);
    expect(out.cuerpo_md).toContain('# Informe semanal');
    expect(out.cuerpo_md).not.toContain('ACCIONES-JSON');
    expect(out.acciones_propuestas).toHaveLength(1);
    expect(out.acciones_propuestas[0]?.urgencia).toBe('alta');
    expect(out.acciones_propuestas[0]?.expediente).toBe('23.511');
  });

  it('cuando no hay separator, cuerpo_md = todo el output y acciones = []', () => {
    const raw = '# Informe\n\nCuerpo nomás.';
    const out = parseInformeLlm(raw);
    expect(out.cuerpo_md).toBe('# Informe\n\nCuerpo nomás.');
    expect(out.acciones_propuestas).toEqual([]);
  });

  it('defaultea urgencia a media si viene mal', () => {
    const raw = [
      '# Informe',
      '---ACCIONES-JSON---',
      '{"acciones_propuestas":[{"tipo":"x","urgencia":"super-mega","sugerencia":"y"}]}',
    ].join('\n');
    const out = parseInformeLlm(raw);
    expect(out.acciones_propuestas[0]?.urgencia).toBe('media');
  });

  it('omite acciones sin tipo o sin sugerencia', () => {
    const raw = [
      '# Informe',
      '---ACCIONES-JSON---',
      '{"acciones_propuestas":[{"tipo":""},{"sugerencia":""},{"tipo":"x","sugerencia":"y","urgencia":"baja"}]}',
    ].join('\n');
    const out = parseInformeLlm(raw);
    expect(out.acciones_propuestas).toHaveLength(1);
    expect(out.acciones_propuestas[0]?.tipo).toBe('x');
  });

  it('recupera JSON fenced después del separator', () => {
    const raw = [
      '# Informe',
      '---ACCIONES-JSON---',
      '```json',
      '{"acciones_propuestas":[{"tipo":"x","sugerencia":"y","urgencia":"alta"}]}',
      '```',
    ].join('\n');
    const out = parseInformeLlm(raw);
    expect(out.acciones_propuestas).toHaveLength(1);
  });

  it('tira con cuerpo vacío', () => {
    expect(() => parseInformeLlm('')).toThrow();
  });
});

// ── ISO week math ───────────────────────────────────────────────────────────

describe('ISO week math', () => {
  it('getIsoWeek(2026-05-11 lunes) → W20', () => {
    const w = getIsoWeek(new Date('2026-05-11T12:00:00Z'));
    expect(w.year).toBe(2026);
    expect(w.week).toBe(20);
  });

  it('isoWeekString(2026-05-13 miércoles) → "2026-W20"', () => {
    expect(isoWeekString(new Date('2026-05-13T08:00:00Z'))).toBe('2026-W20');
  });

  it('isoWeekRange("2026-W20") devuelve lunes 2026-05-11 → lunes 2026-05-18', () => {
    const { start, end } = isoWeekRange('2026-W20');
    expect(start.toISOString().slice(0, 10)).toBe('2026-05-11');
    expect(end.toISOString().slice(0, 10)).toBe('2026-05-18');
  });

  it('isoWeekRange tira con formato inválido', () => {
    expect(() => isoWeekRange('2026-20')).toThrow();
    expect(() => isoWeekRange('foo')).toThrow();
  });

  it('round-trip getIsoWeek → isoWeekRange contiene la fecha original', () => {
    const original = new Date('2026-05-15T15:00:00Z');
    const iso = isoWeekString(original);
    const { start, end } = isoWeekRange(iso);
    expect(start.getTime()).toBeLessThanOrEqual(original.getTime());
    expect(end.getTime()).toBeGreaterThan(original.getTime());
  });
});
