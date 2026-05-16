/**
 * PendingApprovalScreen — pantalla que ve un usuario nuevo que entró con
 * Google pero aún no fue aprobado por un admin de CL2 Consultoría.
 *
 * Diseño editorial Newsreader + Figtree, paleta CL2 (burgundy/ink),
 * sobre dark mesh igual que el login. Tono profesional, deja claro que
 * la cuenta se creó OK y que falta solo un paso del operador.
 */
import { LogOut, Mail, ShieldCheck } from 'lucide-react';

interface Props {
  email: string | null;
  onLogout: () => void;
}

export function PendingApprovalScreen({ email, onLogout }: Props) {
  return (
    <div className="min-h-screen bg-mesh flex items-center justify-center p-6">
      <div className="max-w-[480px] w-full">
        <div className="rounded-2xl border border-white/10 bg-[#0e1745]/40 backdrop-blur-sm shadow-2xl p-8 sm:p-10">
          {/* Brand mark */}
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

          {/* Headline */}
          <h1 className="font-display text-[28px] sm:text-[32px] font-normal leading-[1.1] tracking-tight text-white">
            Tu acceso está{' '}
            <span className="italic text-cl2-burgundy/95">pendiente de aprobación</span>.
          </h1>

          <p className="mt-4 text-[14px] leading-relaxed text-white/70">
            Tu cuenta quedó creada con éxito. Un administrador de CL2 Consultoría
            recibirá tu solicitud y activará tu acceso en cuanto pueda. Cuando
            esté listo te lo confirmaremos por correo.
          </p>

          {/* Email pill */}
          {email && (
            <div className="mt-6 inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[12.5px] text-white/75">
              <Mail size={13} className="text-cl2-burgundy/90" />
              <span className="font-mono">{email}</span>
            </div>
          )}

          {/* Reassurance card */}
          <div className="mt-6 flex items-start gap-3 rounded-xl border border-cl2-burgundy/15 bg-cl2-burgundy/[0.06] p-4">
            <ShieldCheck size={16} className="mt-0.5 shrink-0 text-cl2-burgundy/90" />
            <div className="text-[12px] leading-relaxed text-white/65">
              Esta restricción protege la confidencialidad del trabajo
              parlamentario. Solo cuentas verificadas por la firma acceden al
              sistema.
            </div>
          </div>

          {/* Logout */}
          <div className="mt-8 flex items-center justify-between gap-3 border-t border-white/[0.06] pt-5">
            <div className="text-[11.5px] text-white/45">
              ¿Querés usar otra cuenta?
            </div>
            <button
              type="button"
              onClick={onLogout}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[12.5px] font-medium text-white/80 hover:bg-white/[0.08] hover:text-white transition-colors"
            >
              <LogOut size={12} /> Cerrar sesión
            </button>
          </div>
        </div>

        {/* Footer */}
        <p className="mt-5 text-center text-[11px] text-white/40">
          ¿Necesitás ayuda urgente? Escribí a tu contacto en CL2 Consultoría.
        </p>
      </div>
    </div>
  );
}
