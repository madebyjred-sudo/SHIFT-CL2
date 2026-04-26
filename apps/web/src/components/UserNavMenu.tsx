import { useEffect, useRef, useState } from 'react';
import { Library, LogOut, Menu as MenuIcon, MessageSquare, Radio, ShieldCheck, X } from 'lucide-react';
import { MenuContainer, MenuItem } from './ui/fluid-menu';
import { useSupabaseStore } from '@/store/useSupabaseStore';

type View = 'chat' | 'live' | 'sil' | 'admin';

interface UserNavMenuProps {
  currentView?: View;
  onNavigate?: (view: View) => void;
}

function ProfileItem() {
  const { user, logout } = useSupabaseStore();
  const [isOpen, setIsOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [isOpen]);

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
    <div ref={popoverRef} className="w-full h-full">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen((v) => !v);
        }}
        className="w-full h-full rounded-full overflow-hidden flex items-center justify-center"
        title={displayName}
        aria-label={`Perfil de ${displayName}`}
      >
        {avatar ? (
          <img src={avatar} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-cl2-accent to-cl2-accent-hover flex items-center justify-center text-white text-[11px] font-semibold">
            {initials}
          </div>
        )}
      </button>

      {isOpen && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute right-full top-0 mr-3 w-64 bg-white dark:bg-[#2d2828] rounded-xl shadow-xl border border-gray-200 dark:border-white/10 py-2 z-[60]"
        >
          <div className="px-4 py-3 border-b border-gray-100 dark:border-white/10 flex items-center gap-3">
            {avatar ? (
              <img src={avatar} alt="" className="w-10 h-10 rounded-full" />
            ) : (
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-cl2-accent to-cl2-accent-hover flex items-center justify-center text-white text-sm font-semibold">
                {initials}
              </div>
            )}
            <div className="min-w-0">
              <p className="text-sm font-semibold text-[#0e1745] dark:text-white truncate">
                {displayName}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">
                {user.email}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              setIsOpen(false);
              logout();
            }}
            className="flex items-center gap-2 w-full px-4 py-2.5 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Cerrar sesión
          </button>
        </div>
      )}
    </div>
  );
}

export function UserNavMenu({ currentView = 'chat', onNavigate }: UserNavMenuProps) {
  const { user } = useSupabaseStore();
  if (!user) return null;

  return (
    <MenuContainer
      size={36}
      spacing={42}
      trigger={({ isExpanded }) => (
        <div className="relative w-5 h-5">
          <MenuIcon
            size={18}
            strokeWidth={1.75}
            className={`absolute inset-0 m-auto transition-all duration-200 ${
              isExpanded ? 'opacity-0 rotate-90' : 'opacity-100 rotate-0'
            }`}
          />
          <X
            size={18}
            strokeWidth={1.75}
            className={`absolute inset-0 m-auto transition-all duration-200 ${
              isExpanded ? 'opacity-100 rotate-0' : 'opacity-0 -rotate-90'
            }`}
          />
        </div>
      )}
    >
      <MenuItem
        ariaLabel="Chat"
        icon={<MessageSquare size={18} strokeWidth={1.75} />}
        isActive={currentView === 'chat'}
        onClick={() => onNavigate?.('chat')}
      />
      <MenuItem
        ariaLabel="Transcripción en Vivo"
        icon={<Radio size={18} strokeWidth={1.75} />}
        isActive={currentView === 'live'}
        onClick={() => onNavigate?.('live')}
      />
      <MenuItem
        ariaLabel="Catálogo SIL"
        icon={<Library size={18} strokeWidth={1.75} />}
        isActive={currentView === 'sil'}
        onClick={() => onNavigate?.('sil')}
      />
      <MenuItem
        ariaLabel="Admin · Consola"
        icon={<ShieldCheck size={18} strokeWidth={1.75} />}
        isActive={currentView === 'admin'}
        onClick={() => onNavigate?.('admin')}
      />
      <ProfileItem />
    </MenuContainer>
  );
}
