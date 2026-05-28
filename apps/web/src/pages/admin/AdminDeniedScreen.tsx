/**
 * AdminDeniedScreen — pantalla que ve un usuario con role 'lector' o
 * 'editor' cuando intenta entrar a /admin/*. Cumple la promesa de
 * separación: los miembros del equipo del cliente tienen acceso a la
 * app pero NO al panel de administración.
 */
import { LogOut, ShieldOff } from 'lucide-react';
import { navigate } from '@/lib/router';

interface Props {
  // 2026-05-26 Ronald F1: incluido 'cliente' — usuario final de instituciones
  // que CL2 asesora. También bloqueado del admin panel.
  role: 'lector' | 'editor' | 'operador' | 'admin' | 'cliente' | null;
}

export function AdminDeniedScreen({ role }: Props) {
  return (
    <div className="min-h-screen bg-[#fbf7f1] flex items-center justify-center p-6">
      <div className="max-w-md w-full">
        <div className="rounded-2xl border border-[#0e1745]/[0.08] bg-white shadow-[0_8px_30px_rgba(14,23,69,0.06)] p-8">
          <div className="mb-5 flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-lg bg-cl2-burgundy/90 flex items-center justify-center text-white font-display text-[14px] italic">
              cl2
            </div>
            <div className="leading-none">
              <div className="font-display text-[14px] text-[#0e1745]">Cerebro Legislativo 2</div>
              <div className="text-[10px] uppercase tracking-[0.18em] text-[#0e1745]/45 mt-0.5">
                Panel de administración
              </div>
            </div>
          </div>

          <div className="flex items-start gap-3 mb-5">
            <ShieldOff size={22} className="mt-0.5 shrink-0 text-cl2-burgundy" />
            <div>
              <h1 className="font-display text-[22px] leading-tight text-[#0e1745]">
                El panel de administración es solo para administradores.
              </h1>
            </div>
          </div>

          <p className="text-[13.5px] leading-relaxed text-[#0e1745]/70 mb-5">
            Tu rol actual es <strong className="text-cl2-burgundy">{role ?? 'sin rol'}</strong>.
            Podés usar Lexa, Atlas, Centinela, los workspaces y todas las herramientas de
            consulta. La gestión del equipo, configuración y auditoría queda a cargo de
            los administradores de tu firma.
          </p>

          <div className="flex items-center justify-between gap-3 border-t border-[#0e1745]/[0.06] pt-5">
            <div className="text-[11.5px] text-[#0e1745]/55">
              ¿Pensás que es un error? Hablá con un admin.
            </div>
            <button
              type="button"
              onClick={() => navigate('/')}
              className="inline-flex items-center gap-1.5 rounded-lg bg-cl2-accent text-white font-semibold px-3.5 py-2 text-[12.5px] hover:bg-cl2-accent-hover transition-colors"
            >
              <LogOut size={12} className="rotate-180" /> Volver a la app
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
