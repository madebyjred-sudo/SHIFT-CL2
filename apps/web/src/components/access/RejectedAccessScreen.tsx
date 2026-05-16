/**
 * RejectedAccessScreen — usuarios marcados como rechazados o suspendidos
 * por el admin. Igual layout que pending pero con copy explícita y sin
 * tono de "estamos procesando".
 */
import { LogOut, ShieldAlert } from 'lucide-react';

interface Props {
  kind: 'rejected' | 'suspended';
  email: string | null;
  onLogout: () => void;
}

export function RejectedAccessScreen({ kind, email, onLogout }: Props) {
  const copy =
    kind === 'rejected'
      ? {
          headline: 'No tenés acceso a este sistema',
          body:
            'Un administrador de CL2 Consultoría revisó tu solicitud y decidió no activarla. Si creés que se trata de un error, comunicate con tu contacto en la firma.',
        }
      : {
          headline: 'Tu acceso fue suspendido temporalmente',
          body:
            'Un administrador suspendió tu cuenta. Esto suele ser temporal — comunicate con la firma para reactivarla.',
        };

  return (
    <div className="min-h-screen bg-mesh flex items-center justify-center p-6">
      <div className="max-w-[480px] w-full">
        <div className="rounded-2xl border border-white/10 bg-[#0e1745]/40 backdrop-blur-sm shadow-2xl p-8 sm:p-10">
          <div className="mb-6 flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-lg bg-cl2-burgundy/90 flex items-center justify-center text-white font-display text-[15px] font-medium">
              cl2
            </div>
            <div className="leading-none">
              <div className="font-display text-[15px] text-white">Cerebro Legislativo 2</div>
              <div className="text-[10.5px] uppercase tracking-[0.18em] text-white/45 mt-0.5">
                CL2 Consultoría
              </div>
            </div>
          </div>

          <h1 className="font-display text-[28px] sm:text-[32px] font-normal leading-[1.1] tracking-tight text-white">
            {copy.headline}.
          </h1>

          <p className="mt-4 text-[14px] leading-relaxed text-white/70">{copy.body}</p>

          {email && (
            <div className="mt-6 inline-flex items-center gap-2 rounded-lg border border-rose-500/20 bg-rose-500/[0.06] px-3 py-2 text-[12.5px] text-rose-200/85">
              <ShieldAlert size={13} className="text-rose-300" />
              <span className="font-mono">{email}</span>
            </div>
          )}

          <div className="mt-8 flex items-center justify-end gap-3 border-t border-white/[0.06] pt-5">
            <button
              type="button"
              onClick={onLogout}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[12.5px] font-medium text-white/80 hover:bg-white/[0.08] hover:text-white transition-colors"
            >
              <LogOut size={12} /> Cerrar sesión
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
