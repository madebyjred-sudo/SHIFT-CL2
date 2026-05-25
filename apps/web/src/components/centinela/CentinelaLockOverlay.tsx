/**
 * CentinelaLockOverlay — bloqueo temporal de las superficies de Centinela.
 *
 * Mientras Centinela está en refactor (ver lib/centinelaCountdown.ts),
 * cualquier ruta o componente Centinela-related se envuelve con este
 * overlay. El contenido sigue debajo (el usuario puede percibir vagamente
 * que algo hay) pero queda no-interactivo, blureado, y encima aparece la
 * tarjeta con el contador.
 *
 * Uso:
 *
 *   <CentinelaLockOverlay>
 *     {todo-el-contenido-de-la-pagina}
 *   </CentinelaLockOverlay>
 *
 * Cuando isCentinelaLocked() vuelva a false (fecha de regreso pasada),
 * el overlay se vuelve no-op y deja pasar el contenido normal.
 */

import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';
import {
  daysUntilCentinelaRelaunch,
  isCentinelaLocked,
  relaunchLabel,
} from '@/lib/centinelaCountdown';
import { TopDock } from '@/components/top-dock';

interface Props {
  children: ReactNode;
  /**
   * Si se pasa, reemplaza el copy del cuerpo por algo más específico
   * (ej. en el strip de home queremos un mensaje más corto). Default:
   * el copy estándar.
   */
  bodyCopy?: string;
}

export function CentinelaLockOverlay({ children, bodyCopy }: Props) {
  if (!isCentinelaLocked()) return <>{children}</>;

  const days = daysUntilCentinelaRelaunch();
  const dayWord = days === 1 ? 'día' : 'días';

  const defaultBody =
    'Estamos refinando el motor de alertas y el flujo de detección. El resto de la herramienta sigue funcionando normalmente — expedientes, sesiones, búsqueda con Lexa y Atlas, todo en línea.';

  return (
    <div className="relative">
      {/* Contenido original — visible pero blureado e inerte */}
      <div
        aria-hidden
        className="pointer-events-none select-none blur-sm opacity-40"
      >
        {children}
      </div>

      {/* Tarjeta encima */}
      <div className="absolute inset-0 flex items-start justify-center pt-24 px-6 z-10">
        <div className="max-w-md w-full bg-white dark:bg-[#1a1a1a] border border-[#0e1745]/10 dark:border-white/10 rounded-xl shadow-xl p-8 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-[#7A2538]/10 text-[#7A2538] mb-5">
            <Lock className="w-5 h-5" />
          </div>

          <div className="text-[10px] uppercase tracking-[0.18em] text-[#0e1745]/55 dark:text-white/55 mb-2">
            Centinela
          </div>

          <h2 className="font-serif text-[26px] leading-tight text-[#0e1745] dark:text-white mb-3">
            Vuelve el {relaunchLabel()}
          </h2>

          <div className="text-[15px] text-[#0e1745]/75 dark:text-white/75 mb-5">
            En {days} {dayWord}
          </div>

          <p className="text-[13px] leading-relaxed text-[#0e1745]/65 dark:text-white/65">
            {bodyCopy ?? defaultBody}
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Página completa de aterrizaje cuando el usuario navega a una ruta
 * Centinela (`/centinela`, `/alertas`, `/matriz-cliente`) durante el lock.
 * Monta sólo el TopDock + la tarjeta del countdown, sin tocar la página
 * real (que ni siquiera se importa) — así ahorramos los fetches a la API
 * de Centinela mientras dura el refactor.
 */
export function CentinelaLockedRoute() {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-[#0a0a0a] flex flex-col">
      <TopDock />
      <main className="flex-1 flex items-start justify-center pt-24 px-6">
        <div className="max-w-md w-full bg-white dark:bg-[#1a1a1a] border border-[#0e1745]/10 dark:border-white/10 rounded-xl shadow-xl p-8 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-[#7A2538]/10 text-[#7A2538] mb-5">
            <Lock className="w-5 h-5" />
          </div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-[#0e1745]/55 dark:text-white/55 mb-2">
            Centinela
          </div>
          <h2 className="font-serif text-[26px] leading-tight text-[#0e1745] dark:text-white mb-3">
            Vuelve el {relaunchLabel()}
          </h2>
          <div className="text-[15px] text-[#0e1745]/75 dark:text-white/75 mb-5">
            En {daysUntilCentinelaRelaunch()}{' '}
            {daysUntilCentinelaRelaunch() === 1 ? 'día' : 'días'}
          </div>
          <p className="text-[13px] leading-relaxed text-[#0e1745]/65 dark:text-white/65">
            Estamos refinando el motor de alertas y el flujo de detección.
            El resto de la herramienta sigue funcionando normalmente —
            expedientes, sesiones, búsqueda con Lexa y Atlas, todo en línea.
          </p>
        </div>
      </main>
    </div>
  );
}

/**
 * Variante compacta para el strip del home (~80px de alto). Reemplaza
 * todo el strip mientras Centinela está bloqueado.
 */
export function CentinelaLockStrip() {
  if (!isCentinelaLocked()) return null;

  const days = daysUntilCentinelaRelaunch();
  const dayWord = days === 1 ? 'día' : 'días';

  return (
    <div className="w-full max-w-2xl mx-auto mt-6 px-6 py-4 rounded-lg border border-[#0e1745]/10 dark:border-white/10 bg-white/60 dark:bg-white/5 backdrop-blur-sm flex items-center gap-3">
      <div className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-[#7A2538]/10 text-[#7A2538] shrink-0">
        <Lock className="w-3.5 h-3.5" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[11px] uppercase tracking-[0.16em] text-[#0e1745]/55 dark:text-white/55">
          Centinela
        </div>
        <div className="text-[13px] text-[#0e1745]/85 dark:text-white/85">
          Vuelve el {relaunchLabel()} · en {days} {dayWord}
        </div>
      </div>
    </div>
  );
}
