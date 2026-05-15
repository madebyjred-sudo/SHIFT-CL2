/**
 * expedienteContext.ts — helper para determinar el estatus "es ley"
 * de un expediente legislativo de Costa Rica.
 *
 * Implementa la REGLA CRÍTICA documentada en el bug 2026-05-14:
 * Lexa decía "aún no es ley" sobre expedientes que SÍ eran ley.
 * Root cause: se miraba el campo `estado` (posición física) en vez de
 * los indicadores reales de ley (numero_ley en extras, o tabla sil_leyes).
 *
 * Esta lógica ES la fuente de verdad — openRouterClient la usa vía el
 * renderExpedienteFullForLlm y la suite de tests la valida 20/20.
 */

export interface SilLeyesRow {
  numero_gaceta?: string | null;
  numero_ley?: string | null;
  fecha_publicacion?: string | null;
  alcance?: string | null;
}

export interface ExpedienteForContext {
  numero: string;
  estado?: string | null;
  /** Campo booleano directo si existe en schema nuevo */
  es_ley?: boolean | null;
  /** Extras del web-scraper: contiene numero_ley, numero_archivado, etc. */
  extras?: {
    numero_ley?: string | null;
    numero_archivado?: string | null;
    fecha_publicacion?: string | null;
    numero_gaceta?: string | null;
    alcance?: string | null;
    [key: string]: unknown;
  } | null;
  /** Join con sil_leyes — presente si hay fila correspondiente */
  sil_leyes?: SilLeyesRow | null;
}

export interface ExpedienteContext {
  numero: string;
  es_ley: boolean;
  /**
   * Razón legible por humano — útil para debugging y tests.
   * Ej: "extras.numero_ley=10.428" | "sil_leyes row presente" | "estado=Vigente+gaceta" | "En trámite, sin sil_leyes" | "Archivado"
   */
  razon: string;
  /** Datos de la ley publicada, si aplica */
  ley?: {
    numero_ley?: string | null;
    numero_gaceta?: string | null;
    fecha_publicacion?: string | null;
    alcance?: string | null;
  };
}

/**
 * Determina si un expediente es ley y por qué.
 *
 * Reglas (en orden de prioridad):
 * 1. extras.numero_ley present → ES LEY (fuente: web-scraper SIL)
 * 2. sil_leyes row present → ES LEY (fuente: tabla sil_leyes)
 * 3. es_ley === true (campo directo) → ES LEY
 * 4. estado === 'Vigente' Y hay fecha_publicacion en extras → ES LEY (alias)
 * 5. estado === 'Archivado' o 'Desestimado' → NO es ley (fue archivado)
 * 6. Resto → NO es ley aún (en trámite)
 */
export function buildExpedienteContext(exp: ExpedienteForContext): ExpedienteContext {
  const extras = exp.extras ?? {};

  // Regla 1: numero_ley en extras → ES LEY
  if (extras.numero_ley) {
    return {
      numero: exp.numero,
      es_ley: true,
      razon: `extras.numero_ley=${extras.numero_ley}`,
      ley: {
        numero_ley: extras.numero_ley,
        numero_gaceta: extras.numero_gaceta ?? null,
        fecha_publicacion: extras.fecha_publicacion ?? null,
        alcance: extras.alcance ?? null,
      },
    };
  }

  // Regla 2: sil_leyes row present → ES LEY
  if (exp.sil_leyes) {
    return {
      numero: exp.numero,
      es_ley: true,
      razon: 'sil_leyes row presente',
      ley: {
        numero_ley: exp.sil_leyes.numero_ley ?? null,
        numero_gaceta: exp.sil_leyes.numero_gaceta ?? null,
        fecha_publicacion: exp.sil_leyes.fecha_publicacion ?? null,
        alcance: exp.sil_leyes.alcance ?? null,
      },
    };
  }

  // Regla 3: campo es_ley directo
  if (exp.es_ley === true) {
    return {
      numero: exp.numero,
      es_ley: true,
      razon: 'campo es_ley=true',
    };
  }

  // Regla 4: estado=Vigente + fecha_publicacion (alias operativo)
  const estado = (exp.estado ?? '').trim();
  if (estado === 'Vigente' && extras.fecha_publicacion) {
    return {
      numero: exp.numero,
      es_ley: true,
      razon: `estado=Vigente+fecha_publicacion=${extras.fecha_publicacion}`,
      ley: {
        numero_ley: extras.numero_ley ?? null,
        numero_gaceta: extras.numero_gaceta ?? null,
        fecha_publicacion: extras.fecha_publicacion,
        alcance: extras.alcance ?? null,
      },
    };
  }

  // Regla 5: archivado o desestimado → definitivamente no es ley
  if (estado === 'Archivado' || estado === 'Desestimado' || extras.numero_archivado) {
    return {
      numero: exp.numero,
      es_ley: false,
      razon: extras.numero_archivado
        ? `archivado, numero_archivado=${extras.numero_archivado}`
        : `estado=${estado}`,
    };
  }

  // Regla 6: todo lo demás es "en trámite, no es ley aún"
  return {
    numero: exp.numero,
    es_ley: false,
    razon: `En trámite (estado=${estado || 'desconocido'}), sin sil_leyes row`,
  };
}
