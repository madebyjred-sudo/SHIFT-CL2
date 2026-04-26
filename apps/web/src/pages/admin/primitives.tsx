/**
 * Reusable visual primitives for the admin console.
 *
 * The design package shipped these as JSX globals; we re-implement them
 * as typed React components here. All the section pages compose from
 * these — keeps each section dumb and focused on its data.
 */
import { type ReactNode } from 'react';
import { TrendingUp, TrendingDown, Minus, type LucideIcon } from 'lucide-react';

// ─── Section header ───────────────────────────────────────────────────

export function SectionHeader(props: {
  eyebrow: string;
  actions?: ReactNode;
}): React.ReactElement {
  return (
    <div className="mb-4 flex items-center justify-between gap-6">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-[#0e1745]/45">
        {props.eyebrow}
      </div>
      {props.actions && <div className="flex shrink-0 items-center gap-2">{props.actions}</div>}
    </div>
  );
}

// ─── Buttons ──────────────────────────────────────────────────────────

type ButtonVariant = 'coral' | 'ghost' | 'quiet' | 'approve' | 'reject';

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-1.5 rounded-lg border border-transparent px-3.5 py-2 text-[12.5px] font-semibold tracking-[-0.01em] transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  coral:
    'bg-[#F93549] text-white shadow-[0_4px_14px_rgba(249,53,73,0.22)] hover:bg-[#E11D48]',
  ghost:
    'border-[#0e1745]/[0.10] bg-white text-[#0e1745] hover:bg-[#0e1745]/[0.04]',
  quiet:
    'bg-transparent px-2.5 py-1.5 font-medium text-[#0e1745]/65 hover:bg-[#0e1745]/[0.04] hover:text-[#0e1745]',
  approve:
    'bg-[#10b981] text-white border-[#0e9b6f] px-5 py-[11px] text-[13.5px] font-bold rounded-[9px] shadow-[0_4px_14px_rgba(16,185,129,0.30)] hover:bg-[#0e9b6f] hover:shadow-[0_6px_18px_rgba(16,185,129,0.42)] hover:-translate-y-px',
  reject:
    'bg-white text-[#b91c1c] border-[1.5px] border-[#ef4444] px-5 py-[11px] text-[13.5px] font-bold rounded-[9px] shadow-[0_2px_6px_rgba(239,68,68,0.10)] hover:bg-[rgba(239,68,68,0.08)] hover:shadow-[0_4px_12px_rgba(239,68,68,0.18)] hover:-translate-y-px',
};

interface ActionButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  icon?: LucideIcon;
  /** Smaller variant for inline list rows. */
  size?: 'md' | 'sm';
}

export function ActionButton({
  variant = 'ghost',
  icon: Icon,
  size = 'md',
  children,
  className = '',
  ...rest
}: ActionButtonProps): React.ReactElement {
  const sizeClass =
    size === 'sm' && (variant === 'approve' || variant === 'reject')
      ? 'px-3 py-1.5 text-[12px] shadow-[0_2px_6px_rgba(16,185,129,0.22)]'
      : '';
  return (
    <button
      type="button"
      className={`${BUTTON_BASE} ${BUTTON_VARIANTS[variant]} ${sizeClass} ${className}`.trim()}
      {...rest}
    >
      {Icon && <Icon size={13} strokeWidth={2} />}
      {children}
    </button>
  );
}

// ─── Pills ────────────────────────────────────────────────────────────

export type PillKind =
  | 'lexa'
  | 'atlas'
  | 'centinela'
  | 'neutral'
  | 'success'
  | 'warn'
  | 'danger'
  | 'info'
  | 'coral'
  | 'amber';

