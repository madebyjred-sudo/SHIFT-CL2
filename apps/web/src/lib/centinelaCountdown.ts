/**
 * centinelaCountdown.ts
 *
 * Centinela está temporalmente fuera de servicio (en refactor del flow
 * detector → notifier → alerts y migración del schema dual v1/v2). El
 * resto de la herramienta sigue funcionando. Las superficies de UI que
 * exponen Centinela muestran un overlay con la fecha de regreso.
 *
 * Fecha objetivo: viernes 29 de mayo de 2026 (decisión 2026-05-24).
 *
 * Cuando llega la fecha objetivo o pasa, `isCentinelaLocked()` devuelve
 * `false` y todo vuelve a funcionar normal. Para extender el período
 * mover la constante `CENTINELA_RELAUNCH_AT` sin tocar nada más.
 */

// Fecha objetivo de regreso de Centinela. Hora local CR (mediodía) para
// evitar bugs de timezone — si lo dejamos a las 00:00 UTC se interpreta
// como el día anterior en CR.
export const CENTINELA_RELAUNCH_AT = new Date('2026-05-29T12:00:00-06:00');

/**
 * Días restantes hasta el regreso de Centinela. Devuelve 0 si ya llegó
 * o pasó la fecha objetivo. Redondea hacia arriba para que "1 día"
 * signifique "antes de mañana terminando", no "menos de 24 horas".
 */
export function daysUntilCentinelaRelaunch(now: Date = new Date()): number {
  const ms = CENTINELA_RELAUNCH_AT.getTime() - now.getTime();
  if (ms <= 0) return 0;
  return Math.ceil(ms / 86_400_000);
}

/**
 * Si Centinela debe estar bloqueado hoy (true) o si ya volvió (false).
 * Toda la UI de Centinela debe consultar esto antes de renderizar.
 */
export function isCentinelaLocked(now: Date = new Date()): boolean {
  return now.getTime() < CENTINELA_RELAUNCH_AT.getTime();
}

/**
 * Etiqueta humana del regreso (ej. "viernes 29 de mayo"). Cuelga del
 * countdown — si cambiamos la fecha cambia automáticamente.
 */
export function relaunchLabel(): string {
  return CENTINELA_RELAUNCH_AT.toLocaleDateString('es-CR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}
