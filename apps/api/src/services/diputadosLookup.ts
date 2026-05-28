/**
 * diputadosLookup — cross-reference de firmantes del SIL contra el
 * catálogo local de diputados.
 *
 * Por qué este módulo existe:
 *   El SIL serializa firmantes en `sil_expediente_proponentes` como
 *   apellidos sueltos en mayúsculas ("DELGADO RAMÍREZ", "VARGAS BRENES").
 *   No expone nombre, fracción ni provincia en ese endpoint. La tabla
 *   `diputados` (migration 0045) contiene el catálogo público de la
 *   Asamblea por cuatrienio — este servicio cruza apellidos +
 *   fecha_presentacion del expediente para devolver el match correcto.
 *
 * Cache:
 *   El catálogo de diputados cambia cada 4 años (un domingo de enero
 *   electoral). Cargamos todos en memoria al primer uso y refrescamos
 *   cada 24h. ~57 filas × 2 cuatrienios = 114 max, trivial en memoria.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface DiputadoMatch {
  apellidosCanonical: string;
  apellidosDisplay: string;
  nombre: string;
  nombreCompleto: string;
  fraccion: string;
  fraccionCorta: string;
  provincia: string;
}

interface CachedDiputado extends DiputadoMatch {
  periodoInicio: string;
  periodoFin: string;
}

let _cache: CachedDiputado[] | null = null;
let _cacheLoadedAt = 0;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function normalizeApellidos(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .trim();
}

async function loadCache(s: SupabaseClient): Promise<CachedDiputado[]> {
  if (_cache && Date.now() - _cacheLoadedAt < CACHE_TTL_MS) return _cache;

  const { data, error } = await s
    .from('diputados')
    .select('apellidos_canonical, apellidos_display, nombre, nombre_completo, fraccion, fraccion_corta, provincia, periodo_inicio, periodo_fin');
  if (error) {
    // Fallback defensivo: si la tabla no existe (no se aplicó migration),
    // devolvemos cache vacío. El call site va a recibir null y dejará
    // los campos como están.
    return [];
  }

  _cache = (data ?? []).map((r: Record<string, unknown>) => ({
    apellidosCanonical: r.apellidos_canonical as string,
    apellidosDisplay: r.apellidos_display as string,
    nombre: (r.nombre as string) ?? '',
    nombreCompleto: r.nombre_completo as string,
    fraccion: r.fraccion as string,
    fraccionCorta: r.fraccion_corta as string,
    provincia: r.provincia as string,
    periodoInicio: r.periodo_inicio as string,
    periodoFin: r.periodo_fin as string,
  }));
  _cacheLoadedAt = Date.now();
  return _cache;
}

/**
 * Busca un diputado por apellidos (normalizados) y fecha de expediente.
 *
 * Estrategia:
 *  1. Filtrar por apellidos_canonical exactos
 *  2. Si fecha provista, filtrar por periodo_inicio <= fecha < periodo_fin
 *  3. Si hay múltiples matches sin fecha, devolver el del cuatrienio más
 *     reciente (preferencia razonable para iniciativas in-flight)
 *  4. Si 0 matches o > 1 sin disambigüar → devolver null
 *
 * Retorna null silenciosamente — el caller decide qué hacer (típicamente
 * dejar `nombre` y `fraccion` como null y persistir solo apellidos).
 */
export async function findDiputado(
  s: SupabaseClient,
  apellidosFromSil: string,
  fechaPresentacion: string | null,
): Promise<DiputadoMatch | null> {
  if (!apellidosFromSil) return null;
  const target = normalizeApellidos(apellidosFromSil);

  // PODER no es un diputado — short-circuit.
  if (/^PODER( EJECUTIVO)?$/.test(target)) return null;

  const cache = await loadCache(s);
  const matches = cache.filter((d) => d.apellidosCanonical === target);
  if (matches.length === 0) return null;

  // Si tenemos fecha, filtramos por periodo
  if (fechaPresentacion) {
    const inPeriod = matches.filter(
      (d) => fechaPresentacion >= d.periodoInicio && fechaPresentacion < d.periodoFin,
    );
    if (inPeriod.length === 1) return inPeriod[0];
    if (inPeriod.length > 1) {
      // Empate raro — el más reciente gana (improbable salvo data corrupta).
      const sorted = [...inPeriod].sort((a, b) => b.periodoInicio.localeCompare(a.periodoInicio));
      return sorted[0];
    }
    // Fecha provista pero no hay matches en periodo → caemos al fallback
  }

  // Sin fecha o sin match en periodo: si hay un único match histórico, devolverlo.
  if (matches.length === 1) return matches[0];

  // Múltiples sin disambigüación → devolvemos el más reciente.
  const sorted = [...matches].sort((a, b) => b.periodoInicio.localeCompare(a.periodoInicio));
  return sorted[0];
}

/** Exposed for tests — clears the in-process cache. */
export function _resetDiputadosCache(): void {
  _cache = null;
  _cacheLoadedAt = 0;
}