const PILL_VARIANTS: Record<PillKind, string> = {
  lexa: 'bg-[rgba(122,59,71,0.07)] text-[#7A3B47] border-[rgba(122,59,71,0.20)]',
  atlas: 'bg-[rgba(139,110,84,0.08)] text-[#8B6E54] border-[rgba(139,110,84,0.30)]',
  centinela: 'bg-[rgba(244,63,94,0.07)] text-[#F43F5E] border-[rgba(244,63,94,0.30)]',
  neutral: 'bg-[#0e1745]/[0.04] text-[#0e1745]/70 border-[#0e1745]/[0.10]',
  success: 'bg-[rgba(16,185,129,0.10)] text-[#047857] border-[rgba(16,185,129,0.28)]',
  warn: 'bg-[rgba(245,158,11,0.10)] text-[#b45309] border-[rgba(245,158,11,0.28)]',
  amber: 'bg-[rgba(245,158,11,0.10)] text-[#b45309] border-[rgba(245,158,11,0.28)]',
  danger: 'bg-[rgba(239,68,68,0.08)] text-[#b91c1c] border-[rgba(239,68,68,0.28)]',
  info: 'bg-[rgba(21,52,220,0.07)] text-[#1534dc] border-[rgba(21,52,220,0.22)]',
  coral: 'bg-[rgba(249,53,73,0.08)] text-[#E11D48] border-[rgba(249,53,73,0.22)]',
};

export function Pill(props: {
  kind?: PillKind;
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
}): React.ReactElement {
  const Icon = props.icon;
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-[3px] text-[10.5px] font-semibold ${PILL_VARIANTS[props.kind ?? 'neutral']} ${props.className ?? ''}`.trim()}
    >
      {Icon && <Icon size={10} strokeWidth={2.2} />}
      {props.children}
    </span>
  );
}

// ─── Status dots ──────────────────────────────────────────────────────

const DOT_COLOR: Record<string, string> = {
  green: '#10b981',
  amber: '#f59e0b',
  rose: '#ef4444',
  idle: '#94a3b8',
};

export function StatusDot(props: {
  kind?: 'green' | 'amber' | 'rose' | 'idle';
  pulse?: boolean;
}): React.ReactElement {
  const kind = props.kind ?? 'green';
  const ring =
    kind === 'green' ? 'shadow-[0_0_0_3px_rgba(16,185,129,0.14)]' :
    kind === 'amber' ? 'shadow-[0_0_0_3px_rgba(245,158,11,0.14)]' :
    kind === 'rose'  ? 'shadow-[0_0_0_3px_rgba(239,68,68,0.14)]'  : '';
  return (
    <span
      className={`relative inline-block h-[7px] w-[7px] shrink-0 rounded-full ${ring}`}
      style={{ background: DOT_COLOR[kind] }}
    >
      {props.pulse && (
        <span
          aria-hidden
          className="absolute inset-[-3px] rounded-full border-2 opacity-40"
          style={{ borderColor: DOT_COLOR[kind], animation: 'admin-pulse 1.6s ease-out infinite' }}
        />
      )}
    </span>
  );
}

// ─── Cards ────────────────────────────────────────────────────────────

export function Card(props: {
  children: ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div
      className={`rounded-xl border border-[#0e1745]/[0.06] bg-white shadow-[0_2px_10px_rgba(14,23,69,0.04)] ${props.className ?? ''}`.trim()}
    >
      {props.children}
    </div>
  );
}

export function CardHeader(props: {
  title: ReactNode;
  meta?: ReactNode;
  /** Optional left icon on the title. */
  icon?: LucideIcon;
}): React.ReactElement {
  const Icon = props.icon;
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[#0e1745]/[0.06] px-[18px] py-3.5">
      <h3 className="m-0 flex items-center gap-1.5 text-[13px] font-semibold tracking-[-0.005em] text-[#0e1745]">
        {Icon && <Icon size={13} className="align-middle" />}
        {props.title}
      </h3>
      {props.meta && (
        <span className="flex items-center gap-2.5 text-[11.5px] text-[#0e1745]/55">{props.meta}</span>
      )}
    </div>
  );
}

