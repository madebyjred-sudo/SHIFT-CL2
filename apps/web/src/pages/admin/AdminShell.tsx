/**
 * Admin shell — same chrome as the rest of the CL2 webapp.
 *
 * Reuses TopDock (so brand, history, theme toggle, profile menu live in
 * the exact same place as in the chat) and renders inside the same
 * `rounded-t-2xl` card pattern. Section nav is a compact left rail
 * INSIDE the card — not a separate sidebar — so the visual unit reads
 * as "one app with admin mode" instead of "two apps".
 *
 * Visual tokens are the real ones:
 *   bg-gray-50 / dark:bg-mesh        — page bg
 *   bg-white  / dark:bg-white/[0.02] — surfaces
 *   border-[#0e1745]/[0.06]
 *   dark:border-white/[0.06]         — hairlines
 *   text-[#0e1745] / dark:text-white — text
 *
 * Auth is enforced upstream (App.tsx). When we open up to outside
 * tenants, gate the rail entries by role here.
 */
import { useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  LayoutDashboard,
  FileAudio,
  Bot,
  ShieldCheck,
  Radio,
  Folder,
  Headphones,
  MessageSquareWarning,
  Users,
  ScrollText,
  Settings2,
  Youtube,
  type LucideIcon,
} from 'lucide-react';
import { TopDock } from '@/components/top-dock';
import { Sidebar } from '@/components/sidebar';
import { navigate, type AdminSection } from '@/lib/router';
import { cn } from '@/lib/utils';

interface NavItem {
  id: AdminSection;
  label: string;
  icon: LucideIcon;
  group: 'Operación' | 'Contenido' | 'Acceso & sistema';
}

// Limpieza 2026-05-10 (post-audit):
//   • Eliminados del rail:
//       - 'transcripciones' (legacy CL2 worker MariaDB — duplicado, data muerta)
//       - 'curaduria' (PuntoMedio — Cerebro Railway 404, sección zombie)
//       - 'config' (modelos duplican Agentes, rate limits hardcoded, build info vacío)
//   • Lo que queda son las 8 secciones con data real y CTAs funcionales.
const NAV: ReadonlyArray<NavItem> = [
  { id: 'overview',        label: 'Vista general',       icon: LayoutDashboard, group: 'Operación' },
  { id: 'transcripts',     label: 'Cola de revisión',    icon: Youtube,         group: 'Operación' },
  { id: 'agentes',         label: 'Agentes',             icon: Bot,             group: 'Operación' },
  { id: 'feedback',        label: 'Feedback · Bugs',     icon: MessageSquareWarning, group: 'Operación' },
  { id: 'sesiones',        label: 'Sesiones plenarias',  icon: Radio,           group: 'Contenido' },
  { id: 'expedientes',     label: 'Expedientes SIL',     icon: Folder,          group: 'Contenido' },
  { id: 'podcasts',        label: 'Podcasts',            icon: Headphones,      group: 'Contenido' },
  { id: 'usuarios',        label: 'Usuarios',            icon: Users,           group: 'Acceso & sistema' },
  { id: 'auditoria',       label: 'Auditoría',           icon: ScrollText,      group: 'Acceso & sistema' },
];

interface AdminShellProps {
  active: AdminSection;
  /** Optional badge counts surfaced in the rail. */
  badges?: Partial<Record<AdminSection, number>>;
  children: ReactNode;
}

