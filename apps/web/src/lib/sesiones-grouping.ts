/**
 * Pure helpers for the Plenarias listing — grouping by time bucket,
 * density heatmap binning, KPI derivation. Zero DOM, zero React,
 * testeable directo.
 *
 * The whole listing experience (`/sesiones` v2) leans on these to render
 * the editorial feed ("Esta semana", "Marzo", …) and the 30-day densidad
 * heatmap that lives in the hero.
 */
import type { SessionListItem } from '@/services/sessionsApi';

// ─── time-bucket grouping ─────────────────────────────────────────────

export type TimeBucketKey = 'esta' | 'pasada' | 'mes' | 'ant';

export interface SessionGroup {
  key: TimeBucketKey;
  label: string;
  /** Optional secondary label rendered next to the title (e.g. "marzo"). */
  monthLabel?: string;
  items: SessionListItem[];
}

const MONTHS_ES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** Monday of the week the date belongs to. */
function startOfWeek(d: Date): Date {
  const x = startOfDay(d);
  const dow = x.getDay(); // 0 = sunday, 1 = monday, …
  const diff = (dow + 6) % 7; // monday-anchored
  x.setDate(x.getDate() - diff);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function parseFecha(raw: string): Date | null {
  // sessions.fecha is ISO timestamp ("2026-03-24T...") or date ("2026-03-24")
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t) : null;
}

/**
 * Group sessions into editorial buckets relative to `today`:
 *   esta    — Mon..Sun current week
 *   pasada  — Mon..Sun previous week
 *   mes     — current calendar month, excluding the two weeks above
 *   ant     — everything older, sub-grouped by month label
 *
 * Sessions without a parseable fecha land in `ant` last.
 */