export function CardBody(props: {
  children: ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div className={`px-[18px] py-4 ${props.className ?? ''}`.trim()}>{props.children}</div>
  );
}

export function CardRow(props: {
  children: ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div
      className={`border-t border-[#0e1745]/[0.05] px-[18px] py-3.5 first:border-t-0 hover:bg-[#0e1745]/[0.015] ${props.className ?? ''}`.trim()}
    >
      {props.children}
    </div>
  );
}

// ─── KPI tile ─────────────────────────────────────────────────────────

export function KPI(props: {
  label: string;
  value: string;
  unit?: string;
  delta?: string;
  deltaDir?: 'up' | 'down' | 'flat';
  spark?: number[];
  sparkColor?: string;
}): React.ReactElement {
  const dir = props.deltaDir ?? 'up';
  const DeltaIcon = dir === 'up' ? TrendingUp : dir === 'down' ? TrendingDown : Minus;
  const deltaCls = dir === 'up' ? 'text-[#047857]' : dir === 'down' ? 'text-[#b91c1c]' : 'text-[#0e1745]/55';
  return (
    <div className="relative overflow-hidden rounded-xl border border-[#0e1745]/[0.06] bg-white px-[18px] pb-[18px] pt-4 shadow-[0_2px_10px_rgba(14,23,69,0.04)]">
      <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.16em] text-[#0e1745]/50">
        {props.label}
      </div>
      <div className="mt-1.5 font-display text-[30px] font-normal leading-[1.1] tracking-tight tabular-nums text-[#0e1745]">
        {props.value}
        {props.unit && (
          <span className="ml-0.5 font-sans text-[14px] text-[#0e1745]/55">{props.unit}</span>
        )}
      </div>
      {props.delta && (
        <div className={`mt-2 inline-flex items-center gap-1 text-[11px] font-semibold tabular-nums ${deltaCls}`}>
          <DeltaIcon size={11} strokeWidth={2.2} />
          {props.delta}
        </div>
      )}
      {props.spark && <Sparkline data={props.spark} color={props.sparkColor} />}
    </div>
  );
}

function Sparkline(props: { data: number[]; color?: string }): React.ReactElement {
  const w = 78;
  const h = 28;
  const min = Math.min(...props.data);
  const max = Math.max(...props.data);
  const dx = w / (props.data.length - 1);
  const pts = props.data
    .map((v, i) => {
      const x = i * dx;
      const y = h - ((v - min) / (max - min || 1)) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg
      className="pointer-events-none absolute bottom-2.5 right-3 h-[28px] w-[78px] opacity-65"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
    >
      <polyline
        fill="none"
        stroke={props.color ?? '#F93549'}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={pts}
      />
    </svg>
  );
}

// ─── Toggle ───────────────────────────────────────────────────────────

export function Toggle(props: {
  on: boolean;
  onChange: (next: boolean) => void;
  coral?: boolean;
  label?: string;
}): React.ReactElement {
  const onBg = props.coral ? 'bg-[#F93549]' : 'bg-[#10b981]';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      onClick={() => props.onChange(!props.on)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors duration-150 ${
        props.on ? onBg : 'bg-[#0e1745]/15'
      }`}
    >
      <span
        className="absolute left-[2px] top-[2px] h-4 w-4 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.18)] transition-transform duration-150"
        style={{ transform: props.on ? 'translateX(16px)' : 'translateX(0)' }}
      />
    </button>
  );
}

// ─── Avatar ───────────────────────────────────────────────────────────

function shade(hex: string, by = 26): string {
  const m = hex.replace('#', '');
  const num = parseInt(m, 16);
  const r = Math.max(0, ((num >> 16) & 0xff) - by);
  const g = Math.max(0, ((num >> 8) & 0xff) - by);
  const b = Math.max(0, (num & 0xff) - by);
  return `rgb(${r},${g},${b})`;
}

export function Avatar(props: {
  initials: string;
  color?: string;
  size?: 'sm' | 'md';
}): React.ReactElement {
  const c = props.color ?? '#7A3B47';
  const dim = props.size === 'sm' ? 'h-[22px] w-[22px] text-[9.5px]' : 'h-[26px] w-[26px] text-[10.5px]';
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white ${dim}`}
      style={{ background: `linear-gradient(135deg, ${c}, ${shade(c)})` }}
    >
      {props.initials}
    </span>
  );
}