export function AdminShell({ active, badges, children }: AdminShellProps) {
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isMobileDrawerOpen, setIsMobileDrawerOpen] = useState(false);
  const groups = Array.from(new Set(NAV.map((n) => n.group)));

  return (
    <div className="h-screen flex flex-col bg-gray-50 dark:bg-mesh text-gray-900 dark:text-white font-sans relative overflow-hidden transition-colors duration-500">
      {/* Same overlay as chat */}
      <div className="pointer-events-none absolute inset-0 bg-pixel-dots opacity-60 z-0" />

      <TopDock
        onOpenHistory={() => setIsMobileDrawerOpen(true)}
        onToggleHistory={() => setIsHistoryOpen((v) => !v)}
        isHistoryOpen={isHistoryOpen}
      />

      <main className="relative z-20 flex-1 min-h-0 flex gap-0 px-4 sm:px-5 md:px-6 pt-3 md:pt-4">
        {/* Optional left history drawer (chat parity — kept for muscle memory) */}
        <div
          className={cn(
            'hidden lg:flex flex-col min-h-0 transition-all duration-500 ease-out overflow-hidden shrink-0',
            isHistoryOpen ? 'w-[280px] opacity-100 mr-6' : 'w-0 opacity-0 mr-0',
          )}
        >
          <Sidebar variant="panel" side="left" />
        </div>

        {/* The same rounded-t-2xl card as chat — one app, admin mode inside. */}
        <section className="flex-1 min-h-0 min-w-0 grid grid-cols-1 md:grid-cols-[220px_1fr] border border-b-0 border-[#0e1745]/[0.06] dark:border-white/[0.04] rounded-t-2xl shadow-[0_4px_20px_rgba(14,23,69,0.04)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.12)] bg-white dark:bg-white/[0.02] overflow-hidden">
          {/* Section nav rail */}
          <aside className="hidden md:flex flex-col gap-0.5 border-r border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white/60 dark:bg-white/[0.015] backdrop-blur-sm px-3 py-4 overflow-y-auto">
            {/* Botón volver — pedido cliente 2026-05-22 */}
            <button
              type="button"
              onClick={() => (window.location.href = '/')}
              className="mx-2 mb-2 inline-flex items-center gap-1.5 text-[11px] text-[#0e1745]/55 dark:text-white/55 hover:text-[#0e1745] dark:hover:text-white transition-colors"
              aria-label="Volver al chat"
            >
              <ArrowLeft className="w-3 h-3" />
              Volver al chat
            </button>
            <div className="px-2 pb-3 mb-1 border-b border-[#0e1745]/[0.06] dark:border-white/[0.06]">
              <div className="text-[9.5px] font-semibold uppercase tracking-[0.18em] text-[#0e1745]/45 dark:text-white/45">
                Admin · CL2
              </div>
              <div className="font-display text-[15px] font-medium tracking-tight text-[#0e1745] dark:text-white mt-0.5">
                Consola
              </div>
            </div>

            {groups.map((group) => (
              <div key={group}>
                <div className="px-2 pt-3 pb-1 text-[9.5px] font-bold uppercase tracking-[0.18em] text-[#0e1745]/40 dark:text-white/40">
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
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left text-[12.5px] tracking-[-0.005em] transition-colors duration-150',
                        isActive
                          ? 'border-[#0e1745]/[0.08] dark:border-white/10 bg-white dark:bg-white/[0.05] text-[#0e1745] dark:text-white shadow-[0_1px_2px_rgba(14,23,69,0.04)] font-semibold'
                          : 'border-transparent bg-transparent text-[#0e1745]/70 dark:text-white/65 hover:bg-[#0e1745]/[0.04] dark:hover:bg-white/[0.04] hover:text-[#0e1745] dark:hover:text-white',
                      )}
                    >
                      <Icon
                        size={14}
                        strokeWidth={1.75}
                        className={isActive ? 'text-cl2-accent' : 'text-[#0e1745]/50 dark:text-white/50'}
                      />
                      <span className="flex-1 truncate">{item.label}</span>
                      {typeof badge === 'number' && badge > 0 && (
                        <span className="ml-auto rounded-full border border-cl2-accent/30 bg-cl2-accent/10 px-1.5 py-px text-[10px] font-semibold tabular-nums text-cl2-accent-hover dark:text-cl2-accent-soft">
                          {badge}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </aside>

          {/* Mobile section selector — visible <md (compact pill row). */}
          <div className="md:hidden flex gap-1.5 overflow-x-auto px-3 py-2 border-b border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white/60 dark:bg-white/[0.015]">
            {NAV.map((item) => {
              const Icon = item.icon;
              const isActive = active === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => navigate(`/admin/${item.id}`)}
                  className={cn(
                    'shrink-0 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11.5px] transition-colors',
                    isActive
                      ? 'bg-cl2-accent text-white'
                      : 'bg-transparent text-[#0e1745]/70 dark:text-white/65 hover:bg-[#0e1745]/[0.04] dark:hover:bg-white/[0.04]',
                  )}
                >
                  <Icon size={13} strokeWidth={1.75} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>

          {/* Section content scroll area */}
          <div className="overflow-y-auto px-4 sm:px-6 md:px-7 py-6 md:py-7">
            {children}
          </div>
        </section>
      </main>

      {/* Mobile drawer — same as chat */}
      <Sidebar
        open={isMobileDrawerOpen}
        onClose={() => setIsMobileDrawerOpen(false)}
        variant="drawer"
        side="left"
        className="lg:hidden"
      />
    </div>
  );
}
