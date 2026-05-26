/**
 * silEstadoNormalizer — categoriza el campo `sil_expedientes.estado`.
 *
 * Audit Tier 2 C (2026-05-26): el SIL retorna en la columna "Estado" del
 * grid de listado uno de tres tipos de valor:
 *
 *   1. "ARCHIVO"   → el expediente está archivado (cerrado).
 *   2. "PLENARIO"  → el expediente está en debate en plenario.
 *   3. Nombre de comisión, ej. "JURIDICOS (ÁREA VII)" → está siendo
 *      tramitado en esa comisión.
 *
 * El bug histórico: el upsert guardó el VALOR LITERAL ("JURIDICOS (ÁREA VII)")
 * en `estado`, lo mismo que en `comision`. Resultado: cuando Lexa o un cron
 * filtra por `estado='en_comision'`, no encuentra nada — el dato existe
 * pero está representado con el string "real" en lugar de la categoría.
 *
 * Este módulo provee la traducción canonical:
 *   - "ARCHIVO" / vacío → 'archivo'
 *   - "PLENARIO" → 'plenario'
 *   - cualquier comisión / "(ÁREA …)" → 'en_comision'
 *   - resto / null / "" → null (no asumimos)
 *
 * NOTA: este NO es el "estado de tramitación" en el sentido de eventos
 * (aprobado_2do_debate, rechazado_dictamen). Esos viven en `centinela_eventos`.
 * Lo que normalizamos acá es estrictamente la "ubicación actual del trámite".
 */

export type SilEstadoCanonical = 'archivo' | 'plenario' | 'en_comision' | null;

/**
 * Heurística: nombres de comisión SIL tienen el patrón "<nombre> (ÁREA <romano>)"
 * o "<nombre> AREA <romano>" (sin acento). Como fallback secundario, cualquier
 * string que NO sea "ARCHIVO"/"PLENARIO"/vacío se asume comisión (las únicas
 * "ubicaciones" posibles del trámite son: archivo, plenario, o una comisión).
 */
const COMISION_PATTERN = /\(\s*[ÁA]REA\s+[IVX]+\s*\)/iu;

export function normalizeSilEstado(raw: string | null | undefined): SilEstadoCanonical {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === '') return null;

  const upper = trimmed.toUpperCase();
  if (upper === 'ARCHIVO' || upper === 'ARCHIVADO') return 'archivo';
  if (upper === 'PLENARIO') return 'plenario';

  // Si tiene "(ÁREA X)" es una comisión.
  if (COMISION_PATTERN.test(trimmed)) return 'en_comision';

  // Fallback: si no es de los 2 canonical y no matchea el patrón de comisión,
  // probable que sea texto residual de scraping. Devolver null en lugar de
  // forzar una categoría incorrecta.
  return null;
}

/**
 * Helper para SQL/JSONB: dado un string crudo, retorna el par
 * { estado: canonical, ubicacion_detalle: <string original si comisión> }.
 *
 * El detalle de comisión sigue viviendo en la columna `comision` que el
 * enricher rellena. Acá lo retornamos por conveniencia para callers que
 * quieran emitir un único bloque de metadata.
 */
export function categorizeSilEstado(raw: string | null | undefined): {
  estado: SilEstadoCanonical;
  ubicacion_detalle: string | null;
} {
  const estado = normalizeSilEstado(raw);
  const ubicacion_detalle = estado === 'en_comision' ? (raw ?? '').trim() : null;
  return { estado, ubicacion_detalle };
}