// ─── Agent pill ───────────────────────────────────────────────────────

const AGENT_META: Record<string, { kind: PillKind; icon: string; name: string }> = {
  lexa: { kind: 'lexa', icon: '⚖️', name: 'Lexa' },
  atlas: { kind: 'atlas', icon: '📑', name: 'Atlas' },
  centinela: { kind: 'centinela', icon: '📡', name: 'Centinela' },
};

export function AgentPill(props: { id: 'lexa' | 'atlas' | 'centinela' }): React.ReactElement {
  const m = AGENT_META[props.id];
  return (
    <Pill kind={m.kind}>
      <span className="text-[11px]">{m.icon}</span>
      {m.name}
    </Pill>
  );
}

// ─── Bar row ──────────────────────────────────────────────────────────

export function BarRow(props: {
  name: ReactNode;
  value: number;
  max?: number;
  color?: string;
  secondary?: ReactNode;
}): React.ReactElement {
  const max = props.max ?? 100;
  const pct = Math.min(100, (props.value / max) * 100);
  return (
    <div className="flex items-center gap-2.5 py-2 text-[12px]">
      <div className="flex w-[130px] items-center gap-2 text-[#0e1745]/70">
        <span>{props.name}</span>
      </div>
      <div className="relative h-[6px] flex-1 overflow-hidden rounded bg-[#0e1745]/[0.06]">
        <div
          className="absolute inset-y-0 left-0 rounded opacity-80"
          style={{ width: `${pct}%`, background: props.color ?? '#F93549' }}
        />
      </div>
      <div className="w-16 text-right font-semibold tabular-nums text-[#0e1745]">
        {props.secondary ?? props.value}
      </div>
    </div>
  );
}

// ─── Tabs (in-page pill segmented control) ──────────────────────────────

export function Tabs<T extends string>(props: {
  options: ReadonlyArray<{ id: T; label: ReactNode }>;
  active: T;
  onChange: (next: T) => void;
}): React.ReactElement {
  return (
    <div className="inline-flex gap-0.5 rounded-full border border-[#0e1745]/[0.06] bg-[#0e1745]/[0.04] p-[3px]">
      {props.options.map((opt) => {
        const isActive = props.active === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => props.onChange(opt.id)}
            className={`rounded-full px-3.5 py-1.5 text-[12px] tracking-[-0.005em] transition-colors ${
              isActive
                ? 'bg-white font-semibold text-[#0e1745] shadow-[0_1px_3px_rgba(14,23,69,0.06)]'
                : 'font-medium text-[#0e1745]/65 hover:text-[#0e1745]'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Eyebrow + Display heading ───────────────────────────────────────

export function DisplayHeading(props: {
  children: ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <h1
      className={`m-0 font-display text-[28px] font-normal leading-[1.1] tracking-tight text-[#0e1745] ${props.className ?? ''}`.trim()}
    >
      {props.children}
    </h1>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────

export function EmptyState(props: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
}): React.ReactElement {
  const Icon = props.icon;
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-[#0e1745]/15 bg-white px-6 py-12 text-center">
      <Icon size={28} strokeWidth={1.5} className="text-[#0e1745]/40" />
      <div className="font-display text-[18px] text-[#0e1745]">{props.title}</div>
      <div className="max-w-md text-[12.5px] leading-relaxed text-[#0e1745]/60">
        {props.description}
      </div>
      {props.action}
    </div>
  );
}
