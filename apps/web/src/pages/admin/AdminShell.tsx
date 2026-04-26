/**
 * Admin console shell — sticky sidebar + topbar + content area.
 *
 * Driven by `matchAdminSection(path)`. Each section is its own page
 * component lazy-mounted via `AdminApp`. Auth: any logged-in user can
 * reach the console today (small closed team during the demo). Tighten
 * once we open up to outside tenants — the audit log will record the
 * actor either way.
 *
 * Visual language follows the design package shipped 2026-04-26:
 * Newsreader for h1 only, Figtree everywhere else, fafafa background
 * with pixel-dot overlay, hairline ink borders, coral coral coral
 * reserved for the primary CTA per section.
 */
import { type ReactNode } from 'react';
import {
  LayoutDashboard,
  FileAudio,
  Bot,
  ShieldCheck,
  Radio,
  Folder,
  Users,
  ScrollText,
  Settings2,
  Search,
  Bell,
  BookOpen,
  type LucideIcon,
} from 'lucide-react';
import { navigate, type AdminSection } from '@/lib/router';
import { useSupabaseStore } from '@/store/useSupabaseStore';

interface NavItem {
  id: AdminSection;
  label: string;
  icon: LucideIcon;
  group: 'Operación' | 'Contenido' | 'Acceso & sistema';
  badge?: number | null;
}

const NAV: ReadonlyArray<NavItem> = [
  { id: 'overview',        label: 'Vista general',       icon: LayoutDashboard, group: 'Operación' },
  { id: 'transcripciones', label: 'Transcripciones',     icon: FileAudio,       group: 'Operación' },
  { id: 'agentes',         label: 'Agentes',             icon: Bot,             group: 'Operación' },
  { id: 'punto-medio',     label: 'Punto Medio',         icon: ShieldCheck,     group: 'Operación' },
  { id: 'sesiones',        label: 'Sesiones plenarias',  icon: Radio,           group: 'Contenido' },
  { id: 'expedientes',     label: 'Expedientes SIL',     icon: Folder,          group: 'Contenido' },
  { id: 'usuarios',        label: 'Usuarios',            icon: Users,           group: 'Acceso & sistema' },
  { id: 'auditoria',       label: 'Auditoría',           icon: ScrollText,      group: 'Acceso & sistema' },
  { id: 'config',          label: 'Configuración',       icon: Settings2,       group: 'Acceso & sistema' },
];

const SECTION_LABELS: Record<AdminSection, string> = NAV.reduce(
  (acc, n) => { acc[n.id] = n.label; return acc; },
  {} as Record<AdminSection, string>,
);

interface AdminShellProps {
  active: AdminSection;
  /** Optional badge counts loaded by the active section and surfaced in
   *  the sidebar. Keeps the sidebar dumb (no fetches of its own); each
   *  section that owns a queue passes its count here for global visibility. */
  badges?: Partial<Record<AdminSection, number>>;
  children: ReactNode;
}

