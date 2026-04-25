import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import type { User } from '@supabase/supabase-js';

interface SupabaseState {
  user: User | null;
  isAuthLoading: boolean;
  error: string | null;
  init: () => Promise<void>;
  signInGoogle: () => Promise<void>;
  logout: () => Promise<void>;
}

export const useSupabaseStore = create<SupabaseState>((set) => ({
  user: null,
  isAuthLoading: true,
  error: null,

  init: async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      set({ user: session?.user ?? null, isAuthLoading: false });

      supabase.auth.onAuthStateChange((_event, session) => {
        set({ user: session?.user ?? null });
      });
    } catch (error) {
      console.error('Auth init error:', error);
      set({ isAuthLoading: false });
    }
  },

  signInGoogle: async () => {
    set({ error: null });
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: `${window.location.origin}/auth/callback` },
      });
      if (error) throw error;
    } catch (error: any) {
      set({ error: error.message });
      throw error;
    }
  },

  logout: async () => {
    await supabase.auth.signOut();
    set({ user: null });
  },
}));
