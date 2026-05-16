import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

/**
 * AuthCallback — handler del retorno del OAuth (Google → Supabase).
 *
 * Supabase v2 usa PKCE flow por default desde ~v2.40 — el callback llega
 * con `?code=<authcode>&state=<state>` en el query, no con `#access_token=`
 * en el hash. La forma correcta de procesarlo es:
 *   1. Leer `code` de URLSearchParams
 *   2. Llamar supabase.auth.exchangeCodeForSession(code)
 *   3. Eso persiste la session a localStorage + emite SIGNED_IN
 *
 * Si no hay code en URL pero ya hay session persistida (e.g. user navegó
 * por history a /auth/callback estando logueado), redirigimos directo.
 *
 * Errores manejados:
 *   - `?error=...` en query/hash → Google/Supabase rechazó el flow
 *   - exchangeCodeForSession falla → muestra error con CTA volver
 *   - timeout 12s → asumimos algo cuelga, mostramos error
 */
export function AuthCallback() {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let done = false;
    const completeAuth = () => {
      if (done) return;
      done = true;
      window.history.replaceState({}, '', '/');
      window.location.reload();
    };

    const fail = (msg: string) => {
      if (done) return;
      done = true;
      // eslint-disable-next-line no-console
      console.error('[AuthCallback] fail:', msg);
      setErrorMessage(msg);
    };

    // Timeout de protección: si pasan 12s sin completar, mostramos error.
    const timeoutId = window.setTimeout(() => {
      fail('No pudimos completar el inicio de sesión. Intentá nuevamente.');
    }, 12000);

    // Detectar si vino con error de Google/Supabase en query o hash
    const urlParams = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    const errParam =
      urlParams.get('error') ?? hashParams.get('error') ?? null;
    const errDesc =
      urlParams.get('error_description') ?? hashParams.get('error_description') ?? null;
    if (errParam) {
      window.clearTimeout(timeoutId);
      fail(
        errDesc
          ? decodeURIComponent(errDesc).replace(/\+/g, ' ')
          : `Error de autenticación: ${errParam}`,
      );
      return;
    }

    (async () => {
      try {
        // PKCE flow — Supabase devuelve `?code=<authcode>&state=<state>`
        const code = urlParams.get('code');
        if (code) {
          const { data, error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) {
            window.clearTimeout(timeoutId);
            fail(`No pudimos completar el login: ${error.message}`);
            return;
          }
          if (data?.session) {
            window.clearTimeout(timeoutId);
            completeAuth();
            return;
          }
        }

        // Implicit flow fallback — `#access_token=...` en hash. Supabase lo
        // detecta automáticamente vía detectSessionInUrl al construir el
        // cliente, así que basta con consultar session.
        const { data: { session } } = await supabase.auth.getSession();
        if (session) {
          window.clearTimeout(timeoutId);
          completeAuth();
          return;
        }

        // Última opción — escuchar el evento por si está por dispararse.
        const { data: sub } = supabase.auth.onAuthStateChange((event, sess) => {
          if (event === 'SIGNED_IN' && sess) {
            window.clearTimeout(timeoutId);
            sub.subscription.unsubscribe();
            completeAuth();
          }
        });
      } catch (err) {
        window.clearTimeout(timeoutId);
        fail(`Error inesperado: ${(err as Error).message}`);
      }
    })();

    return () => {
      done = true;
      window.clearTimeout(timeoutId);
    };
  }, []);

  if (errorMessage) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#fbf7f1] text-[#0e1745] p-6">
        <div className="max-w-md w-full text-center">
          <div className="text-[14px] mb-4 text-rose-700 leading-relaxed">{errorMessage}</div>
          <button
            type="button"
            onClick={() => {
              window.history.replaceState({}, '', '/');
              window.location.reload();
            }}
            className="rounded-xl bg-gradient-to-br from-cl2-accent to-cl2-accent-hover text-white font-semibold px-5 py-2.5"
          >
            Volver a intentar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#fbf7f1] text-[#0e1745]">
      <div className="flex flex-col items-center gap-3">
        <div className="h-10 w-10 rounded-full border-2 border-[#0e1745]/15 border-t-cl2-burgundy animate-spin" />
        <p className="text-[13px] text-[#0e1745]/60">Autenticando…</p>
      </div>
    </div>
  );
}