export function groupSessionsByTime(
  sessions: SessionListItem[],
  today: Date = new Date(),
): SessionGroup[] {
  const thisWeekStart = startOfWeek(today);
  const lastWeekStart = addDays(thisWeekStart, -7);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  const esta: SessionListItem[] = [];
  const pasada: SessionListItem[] = [];
  const mes: SessionListItem[] = [];
  // older items keyed by `${year}-${month}`
  const older = new Map<string, SessionListItem[]>();

  // Sort newest first so each bucket reads correctly without re-sorting.
  const sorted = [...sessions].sort((a, b) => {
    const ta = Date.parse(a.fecha);
    const tb = Date.parse(b.fecha);
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  });

  for (const s of sorted) {
    const d = parseFecha(s.fecha);
    if (!d) {
      const k = 'sin-fecha';
      if (!older.has(k)) older.set(k, []);
      older.get(k)!.push(s);
      continue;
    }
    if (d >= thisWeekStart) esta.push(s);
    else if (d >= lastWeekStart) pasada.push(s);
    else if (d >= monthStart) mes.push(s);
    else {
      const k = `${d.getFullYear()}-${String(d.getMonth()).padStart(2, '0')}`;
      if (!older.has(k)) older.set(k, []);
      older.get(k)!.push(s);
    }
  }

  const groups: SessionGroup[] = [];
  if (esta.length) groups.push({ key: 'esta', label: 'Esta semana', items: esta });
  if (pasada.length) groups.push({ key: 'pasada', label: 'Semana pasada', items: pasada });
  if (mes.length) {
    groups.push({
      key: 'mes',
      label: capitalize(MONTHS_ES[today.getMonth()]),
      items: mes,
    });
  }
  // Older keys are already in newest-first order because of the input sort.
  for (const [k, items] of older) {
    if (k === 'sin-fecha') {
      groups.push({ key: 'ant', label: 'Sin fecha', items });
      continue;
    }
    const [yy, mm] = k.split('-').map(Number);
    groups.push({
      key: 'ant',
      label: `${capitalize(MONTHS_ES[mm])} ${yy}`,
      monthLabel: undefined,
      items,
    });
  }
  return groups;
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

// ─── 30-day density heatmap ───────────────────────────────────────────

export interface DensityCell {
  /** Date this cell represents (start of day). */
  date: Date;
  /** Sessions starting on that day. */
  count: number;
  /** Bucket [0..4] for visual intensity. */
  level: 0 | 1 | 2 | 3 | 4;
}

/**
 * Produce 30 consecutive cells ending on `today`. Empty days have count=0
 * level=0; days with sessions get bucketed against the global max in the
 * window so the heatmap reads as distribution, not absolute count.
 */
export function buildDensity30d(
  sessions: SessionListItem[],
  today: Date = new Date(),
): DensityCell[] {
  const last = startOfDay(today);
  const first = addDays(last, -29);

  const counts = new Map<string, number>();
  for (const s of sessions) {
    const d = parseFecha(s.fecha);
    if (!d) continue;
    const day = startOfDay(d);
    if (day < first || day > last) continue;
    const k = day.toISOString().slice(0, 10);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }

  const cells: DensityCell[] = [];
  let max = 0;
  for (let i = 0; i < 30; i++) {
    const date = addDays(first, i);
    const c = counts.get(date.toISOString().slice(0, 10)) ?? 0;
    if (c > max) max = c;
    cells.push({ date, count: c, level: 0 });
  }
  if (max > 0) {
    for (const cell of cells) {
      if (cell.count === 0) cell.level = 0;
      else if (cell.count >= max) cell.level = 4;
      else if (cell.count >= max * 0.66) cell.level = 3;
      else if (cell.count >= max * 0.33) cell.level = 2;
      else cell.level = 1;
    }
  }
  return cells;
}

// ─── KPIs (derived from a single fetch) ───────────────────────────────

export interface SessionKpis {
  sesionesEstaSemana: number;
  finalizadasMes: number;
  conResumen: number;
  total: number;
}

export function computeKpis(
  sessions: SessionListItem[],
  today: Date = new Date(),
): SessionKpis {
  const thisWeekStart = startOfWeek(today);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  let sesionesEstaSemana = 0;
  let finalizadasMes = 0;
  let conResumen = 0;
  for (const s of sessions) {
    const d = parseFecha(s.fecha);
    if (d && d >= thisWeekStart) sesionesEstaSemana += 1;
    if (d && d >= monthStart && s.estado === 1) finalizadasMes += 1;
    if (s.has_resumen) conResumen += 1;
  }
  return {
    sesionesEstaSemana,
    finalizadasMes,
    conResumen,
    total: sessions.length,
  };
}

// ─── Quick chip filter ────────────────────────────────────────────────

export type QuickChip = 'todas' | 'esta' | 'mes' | 'resumen' | 'live';

export function applyQuickChip(
  sessions: SessionListItem[],
  chip: QuickChip,
  today: Date = new Date(),
): SessionListItem[] {
  if (chip === 'todas') return sessions;
  const thisWeekStart = startOfWeek(today);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  return sessions.filter((s) => {
    const d = parseFecha(s.fecha);
    if (chip === 'esta') return !!(d && d >= thisWeekStart);
    if (chip === 'mes') return !!(d && d >= monthStart);
    if (chip === 'resumen') return s.has_resumen;
    if (chip === 'live') return s.estado !== 1;
    return true;
  });
}

// ─── Status filter ────────────────────────────────────────────────────

export type EstadoFilter = 'todas' | 'finalizadas' | 'en-proceso';

export function applyEstadoFilter(
  sessions: SessionListItem[],
  estado: EstadoFilter,
): SessionListItem[] {
  if (estado === 'todas') return sessions;
  if (estado === 'finalizadas') return sessions.filter((s) => s.estado === 1);
  return sessions.filter((s) => s.estado !== 1);
}

// ─── Duration filter ──────────────────────────────────────────────────

export type DuracionFilter = 'todas' | 'corta' | 'media' | 'larga';

/** corta < 90min · media 90-180min · larga >180min. */
export function applyDuracionFilter(
  sessions: SessionListItem[],
  d: DuracionFilter,
): SessionListItem[] {
  if (d === 'todas') return sessions;
  return sessions.filter((s) => {
    const min = (s.duration_s ?? 0) / 60;
    if (d === 'corta') return min > 0 && min < 90;
    if (d === 'media') return min >= 90 && min <= 180;
    return min > 180;
  });
}

// ─── Free-text query ──────────────────────────────────────────────────

export function applyQuery(sessions: SessionListItem[], q: string): SessionListItem[] {
  const term = q.trim().toLowerCase();
  if (!term) return sessions;
  return sessions.filter((s) => s.titulo.toLowerCase().includes(term));
}