export function AdminShell({ active, badges, children }: AdminShellProps) {
  const groups = Array.from(new Set(NAV.map((n) => n.group)));
  const user = useSupabaseStore((s) => s.user);
  const initials = (user?.email ?? 'OP').slice(0, 2).toUpperCase();
  const displayName = user?.email?.split('@')[0] ?? 'Operador';

  return (
    <div className="grid min-h-screen grid-cols-[256px_1fr] bg-[#fafafa] font-sans text-[#0e1745]">
      {/* Pixel-dot overlay */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0 opacity-70"
        style={{
          backgroundImage:
            'radial-gradient(circle, rgba(14,23,69,0.05) 1px, transparent 1px)',
          backgroundSize: '4px 4px',
        }}
      />

      {/* ─── Sidebar ───────────────────────────────────── */}
      <aside className="sticky top-0 z-10 flex h-screen flex-col gap-1 self-start overflow-y-auto border-r border-[#0e1745]/[0.06] bg-white/72 px-3.5 pt-4 pb-4 backdrop-blur-xl">
        <div className="mb-2.5 flex items-center gap-2.5 border-b border-[#0e1745]/[0.06] px-2 pb-4">
          <span
            className="relative flex h-8 w-8 items-center justify-center overflow-hidden rounded-lg text-[11px] font-extrabold tracking-tight text-white"
            style={{
              background: 'linear-gradient(135deg,#F93549 0%,#FF6877 100%)',
              boxShadow: '0 4px 14px rgba(249,53,73,0.22)',
            }}
          >
            CL2
            <span
              aria-hidden
              className="absolute inset-0 opacity-40"
              style={{
                backgroundImage:
                  'radial-gradient(circle, rgba(255,255,255,0.35) 1px, transparent 1px)',
                backgroundSize: '4px 4px',
              }}
            />
          </span>
          <div>
            <div className="text-[9.5px] font-semibold uppercase leading-none tracking-[0.16em] text-[#0e1745]/55">
              Admin · CL2
            </div>
            <div className="mt-[3px] font-display text-[17px] font-medium tracking-tight text-[#0e1745]">
              Consola
            </div>
          </div>
        </div>

        {groups.map((group) => (
          <div key={group}>
            <div className="px-2.5 pt-3.5 pb-1.5 text-[9.5px] font-bold uppercase tracking-[0.18em] text-[#0e1745]/40">
              {group}
            </div>
            {NAV.filter((n) => n.group === group).map((item) => {
              const Icon = item.icon;
              const isActive = active === item.id;
              const badge = badges?.[item.id];
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => navigate(`/admin/${item.id}`)}
                  className={`flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left text-[13px] tracking-[-0.005em] transition-colors duration-150 ${
                    isActive
                      ? 'border-[#0e1745]/[0.08] bg-white text-[#0e1745] shadow-[0_1px_2px_rgba(14,23,69,0.04)] font-semibold'
                      : 'border-transparent bg-transparent text-[#0e1745]/75 hover:bg-[#0e1745]/[0.04] hover:text-[#0e1745]'
                  }`}
                >
                  <Icon
                    size={15}
                    strokeWidth={1.75}
                    className={isActive ? 'text-[#F93549]' : 'text-[#0e1745]/50'}
                  />
                  <span className="flex-1 truncate">{item.label}</span>
                  {typeof badge === 'number' && badge > 0 && (
                    <span className="ml-auto rounded-full border border-[rgba(249,53,73,0.22)] bg-[rgba(249,53,73,0.10)] px-1.5 py-px text-[10.5px] font-semibold tabular-nums text-[#E11D48]">
                      {badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}

        <div className="mt-auto flex items-center gap-2.5 border-t border-[#0e1745]/[0.06] px-2 pt-3">
          <span
            className="inline-flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-bold text-white"
            style={{ background: 'linear-gradient(135deg,#7A3B47,#5d2935)' }}
          >
            {initials}
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-[12px] font-semibold text-[#0e1745]">
              {displayName}
            </span>
            <span className="text-[10.5px] text-[#0e1745]/50">Operador · Shiftlab</span>
          </div>
        </div>
      </aside>

      {/* ─── Main column ───────────────────────────────── */}
      <div className="relative z-[1] flex min-w-0 flex-col">
        <header className="sticky top-0 z-[4] flex items-center gap-3 border-b border-[#0e1745]/[0.06] bg-[#fafafa]/85 px-7 py-3.5 backdrop-blur-lg">
          <div className="flex items-center gap-2 text-[12px] tabular-nums text-[#0e1745]/50">
            <span>Admin</span>
            <span className="text-[#0e1745]/30">/</span>
            <span className="font-semibold text-[#0e1745]">{SECTION_LABELS[active]}</span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative w-80">
              <Search
                size={13}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[#0e1745]/40"
              />
              <input
                type="search"
                placeholder="Buscar usuario, sesión, expediente, ID…"
                className="w-full rounded-full border border-[#0e1745]/[0.08] bg-white py-2 pl-8 pr-3 text-[12.5px] text-[#0e1745] outline-none placeholder:text-[#0e1745]/40 focus:border-[rgba(249,53,73,0.35)] focus:ring-2 focus:ring-[rgba(249,53,73,0.10)]"
              />
            </div>
            <button
              type="button"
              title="Notificaciones"
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#0e1745]/[0.08] bg-white text-[#0e1745]/65 hover:bg-[#0e1745]/[0.04] hover:text-[#0e1745]"
            >
              <Bell size={14} />
            </button>
            <button
              type="button"
              title="Documentación"
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#0e1745]/[0.08] bg-white text-[#0e1745]/65 hover:bg-[#0e1745]/[0.04] hover:text-[#0e1745]"
            >
              <BookOpen size={14} />
            </button>
            <span className="ml-1 inline-flex items-center gap-1.5 rounded-full border border-[rgba(16,185,129,0.28)] bg-[rgba(16,185,129,0.10)] px-2 py-0.5 text-[10.5px] font-semibold text-[#047857]">
              <span className="inline-block h-[7px] w-[7px] rounded-full bg-[#10b981] shadow-[0_0_0_3px_rgba(16,185,129,0.14)]" />
              Sistemas en línea
            </span>
          </div>
        </header>

        <main className="relative w-full max-w-[1320px] mx-auto px-7 pt-7 pb-14">
          {children}
        </main>
      </div>
    </div>
  );
}

export { SECTION_LABELS };
