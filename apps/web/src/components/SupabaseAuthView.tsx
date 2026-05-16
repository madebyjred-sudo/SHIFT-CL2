import { motion } from 'motion/react';
import { Scale, FileText, Radar } from 'lucide-react';
import { useSupabaseStore } from '@/store/useSupabaseStore';
import { Cl2Mark } from './Cl2Mark';

/**
 * SupabaseAuthView — pantalla de login = landing principal de CL2.
 *
 * Diseño:
 *   • Light theme editorial (CL2 brand): fondo cream/papel, ink en
 *     tipografía, acento burgundy. Sin gradients dramáticos: la pantalla
 *     es la cara pública del producto, no un demo dramático.
 *   • Composición single-column centrada — el logo, el copy y el botón
 *     comparten el mismo eje vertical para que se lea como una columna
 *     editorial de revista.
 *   • Tipografía mixta: display (Newsreader serif italic) en el accent,
 *     sans-serif en el resto. Mismo sistema que /sesiones.
 *   • El botón coral se mantiene — es el único punto de acción y queremos
 *     que sea inequívoco.
 */
export function SupabaseAuthView() {
  const { signInGoogle, isAuthLoading, error } = useSupabaseStore();

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#fbf7f1] text-[#0e1745]">
      {/* Sutil halo burgundy en la esquina superior izquierda — apenas
          perceptible, da textura a la página sin competir con el contenido. */}
      <div
        className="absolute -top-32 -left-32 h-[440px] w-[440px] rounded-full opacity-[0.06] blur-3xl pointer-events-none"
        style={{ background: 'radial-gradient(circle, #7A3B47, transparent 70%)' }}
      />
      <div
        className="absolute bottom-0 right-0 h-[360px] w-[360px] rounded-full opacity-[0.05] blur-3xl pointer-events-none"
        style={{ background: 'radial-gradient(circle, #F93549, transparent 70%)' }}
      />

      <div className="relative min-h-screen flex items-center justify-center px-4">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
          className="max-w-md w-full flex flex-col items-center"
        >
          {/* Brand mark — centered, no glow halo on light theme */}
          <motion.div
            initial={{ scale: 0.85, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.1, type: 'spring', damping: 16 }}
            className="mb-7"
          >
            <Cl2Mark size={64} className="rounded-2xl shadow-lg shadow-cl2-burgundy/20" />
          </motion.div>

          {/* Headline editorial */}
          <div className="text-center mb-10">
            <h1 className="font-display text-[40px] sm:text-[44px] font-normal leading-[1.05] tracking-tight">
              <span className="italic text-cl2-burgundy/90">Inteligencia</span>
              <br />
              <span>Legislativa</span>
            </h1>
            <p className="mt-3 text-[12.5px] uppercase tracking-[0.22em] text-[#0e1745]/55">
              Consultoría estratégica · CL2
            </p>
          </div>

          {/* Card de login */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.25, duration: 0.5 }}
            className="w-full rounded-2xl border border-[#0e1745]/[0.08] bg-white shadow-[0_8px_30px_rgba(14,23,69,0.06)] p-6 space-y-5"
          >
            {/* Tres agentes — chips suaves */}
            <div className="flex items-center justify-between text-[#0e1745]/65">
              <AgentMini icon={<Scale className="h-3.5 w-3.5" />} name="Lexa" color="#7A3B47" />
              <AgentMini icon={<FileText className="h-3.5 w-3.5" />} name="Atlas" color="#8B6E54" />
              <AgentMini icon={<Radar className="h-3.5 w-3.5" />} name="Centinela" color="#F93549" />
            </div>

            <div className="border-t border-[#0e1745]/[0.06]" />

            <p className="text-[13px] leading-relaxed text-[#0e1745]/70">
              Iniciá sesión con tu cuenta de Google. Si es la primera vez, tu
              acceso quedará pendiente de aprobación por la firma.
            </p>

            {error && (
              <div className="text-rose-700 text-[11.5px] bg-rose-500/[0.08] border border-rose-500/20 rounded-lg p-2.5">
                {error}
              </div>
            )}

            <button
              onClick={() => signInGoogle()}
              disabled={isAuthLoading}
              className="w-full rounded-xl bg-gradient-to-br from-cl2-accent to-cl2-accent-hover text-white font-semibold py-3 hover:shadow-[0_8px_24px_rgba(249,53,73,0.28)] hover:brightness-105 transition-all disabled:opacity-50 flex items-center justify-center gap-3"
            >
              <GoogleIcon />
              Continuar con Google
            </button>
          </motion.div>

          <p className="mt-6 text-[10px] uppercase tracking-[0.24em] text-[#0e1745]/35">
            Cerebro Legislativo 2.0 · Costa Rica
          </p>
        </motion.div>
      </div>
    </div>
  );
}

function AgentMini({ icon, name, color }: { icon: React.ReactNode; name: string; color: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <div
        className="h-6 w-6 rounded-md flex items-center justify-center text-white"
        style={{ backgroundColor: color }}
      >
        {icon}
      </div>
      <span className="text-[11.5px] font-medium text-[#0e1745]/80">{name}</span>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24">
      <path
        fill="currentColor"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="currentColor"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A10.99 10.99 0 0 0 12 23z"
      />
      <path
        fill="currentColor"
        d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.07H2.18A10.99 10.99 0 0 0 1 12c0 1.77.43 3.45 1.18 4.93l3.66-2.83z"
      />
      <path
        fill="currentColor"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A10.99 10.99 0 0 0 2.18 7.07l3.66 2.83C6.71 7.31 9.14 5.38 12 5.38z"
      />
    </svg>
  );
}
