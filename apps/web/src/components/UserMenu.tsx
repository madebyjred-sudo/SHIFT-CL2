import { useState, useRef, useEffect } from 'react';
import { LogOut, User } from 'lucide-react';
import { useSupabaseStore } from '@/store/useSupabaseStore';

export function UserMenu() {
  const { user, logout } = useSupabaseStore();
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setIsOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  if (!user) return null;

  const displayName =
    (user.user_metadata?.full_name as string | undefined) ||
    (user.user_metadata?.name as string | undefined) ||
    user.email ||
    'Usuario';

  const initials = displayName
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const avatar = user.user_metadata?.avatar_url as string | undefined;

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setIsOpen((v) => !v)}
        className="flex items-center gap-2 px-2 py-1.5 rounded-xl bg-white/70 dark:bg-white/5 hover:bg-white dark:hover:bg-white/10 transition-colors border border-white/70 dark:border-white/10"
        title={displayName}
      >
        {avatar ? (
          <img src={avatar} alt="" className="w-7 h-7 rounded-full" />
        ) : (
          <div className="w-7 h-7 rounded-full bg-gradient-to-br from-[#F93549] to-[#E11D48] flex items-center justify-center text-white text-xs font-semibold">
            {initials}
          </div>
        )}
        <span className="hidden sm:block text-sm font-medium text-[#0e1745] dark:text-white max-w-[140px] truncate">
          {displayName}
        </span>
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-64 bg-white dark:bg-[#2d2828] rounded-xl shadow-lg border border-gray-200 dark:border-white/10 py-2 z-50">
          <div className="px-4 py-3 border-b border-gray-100 dark:border-white/10">
            <p className="text-sm font-semibold text-[#0e1745] dark:text-white truncate">
              {displayName}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">{user.email}</p>
          </div>

          <button
            onClick={() => logout()}
            className="flex items-center gap-2 w-full px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Cerrar sesión
          </button>
        </div>
      )}
    </div>
  );
}
