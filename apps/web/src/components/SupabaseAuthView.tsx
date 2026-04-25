import { motion } from 'motion/react';
import { Scale, FileText, Radar } from 'lucide-react';
import { useSupabaseStore } from '@/store/useSupabaseStore';

export function SupabaseAuthView() {
  const { signInGoogle, isAuthLoading, error } = useSupabaseStore();

  return (
    <div className="relative min-h-screen overflow-hidden bg-mesh text-white">
      <div
        className="absolute -top-40 -left-40 h-[500px] w-[500px] rounded-full opacity-30 blur-3xl pointer-events-none"
        style={{ background: 'radial-gradient(circle, rgb(244 63 94 / 0.5), transparent 70%)' }}
      />
      <div
        className="absolute bottom-0 right-0 h-[400px] w-[400px] rounded-full opacity-20 blur-3xl pointer-events-none"
        style={{ background: 'radial-gradient(circle, rgb(37 99 235 / 0.5), transparent 70%)' }}
      />

      <div className="relative min-h-screen flex items-center justify-center px-4">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
          className="max-w-md w-full"
        >
          <div className="text-center space-y-4 mb-10">
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.1, type: 'spring', damping: 14 }}
              className="mx-auto h-16 w-16 rounded-2xl relative overflow-hidden"
              style={{ boxShadow: '0 0 40px rgba(244, 63, 94, 0.3)' }}
            >
              <div className="absolute inset-0 bg-gradient-to-br from-cl2-accent to-cl2-accent-soft" />
              <div
                className="absolute inset-0 opacity-30"
                style={{
                  backgroundImage:
                    'radial-gradient(circle, rgba(255,255,255,0.4) 1px, transparent 1px)',
                  backgroundSize: '5px 5px',
                }}
              />
              <div className="relative h-full w-full flex items-center justify-center text-white font-extrabold text-xl font-heading">
                CL2
              </div>
            </motion.div>

            <div className="space-y-1">
              <h1 className="text-3xl font-extrabold tracking-tight font-heading">
                <span className="bg-gradient-to-r from-cl2-accent to-cl2-accent-soft bg-clip-text text-transparent">
                  Inteligencia
                </span>
                <br />
                <span>Legislativa</span>
              </h1>
              <p className="text-white/60 text-sm">Asamblea Legislativa de Costa Rica</p>
            </div>
          </div>

          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.25, duration: 0.5 }}
            className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl p-6 space-y-5"
          >
            <div className="flex items-center justify-between text-white/60">
              <AgentMini icon={<Scale className="h-4 w-4" />} name="Lexa" color="var(--color-cl2-burgundy)" />
              <AgentMini icon={<FileText className="h-4 w-4" />} name="Atlas" color="#8B6E54" />
              <AgentMini icon={<Radar className="h-4 w-4" />} name="Centinela" color="#F43F5E" />
            </div>

            <div className="border-t border-white/10" />

            <p className="text-white/60 text-sm leading-relaxed">
              Acceso restringido. Iniciá sesión con una cuenta autorizada para consultar actas,
              mociones y transcripciones.
            </p>

            {error && (
              <div className="text-red-400 text-xs bg-red-500/10 border border-red-500/20 rounded-lg p-2">
                {error}
              </div>
            )}

            <button
              onClick={() => signInGoogle()}
              disabled={isAuthLoading}
              className="w-full rounded-xl bg-gradient-to-br from-cl2-accent to-cl2-accent-hover text-white font-semibold py-3 hover:shadow-[0_0_30px_rgba(244,63,94,0.4)] transition-shadow disabled:opacity-50 flex items-center justify-center gap-3"
            >
              <GoogleIcon />
              Continuar con Google
            </button>
          </motion.div>

          <p className="text-center text-[10px] uppercase tracking-widest text-white/30 mt-6">
            Cerebro Legislativo 2.0 · Costa Rica
          </p>
        </motion.div>
      </div>
    </div>
  );
}

function AgentMini({ icon, name, color }: { icon: React.ReactNode; name: string; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <div
        className="h-7 w-7 rounded-lg flex items-center justify-center text-white"
        style={{ backgroundColor: color, boxShadow: `0 0 16px ${color}40` }}
      >
        {icon}
      </div>
      <span className="text-xs font-medium text-white/80">{name}</span>
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
