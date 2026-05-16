/**
 * Tests golden de ralReglasEvaluator — 20 casos reales de consulta.
 *
 * Sprint 3, Track Q (2026-05-16).
 *
 * Cada caso simula una pregunta que un consultor de CL2 haría a Lexa.
 * El test verifica que la regla esperada está entre las top-K devueltas.
 *
 * Los casos están diseñados sobre las 50 reglas seedeadas en la migración
 * 0042_ral_reglas.sql. El mock no carga las reglas reales: cada test setea
 * la fixture específica que cubre el caso. Esto desacopla los tests del
 * estado actual de la DB (si mañana cambia el contenido de una regla, los
 * tests siguen verdes porque las fixtures son explícitas).
 *
 * Source: Sprint 3 Track Q, 2026-05-16.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Supabase mock (mismo pattern que ralReglasEvaluator.test.ts) ────────────

interface MockResult {
  data: unknown;
  error: unknown;
}

const _table: { rows: unknown[] } = { rows: [] };

function setReglas(rows: unknown[]) {
  _table.rows = rows;
}

vi.mock('@supabase/supabase-js', () => {
  function buildChain(): Record<string, unknown> {
    let filterArticulos: string[] | null = null;
    let filterArea: string | null = null;
    let filterOr: string | null = null;
    let limitN: number | null = null;

    const c: Record<string, unknown> = {
      eq: (col: string, val: unknown) => {
        if (col === 'area_procedural' && typeof val === 'string') filterArea = val;
        return c;
      },
      overlaps: (_col: string, vals: unknown[]) => {
        filterArticulos = (vals as string[]).map((x) => x.toLowerCase());
        return c;
      },
      or: (f: string) => {
        filterOr = f;
        return c;
      },
      limit: (n: number) => {
        limitN = n;
        return c;
      },
      select: () => c,

      then: (resolve?: (r: MockResult) => unknown, reject?: (e: unknown) => unknown) => {
        const filtered = (_table.rows as Array<Record<string, unknown>>).filter((r) => {
          if (filterArticulos) {
            const arts = (r.articulos_relacionados as string[] | undefined) ?? [];
            const has = arts.some((a) => filterArticulos!.includes(a.toLowerCase()));
            if (!has) return false;
          }
          if (filterArea) {
            if (r.area_procedural !== filterArea) return false;
          }
          if (filterOr) {
            // filterOr looks like: "titulo.ilike.%kw%,descripcion.ilike.%kw%,..."
            const tokens = filterOr.split(',').map((p) => {
              const m = p.match(/^(titulo|descripcion)\.ilike\.%(.+)%$/);
              return m ? { col: m[1], pat: m[2] } : null;
            }).filter(Boolean) as Array<{ col: string; pat: string }>;
            if (tokens.length > 0) {
              const matchAny = tokens.some((t) => {
                const value = String(r[t.col] ?? '').toLowerCase();
                return value.includes(t.pat.toLowerCase());
              });
              if (!matchAny) return false;
            }
          }
          return true;
        });
        const limited = limitN ? filtered.slice(0, limitN) : filtered;
        return Promise.resolve({ data: limited, error: null }).then(resolve, reject);
      },
      catch: (reject?: (e: unknown) => unknown) =>
        Promise.resolve({ data: _table.rows, error: null }).catch(reject),
    };

    return c;
  }

  return {
    createClient: () => ({
      from: () => buildChain(),
    }),
  };
});

vi.mock('./logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

import { evaluateRalAplicacion } from './ralReglasEvaluator.js';

// ─── Reglas fixtures — un subconjunto que cubre los 20 casos ─────────────────

function r(over: Partial<{
  id: string;
  slug: string;
  titulo: string;
  descripcion: string;
  area_procedural: string;
  articulos_relacionados: string[];
  vigente: boolean;
}>) {
  return {
    id: over.id ?? `id-${over.slug}`,
    slug: over.slug ?? 'unknown',
    titulo: over.titulo ?? 'Regla sin título',
    descripcion: over.descripcion ?? 'Descripción genérica',
    area_procedural: over.area_procedural ?? 'mociones',
    condiciones: {},
    articulos_relacionados: over.articulos_relacionados ?? [],
    excepciones: null,
    ejemplos: null,
    fuente_pdf_url: null,
    fuente_pagina: null,
    vigente: over.vigente ?? true,
  };
}

const REGLAS_FIXTURE = [
  r({
    slug: 'mocion_137_primer_dia_obligatoria',
    titulo: 'Moción 137 primer día requiere 5 firmas',
    descripcion: 'Toda moción de fondo presentada en primer día requiere al menos 5 firmas',
    area_procedural: 'mociones',
    articulos_relacionados: ['137'],
  }),
  r({
    slug: 'mocion_138_segundo_dia_orden',
    titulo: 'Segundo día votación en orden cronológico',
    descripcion: 'Las mociones 138 segundo día se votan en orden de presentación',
    area_procedural: 'mociones',
    articulos_relacionados: ['138'],
  }),
  r({
    slug: 'mocion_reiteracion_un_tercio_firmas',
    titulo: 'Reiteración de moción requiere un tercio de firmas',
    descripcion: 'Moción rechazada en comisión requiere firmas de 19 diputados para reiterar',
    area_procedural: 'mociones',
    articulos_relacionados: ['137', '138'],
  }),
  r({
    slug: 'mocion_177_dispensa_tramite_dos_tercios',
    titulo: 'Dispensa de trámite art. 177 requiere 2/3',
    descripcion: 'La dispensa de trámite requiere votación nominal favorable de dos tercios',
    area_procedural: 'mociones',
    articulos_relacionados: ['177'],
  }),
  r({
    slug: 'mocion_119_prorroga_cuatrienal',
    titulo: 'Moción 119 prorroga cuatrienio 60 días',
    descripcion: 'La moción 119 permite prorrogar el plazo cuatrienal hasta 60 días una sola vez',
    area_procedural: 'mociones',
    articulos_relacionados: ['119'],
  }),
  r({
    slug: 'audiencia_tecnica_obligatoria_gremio_afectado',
    titulo: 'Audiencia técnica obligatoria a gremio afectado',
    descripcion: 'Cuando un proyecto afecta a gremio organizado, audiencia técnica es obligatoria',
    area_procedural: 'audiencias',
    articulos_relacionados: ['174', '175'],
  }),
  r({
    slug: 'audiencia_plazo_minimo_8_dias_naturales',
    titulo: 'Audiencia requiere notificación 8 días antes',
    descripcion: 'Convocatoria a audiencia debe notificarse con al menos 8 días naturales',
    area_procedural: 'audiencias',
    articulos_relacionados: ['175'],
  }),
  r({
    slug: 'comision_plazo_cuatrienal_4_anos_habiles',
    titulo: 'Plazo cuatrienal 4 años hábiles',
    descripcion: 'Una comisión tiene 4 años hábiles para dictaminar un expediente',
    area_procedural: 'cuatrienales',
    articulos_relacionados: ['81', '119'],
  }),
  r({
    slug: 'comision_quorum_minimo_mitad_mas_uno',
    titulo: 'Quórum de comisión mitad más uno',
    descripcion: 'Una comisión requiere mitad más uno de miembros para sesionar válidamente',
    area_procedural: 'comisiones',
    articulos_relacionados: ['33', '34'],
  }),
  r({
    slug: 'comision_dictamen_mayoria_simple',
    titulo: 'Dictamen requiere mayoría simple presentes',
    descripcion: 'Dictamen afirmativo o negativo requiere mayoría simple de los presentes',
    area_procedural: 'comisiones',
    articulos_relacionados: ['89', '90'],
  }),
  r({
    slug: 'plenario_quorum_minimo_38_diputados',
    titulo: 'Quórum plenario 38 diputados',
    descripcion: 'Plenario requiere 38 diputados presentes para sesionar',
    area_procedural: 'plenario',
    articulos_relacionados: ['27', '32'],
  }),
  r({
    slug: 'plenario_segundo_debate_3_dias_minimo',
    titulo: 'Entre primer y segundo debate median 3 días',
    descripcion: 'Entre primer y segundo debate deben mediar 3 días naturales salvo dispensa 177',
    area_procedural: 'plenario',
    articulos_relacionados: ['126', '177'],
  }),
  r({
    slug: 'ley_2_tercios_materias_calificadas',
    titulo: 'Materias del 88-91 requieren 2/3',
    descripcion: 'Proyectos del art. 88-91 Constitución requieren 2/3 del total de diputados',
    area_procedural: 'leyes_especiales',
    articulos_relacionados: ['126'],
  }),
  r({
    slug: 'ley_veto_resellado_2_tercios',
    titulo: 'Resello de veto requiere 2/3',
    descripcion: 'Resellar ley vetada requiere 2/3 del total (38 votos)',
    area_procedural: 'leyes_especiales',
    articulos_relacionados: ['127'],
  }),
  r({
    slug: 'consulta_obligatoria_sala_iv_constitucional',
    titulo: 'Consulta Sala IV obligatoria en constitucional',
    descripcion: 'Diez diputados pueden solicitar consulta Sala IV; suspende trámite un mes',
    area_procedural: 'consultas',
    articulos_relacionados: ['96'],
  }),
  r({
    slug: 'consulta_facultativa_minimo_10_diputados',
    titulo: 'Consulta facultativa requiere 10 firmas',
    descripcion: 'Consulta facultativa a Sala IV requiere al menos 10 firmas de diputados',
    area_procedural: 'consultas',
    articulos_relacionados: ['96'],
  }),
  r({
    slug: 'cuatrienal_archivo_automatico_sin_dictamen',
    titulo: 'Archivo automático al vencer cuatrienio',
    descripcion: 'Al vencer cuatrienio sin dictamen el expediente se archiva por ministerio de ley',
    area_procedural: 'cuatrienales',
    articulos_relacionados: ['81', '119'],
  }),
  r({
    slug: 'sesion_extraordinaria_periodo_agosto_octubre_febrero_abril',
    titulo: 'Sesiones extraordinarias agenda fija ejecutivo',
    descripcion: 'En sesiones extraordinarias agenda la fija el Ejecutivo por decreto',
    area_procedural: 'sesiones',
    articulos_relacionados: ['118'],
  }),
  r({
    slug: 'votacion_nominal_obligatoria_leyes_calificadas',
    titulo: 'Votación nominal obligatoria en calificadas',
    descripcion: 'Votación nominal obligatoria cuando se requiere mayoría calificada',
    area_procedural: 'votaciones',
    articulos_relacionados: ['126'],
  }),
  r({
    slug: 'derecho_fuero_parlamentario',
    titulo: 'Diputados gozan de fuero parlamentario',
    descripcion: 'Inviolabilidad por opiniones del diputado en ejercicio del cargo',
    area_procedural: 'derechos_diputados',
    articulos_relacionados: ['110', '111'],
  }),
];

// ─── Casos golden ────────────────────────────────────────────────────────────

interface GoldenCase {
  pregunta: string;
  expediente?: string;
  articulos?: string[];
  reglas_esperadas: string[]; // slug(s)
}

const GOLDEN_CASES: GoldenCase[] = [
  {
    pregunta: '¿Cuántas firmas necesita una moción 137 en primer día?',
    articulos: ['137'],
    reglas_esperadas: ['mocion_137_primer_dia_obligatoria'],
  },
  {
    pregunta: '¿En qué orden se votan las mociones 138 segundo día?',
    articulos: ['138'],
    reglas_esperadas: ['mocion_138_segundo_dia_orden'],
  },
  {
    pregunta: '¿Cuántas firmas necesito para reiterar en plenario una moción rechazada en comisión?',
    articulos: ['137', '138'],
    reglas_esperadas: ['mocion_reiteracion_un_tercio_firmas'],
  },
  {
    pregunta: '¿Qué votación necesita una dispensa de trámite del art. 177?',
    articulos: ['177'],
    reglas_esperadas: ['mocion_177_dispensa_tramite_dos_tercios'],
  },
  {
    pregunta: '¿Cómo prorrogamos el plazo cuatrienal si está por vencer?',
    articulos: ['119'],
    reglas_esperadas: ['mocion_119_prorroga_cuatrienal'],
  },
  {
    pregunta: '¿La comisión debe convocar audiencia técnica al gremio afectado?',
    articulos: ['174'],
    reglas_esperadas: ['audiencia_tecnica_obligatoria_gremio_afectado'],
  },
  {
    pregunta: '¿Con cuánta antelación se debe notificar una audiencia?',
    articulos: ['175'],
    reglas_esperadas: ['audiencia_tecnica_obligatoria_gremio_afectado', 'audiencia_plazo_minimo_8_dias_naturales'],
  },
  {
    pregunta: '¿En cuánto tiempo vence el cuatrienio de un expediente?',
    articulos: ['81'],
    reglas_esperadas: ['comision_plazo_cuatrienal_4_anos_habiles', 'cuatrienal_archivo_automatico_sin_dictamen'],
  },
  {
    pregunta: '¿Cuántos miembros forman quórum en una comisión?',
    articulos: ['33'],
    reglas_esperadas: ['comision_quorum_minimo_mitad_mas_uno'],
  },
  {
    pregunta: '¿Qué mayoría necesita un dictamen para aprobarse?',
    articulos: ['89'],
    reglas_esperadas: ['comision_dictamen_mayoria_simple'],
  },
  {
    pregunta: '¿Cuál es el quórum mínimo del plenario?',
    articulos: ['27'],
    reglas_esperadas: ['plenario_quorum_minimo_38_diputados'],
  },
  {
    pregunta: '¿Cuándo puede ir el expediente a segundo debate después de aprobado el primero?',
    articulos: ['126', '177'],
    reglas_esperadas: ['plenario_segundo_debate_3_dias_minimo'],
  },
  {
    pregunta: '¿Qué votación requiere una reforma a materia del art. 88 de la Constitución?',
    articulos: ['126'],
    reglas_esperadas: ['ley_2_tercios_materias_calificadas'],
  },
  {
    pregunta: '¿Cuántos votos necesita el plenario para resellar una ley vetada por el Ejecutivo?',
    articulos: ['127'],
    reglas_esperadas: ['ley_veto_resellado_2_tercios'],
  },
  {
    pregunta: '¿Cuántas firmas necesita una consulta a la Sala IV?',
    articulos: ['96'],
    reglas_esperadas: ['consulta_obligatoria_sala_iv_constitucional', 'consulta_facultativa_minimo_10_diputados'],
  },
  {
    pregunta: '¿Qué pasa con un expediente que llegó a 4 años sin dictamen?',
    articulos: ['81', '119'],
    reglas_esperadas: ['comision_plazo_cuatrienal_4_anos_habiles', 'cuatrienal_archivo_automatico_sin_dictamen'],
  },
  {
    pregunta: '¿En sesiones extraordinarias puede plenario discutir cualquier proyecto?',
    articulos: ['118'],
    reglas_esperadas: ['sesion_extraordinaria_periodo_agosto_octubre_febrero_abril'],
  },
  {
    pregunta: '¿Las votaciones por mayoría calificada se hacen económicamente o nominalmente?',
    articulos: ['126'],
    reglas_esperadas: ['votacion_nominal_obligatoria_leyes_calificadas'],
  },
  {
    pregunta: '¿Tiene fuero parlamentario un diputado por lo que dijo en plenario?',
    articulos: ['110', '111'],
    reglas_esperadas: ['derecho_fuero_parlamentario'],
  },
  {
    pregunta: 'cuántas firmas requiere una moción de fondo presentada en primer día',
    // Sin articulos → Camino B (keyword match sobre titulo+descripcion)
    reglas_esperadas: ['mocion_137_primer_dia_obligatoria'],
  },
];

beforeEach(() => {
  setReglas(REGLAS_FIXTURE);
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
});

describe('evaluateRalAplicacion — 20 casos golden', () => {
  for (const caso of GOLDEN_CASES) {
    it(`caso: ${caso.pregunta.slice(0, 70)}`, async () => {
      const result = await evaluateRalAplicacion({
        contexto: caso.pregunta,
        expediente: caso.expediente,
        articulos_pregunta: caso.articulos,
      });

      const slugs = result.reglas_aplicables.map((r) => r.slug);

      // Al menos uno de los slugs esperados debe aparecer en los matches.
      const hit = caso.reglas_esperadas.some((expected) => slugs.includes(expected));

      expect(hit).toBe(true);
    });
  }
});
