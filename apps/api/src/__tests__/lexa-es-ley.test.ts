/**
 * lexa-es-ley.test.ts — Suite golden "es ley o no"
 *
 * Bug reportado por Javier Corrales (reunión 2026-05-14, min 03:13):
 * Lexa decía "este expediente aún no es ley" sobre un expediente que SÍ
 * era ley. Root cause: se miraba el campo `estado` (posición física del
 * expediente en el SIL) en vez de los indicadores reales de ley.
 *
 * Esta suite valida 20/20:
 *   - 10 expedientes que SÍ son ley
 *   - 10 expedientes que NO son ley
 *
 * Definition of done (KR4 del Sprint 1): 20/20 pasan.
 *
 * @see apps/api/src/services/expedienteContext.ts — la lógica de decisión
 */
import { describe, it, expect } from 'vitest';
import { buildExpedienteContext, type ExpedienteForContext } from '../services/expedienteContext.js';

// ─────────────────────────────────────────────────────────────────────────────
// GOLDEN DATASET — 10 expedientes que SÍ son ley
// Fuentes: datos reales del SIL de Costa Rica + estructura del schema CL2.
// ─────────────────────────────────────────────────────────────────────────────

const leyExpedientes: ExpedienteForContext[] = [
  // 1. Detección vía extras.numero_ley (caso más común)
  {
    numero: '23.234',
    estado: 'En el archivo',
    extras: {
      numero_ley: '10.200',
      numero_gaceta: '94',
      fecha_publicacion: '2024-03-15',
    },
    sil_leyes: null,
  },
  // 2. Detección vía sil_leyes row (tabla de seguimiento)
  {
    numero: '22.815',
    estado: 'Vigente',
    extras: {},
    sil_leyes: {
      numero_gaceta: '210',
      numero_ley: '10.117',
      fecha_publicacion: '2023-11-01',
      alcance: '41',
    },
  },
  // 3. Detección vía campo es_ley directo
  {
    numero: '23.511',
    estado: 'Vigente',
    es_ley: true,
    extras: {},
    sil_leyes: null,
  },
  // 4. Detección vía estado=Vigente + fecha_publicacion (alias)
  {
    numero: '22.019',
    estado: 'Vigente',
    extras: {
      fecha_publicacion: '2023-06-12',
      numero_gaceta: '112',
    },
    sil_leyes: null,
  },
  // 5. extras.numero_ley + sil_leyes (ambas fuentes confirmando)
  {
    numero: '21.388',
    estado: 'Vigente',
    extras: {
      numero_ley: '9.949',
      numero_gaceta: '55',
      fecha_publicacion: '2022-04-21',
    },
    sil_leyes: {
      numero_gaceta: '55',
      numero_ley: '9.949',
      fecha_publicacion: '2022-04-21',
    },
  },
  // 6. Ley con alcance posterior (fue modificada)
  {
    numero: '20.580',
    estado: 'Vigente',
    extras: {
      numero_ley: '9.694',
      numero_gaceta: '191',
      fecha_publicacion: '2019-10-02',
      alcance: '202',
    },
    sil_leyes: null,
  },
  // 7. Solo sil_leyes, sin numero_ley en extras (scraper no la captó)
  {
    numero: '22.100',
    estado: 'En comisión',
    extras: {},
    sil_leyes: {
      numero_gaceta: '67',
      numero_ley: '10.065',
      fecha_publicacion: '2023-02-28',
    },
  },
  // 8. extras.numero_ley sin gaceta (scraper parcial)
  {
    numero: '23.800',
    estado: 'Plenario',
    extras: {
      numero_ley: '10.350',
    },
    sil_leyes: null,
  },
  // 9. es_ley=true explícito + sil_leyes
  {
    numero: '21.950',
    estado: 'Vigente',
    es_ley: true,
    extras: {},
    sil_leyes: {
      numero_gaceta: '180',
      fecha_publicacion: '2023-09-18',
    },
  },
  // 10. Estado raro ("En el archivo") pero tiene numero_ley en extras
  {
    numero: '20.121',
    estado: 'En el archivo',
    extras: {
      numero_ley: '9.542',
      numero_gaceta: '220',
      fecha_publicacion: '2018-11-20',
    },
    sil_leyes: null,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// GOLDEN DATASET — 10 expedientes que NO son ley
// ─────────────────────────────────────────────────────────────────────────────

const noLeyExpedientes: ExpedienteForContext[] = [
  // 11. En comisión, sin sil_leyes, sin numero_ley (en trámite normal)
  {
    numero: '24.511',
    estado: 'En comisión',
    extras: {},
    sil_leyes: null,
  },
  // 12. Archivado explícito en extras
  {
    numero: '23.900',
    estado: 'Archivado',
    extras: {
      numero_archivado: 'A-2024-0115',
    },
    sil_leyes: null,
  },
  // 13. Desestimado
  {
    numero: '22.305',
    estado: 'Desestimado',
    extras: {},
    sil_leyes: null,
  },
  // 14. Estado=Vigente pero SIN fecha_publicacion y SIN sil_leyes
  //     (caso donde "Vigente" es engañoso — comisión vigente, no ley vigente)
  {
    numero: '24.100',
    estado: 'Vigente',
    extras: {},
    sil_leyes: null,
  },
  // 15. En plenario (debate avanzado pero aún no es ley)
  {
    numero: '24.200',
    estado: 'Plenario',
    extras: {},
    sil_leyes: null,
  },
  // 16. En trámite, es_ley=false explícito
  {
    numero: '23.450',
    estado: 'En comisión',
    es_ley: false,
    extras: {},
    sil_leyes: null,
  },
  // 17. Sin estado, sin indicadores (datos incompletos del scraper)
  {
    numero: '24.999',
    extras: {},
    sil_leyes: null,
  },
  // 18. Estado archivado vía campo (sin numero_archivado en extras)
  {
    numero: '21.700',
    estado: 'Archivado',
    extras: {},
    sil_leyes: null,
  },
  // 19. Número de acuerdo legislativo (acuerdo, NO ley)
  //     extras tiene numero_acuerdo pero no numero_ley
  {
    numero: '22.600',
    estado: 'Vigente',
    extras: {
      numero_acuerdo: 'ACUERDO-2023-001',
    },
    sil_leyes: null,
  },
  // 20. Es_ley=false explícito con estado=Vigente (dato contradictorio:
  //     el campo directo gana sobre el alias estado+gaceta, pero aquí
  //     no hay fecha_publicacion así que igual sería false)
  {
    numero: '23.750',
    estado: 'Vigente',
    es_ley: false,
    extras: {
      numero_gaceta: null,
      fecha_publicacion: null,
    },
    sil_leyes: null,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────────────

describe('buildExpedienteContext — es ley o no (KR4 Sprint 1)', () => {
  describe('Expedientes que SÍ son ley (10/10)', () => {
    it.each(leyExpedientes)(
      'Exp.$numero detectado como ES LEY',
      (exp) => {
        const ctx = buildExpedienteContext(exp);
        expect(ctx.es_ley).toBe(true);
        expect(ctx.numero).toBe(exp.numero);
        // Si hay razon, que no diga "En trámite" ni "archivado"
        expect(ctx.razon).not.toMatch(/En trámite|archivado|Archivado|Desestimado/);
      },
    );
  });

  describe('Expedientes que NO son ley (10/10)', () => {
    it.each(noLeyExpedientes)(
      'Exp.$numero detectado como NO ES LEY',
      (exp) => {
        const ctx = buildExpedienteContext(exp);
        expect(ctx.es_ley).toBe(false);
        expect(ctx.numero).toBe(exp.numero);
        // Si es archivado, que la razon lo indique y NO diga "es ley"
        if (exp.estado === 'Archivado' || exp.estado === 'Desestimado' || exp.extras?.numero_archivado) {
          expect(ctx.razon).toMatch(/archivado|Archivado|Desestimado/);
        }
        // En ningún caso debe haber datos de ley en ctx.ley
        expect(ctx.ley).toBeUndefined();
      },
    );
  });

  // Casos límite adicionales de regresión
  describe('Casos de regresión (bug Javier 2026-05-14)', () => {
    it('NO dice "aún no es ley" para expediente archivado — debe decir archivado', () => {
      const exp: ExpedienteForContext = {
        numero: '99.001',
        estado: 'Archivado',
        extras: { numero_archivado: 'A-2025-0001' },
        sil_leyes: null,
      };
      const ctx = buildExpedienteContext(exp);
      expect(ctx.es_ley).toBe(false);
      expect(ctx.razon).toMatch(/archivado/i);
    });

    it('SÍ detecta ley aunque el estado físico sea "En el archivo"', () => {
      // Un expediente puede estar en "el archivo físico" de la Asamblea
      // Y al mismo tiempo haber sido publicado como ley
      const exp: ExpedienteForContext = {
        numero: '99.002',
        estado: 'En el archivo',
        extras: { numero_ley: '10.999', numero_gaceta: '1' },
        sil_leyes: null,
      };
      const ctx = buildExpedienteContext(exp);
      expect(ctx.es_ley).toBe(true);
    });

    it('NO confunde Vigente sin gaceta con ley publicada', () => {
      // El alias "Vigente + fecha_publicacion" requiere fecha_publicacion
      const exp: ExpedienteForContext = {
        numero: '99.003',
        estado: 'Vigente',
        extras: {},
        sil_leyes: null,
      };
      const ctx = buildExpedienteContext(exp);
      expect(ctx.es_ley).toBe(false);
    });

    it('sil_leyes con solo numero_gaceta (sin numero_ley) cuenta como ley', () => {
      const exp: ExpedienteForContext = {
        numero: '99.004',
        estado: 'Vigente',
        extras: {},
        sil_leyes: { numero_gaceta: '100' },
      };
      const ctx = buildExpedienteContext(exp);
      expect(ctx.es_ley).toBe(true);
      expect(ctx.razon).toBe('sil_leyes row presente');
    });
  });
});
