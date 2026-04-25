import { useEffect } from 'react';
import { supabase } from '@/lib/supabase';

export function AuthCallback() {
  useEffect(() => {
    supabase.auth.getSession().then(() => {
      window.history.replaceState({}, '', '/');
      window.location.reload();
    });
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-mesh text-white">
      <div className="flex flex-col items-center gap-3">
        <div className="h-10 w-10 rounded-full border-2 border-white/20 border-t-white animate-spin" />
        <p className="text-sm text-white/60">Autenticando…</p>
      </div>
    </div>
  );
}
