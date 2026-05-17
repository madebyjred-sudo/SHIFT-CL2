/**
 * generateInformeSemanal.ts — Sprint 3 Track P.
 *
 * Job que corre cada lunes 6am (o on-demand). Para cada user con watchlist
 * activa genera un informe semanal en `cl2_informes_semanales`.
 *
 * Contenido del informe:
 *   - Título: "Informe semanal CL2 — Semana ISO {weekIso} ({rango fechas})"
 *   - Resumen ejecutivo (3-4 líneas)
 *   - Novedades por expediente (agrupadas, ordenadas por urgencia)
 *   - Alertas críticas pendientes
 *   - Expedientes nuevos en watchlist
 *   - Acciones propuestas (al menos 1 por urgencia alta)
 *
 * Doctrina LLM-vs-Algoritmo:
 *   - Cron + agregación SQL + ISO week math = algoritmo.
 *   - Narrativa final (voz humana + propuestas accionables) = LLM.
 *
 * Modelo:
 *   - Default: 'openrouter/anthropic/claude-3.7-sonnet'.
 *   - Override: env CL2_EDITORIAL_INFORME_MODEL.
 *
 * Idempotente: unique (user_id, semana_iso) en la tabla.
 *
 * Mock-friendly: `generateOneInforme()` es pura; `runGenerateInformes()` arma
 * Supabase + LLM real.
 *
 * Author: Jred / Claude Code — 2026-05-16
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../services/logger.js';
import { withRetry, withTimeout, ResilienceError } from '../services/resilience.js';

// ── Tipos públicos ───────────────────────────────────────────────────────────

export interface InformeScope {
  /** Si está set, sólo genera para este user. */
  user_id?: string;
  /** Por defecto la semana ISO actual (basada en hoy). */
  semana_iso?: string;
  /** Si true, reemplaza informe existente para esa semana. */
  force?: boolean;
}

export interface InformeResult {
  users_processed: number;
  informes_generated: number;
  informes_skipped_exists: number;
  errors: number;
  duration_ms: number;
}

export interface AccionPropuesta {
  tipo: string;
  expediente?: string;
  urgencia: 'alta' | 'media' | 'baja';
  sugerencia: string;
}

export interface LlmInformeOutput {
  cuerpo_md: string;
  acciones_propuestas: AccionPropuesta[];
}

export type LlmInformeCaller = (args: {
  systemPrompt: string;
  userPrompt: string;
  model: string;
}) => Promise<string>;

// ── Constantes ───────────────────────────────────────────────────────────────

const DEFAULT_MODEL =
  process.env.CL2_EDITORIAL_INFORME_MODEL ?? 'anthropic/claude-sonnet-4.6';
const OR_TIMEOUT_MS = 90_000;
const OR_RETRY_ATTEMPTS = 2;
const OR_RETRY_BASE_MS = 1000;
// Wave 2 piece 3 (2026-05-17): route via Cerebro Gateway for cost attribution
// + cache_control + future quota enforcement. Was openrouter.ai/api/v1.
const OR_BASE = (process.env.CEREBRO_BASE_URL ?? 'https://shift-cerebro-production.up.railway.app') + '/v1';
const MAX_OUTPUT_TOKENS = 2500;

// ── Supabase lazy client ─────────────────────────────────────────────────────

let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'supabase env missing for generateInformeSemanal (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)',
    );
  }
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

// ── ISO week math ────────────────────────────────────────────────────────────

/**
 * Devuelve {year, week} ISO 8601 para una fecha dada. La semana ISO empieza
 * el lunes; week 1 contiene el primer jueves del año.
 */
export function getIsoWeek(date: Date): { year: number; week: number } {
  // Copia + normalizar a lunes 00:00 UTC.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Domingo (0) → lunes anterior; jueves del mismo "semana" guía el year.
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: d.getUTCFullYear(), week: weekNo };
}

export function isoWeekString(date: Date): string {
  const { year, week } = getIsoWeek(date);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Devuelve [start, end) en UTC para la semana ISO dada. start = lunes 00:00. */
export function isoWeekRange(weekIso: string): { start: Date; end: Date } {
  const m = weekIso.match(/^(\d{4})-W(\d{2})$/);
  if (!m) throw new Error(`bad weekIso: ${weekIso}`);
  const year = Number(m[1]);
  const week = Number(m[2]);
  // Jueves de la semana 1 ISO = jueves de la semana que contiene 4 de enero.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = new Date(Date.UTC(year, 0, 4 - (jan4Day - 1)));
  const start = new Date(week1Monday.getTime() + (week - 1) * 7 * 86400000);
  const end = new Date(start.getTime() + 7 * 86400000);
  return { start, end };
}

function formatRangeLabel(start: Date, end: Date): string {
  // "12-18 mayo" si misma semana mismo mes, o "29 abril - 5 mayo" si cruza meses.
  const lastDay = new Date(end.getTime() - 86400000);
  const fmtDay = (d: Date) =>
    d.toLocaleDateString('es-CR', { day: 'numeric', timeZone: 'UTC' });
  const fmtMonth = (d: Date) =>
    d.toLocaleDateString('es-CR', { month: 'long', timeZone: 'UTC' });
  if (start.getUTCMonth() === lastDay.getUTCMonth()) {
    return `${fmtDay(start)}-${fmtDay(lastDay)} ${fmtMonth(start)}`;
  }
  return `${fmtDay(start)} ${fmtMonth(start)} - ${fmtDay(lastDay)} ${fmtMonth(lastDay)}`;
}

// ── Tipos internos ───────────────────────────────────────────────────────────

interface NovedadAgregada {
  event_type: string;
  expediente_id: string;
  priority: string;
  detected_at: string;
  payload: Record<string, unknown>;
}

interface AlertaCritica {
  id: string;
  title: string;
  body: string;
  priority: string;
  delivered_at: string;
}

interface ExpedienteNuevo {
  numero: string;
  titulo: string | null;
  added_at: string;
}

interface InformeData {
  user_id: string;
  user_email: string | null;
  semana_iso: string;
  rango_label: string;
  range_start: string;
  range_end: string;
  watchlist_total: number;
  novedades: NovedadAgregada[];
  alertas_criticas: AlertaCritica[];
  expedientes_nuevos: ExpedienteNuevo[];
}

// ── Prompts ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = [
  'Sos un consultor senior de asuntos públicos en Costa Rica trabajando para CL2 Consultoría.',
  'Tu tarea: redactar un INFORME SEMANAL editorial para un consultor, basado en los datos agregados que te paso.',
  '',
  'Estructura OBLIGATORIA (markdown):',
  '',
  '# Informe semanal CL2 — Semana {semana_iso} ({rango_label})',
  '',
  '## Resumen ejecutivo',
  '3-4 líneas con lo más importante. Lo que el consultor lee en el ascensor.',
  '',
  '## Novedades por expediente',
  'Agrupá por expediente. Ordená por urgencia: alertas críticas primero, luego eventos high, luego medium.',
  'Para cada expediente da el número + 2-3 bullets con qué pasó esta semana, con la fecha entre paréntesis.',
  '',
  '## Alertas críticas pendientes',
  'Lista de alertas no leídas o snoozeadas que vencen pronto. Cada una con su priority + body.',
  '',
  '## Expedientes nuevos en tu watchlist',
  'Lista de expedientes que entraron a la watchlist esta semana, con título corto.',
  '',
  '## Acciones propuestas',
  'Lista accionable. Al menos 1 acción por cada novedad urgencia=alta.',
  '',
  'Tono: editorial sobrio, segunda persona ("Esta semana en tus expedientes…"). Cero hype. Cero marketing.',
  '',
  'Después del cuerpo markdown, en una nueva línea, agregá EXACTAMENTE este separator y luego el JSON de acciones:',
  '',
  '---ACCIONES-JSON---',
  '{"acciones_propuestas": [{"tipo": "reunion_cliente", "expediente": "23.511", "urgencia": "alta", "sugerencia": "Llamá al cliente X esta semana porque..."}]}',
  '',
  'urgencia ∈ {alta, media, baja}. tipo es texto libre (ej "redactar_minuta", "agendar_audiencia", "consultar_cliente").',
].join('\n');

function buildUserPrompt(data: InformeData): string {
  const payload = {
    semana_iso: data.semana_iso,
    rango_label: data.rango_label,
    watchlist_total: data.watchlist_total,
    novedades_count: data.novedades.length,
    alertas_criticas_count: data.alertas_criticas.length,
    expedientes_nuevos_count: data.expedientes_nuevos.length,
    novedades: data.novedades.slice(0, 50),
    alertas_criticas: data.alertas_criticas.slice(0, 20),
    expedientes_nuevos: data.expedientes_nuevos.slice(0, 30),
  };
  return [
    'DATOS DE LA SEMANA — agregación SQL:',
    '```json',
    JSON.stringify(payload, null, 2).slice(0, 28_000),
    '```',
    '',
    'Redactá el informe semanal. Recordá: markdown + separator + JSON al final.',
  ].join('\n');
}

// ── LLM caller real ──────────────────────────────────────────────────────────

async function defaultLlmCall(args: {
  systemPrompt: string;
  userPrompt: string;
  model: string;
}): Promise<string> {
  const orKey = process.env.CEREBRO_API_KEY ?? '';
  if (!orKey) throw new Error('CEREBRO_API_KEY not set');

  return withRetry(
    async () => {
      const res = await withTimeout(
        (signal) =>
          fetch(`${OR_BASE}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${orKey}`,
              'HTTP-Referer': 'https://agentescl2.com',
              'X-Title': 'Shift CL2 Editorial',
            },
            body: JSON.stringify({
              model: args.model,
              messages: [
                { role: 'system', content: args.systemPrompt },
                { role: 'user', content: args.userPrompt },
              ],
              max_tokens: MAX_OUTPUT_TOKENS,
              temperature: 0.4,
            }),
            signal,
          }),
        { ms: OR_TIMEOUT_MS, label: 'editorial:informe' },
      );

      if (!res.ok) {
        const text = await res.text();
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw new ResilienceError(`openrouter ${res.status}: ${text.slice(0, 200)}`, 'aborted');
        }
        throw new Error(`openrouter ${res.status}: ${text.slice(0, 200)}`);
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return json?.choices?.[0]?.message?.content ?? '';
    },
    { attempts: OR_RETRY_ATTEMPTS, baseDelayMs: OR_RETRY_BASE_MS, label: 'editorial:informe' },
  );
}

// ── Parser del output mixto markdown + JSON ──────────────────────────────────

export function parseInformeLlm(raw: string): LlmInformeOutput {
  const sep = '---ACCIONES-JSON---';
  const idx = raw.indexOf(sep);
  const cuerpo_md = idx >= 0 ? raw.slice(0, idx).trim() : raw.trim();
  let acciones_propuestas: AccionPropuesta[] = [];
  if (idx >= 0) {
    const tail = raw.slice(idx + sep.length).trim();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(tail);
    } catch {
      const fence = tail.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
      if (fence) {
        try {
          parsed = JSON.parse(fence[1]!);
        } catch {
          // ignore
        }
      }
      if (!parsed) {
        const open = tail.indexOf('{');
        const close = tail.lastIndexOf('}');
        if (open >= 0 && close > open) {
          try {
            parsed = JSON.parse(tail.slice(open, close + 1));
          } catch {
            // ignore
          }
        }
      }
    }
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as { acciones_propuestas?: unknown };
      if (Array.isArray(obj.acciones_propuestas)) {
        for (const raw of obj.acciones_propuestas) {
          const r = raw as Record<string, unknown>;
          const tipo = typeof r.tipo === 'string' ? r.tipo : '';
          const sugerencia = typeof r.sugerencia === 'string' ? r.sugerencia : '';
          if (!tipo || !sugerencia) continue;
          const urgencia =
            r.urgencia === 'alta' || r.urgencia === 'media' || r.urgencia === 'baja'
              ? r.urgencia
              : 'media';
          const accion: AccionPropuesta = { tipo, urgencia, sugerencia };
          if (typeof r.expediente === 'string') accion.expediente = r.expediente;
          acciones_propuestas.push(accion);
        }
      }
    }
  }
  if (!cuerpo_md) throw new Error('informe_llm_empty_cuerpo');
  return { cuerpo_md, acciones_propuestas };
}

// ── Función pura — generar UN informe ────────────────────────────────────────

export async function generateOneInforme(args: {
  data: InformeData;
  model?: string;
  llm?: LlmInformeCaller;
}): Promise<LlmInformeOutput> {
  const model = args.model ?? DEFAULT_MODEL;
  const llm = args.llm ?? defaultLlmCall;
  const systemPrompt = SYSTEM_PROMPT.replace('{semana_iso}', args.data.semana_iso).replace(
    '{rango_label}',
    args.data.rango_label,
  );
  const userPrompt = buildUserPrompt(args.data);
  const raw = await llm({ systemPrompt, userPrompt, model });
  return parseInformeLlm(raw);
}

// ── Agregación de datos SQL para UN user ─────────────────────────────────────

async function aggregateForUser(
  sb: SupabaseClient,
  userId: string,
  semanaIso: string,
): Promise<InformeData | null> {
  const { start, end } = isoWeekRange(semanaIso);
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const rangoLabel = formatRangeLabel(start, end);

  // 1. Watchlist del user.
  const { data: watchRows, error: watchErr } = await sb
    .from('centinela_watchlist')
    .select('entity_id, created_at')
    .eq('user_id', userId)
    .eq('entity_type', 'expediente');
  if (watchErr) {
    logger.warn('informe_watchlist_failed', { user_id: userId, error: watchErr.message });
    return null;
  }
  const watchExpedientes = (watchRows ?? []) as Array<{ entity_id: string; created_at: string }>;
  if (watchExpedientes.length === 0) {
    // Sin watchlist no hay informe que generar.
    return null;
  }

  // ── User email para el subject del informe ────────────────────────────
  let userEmail: string | null = null;
  try {
    const { data: ua } = await sb
      .from('user_access')
      .select('email')
      .eq('user_id', userId)
      .maybeSingle();
    userEmail = (ua?.email as string | null) ?? null;
  } catch {
    // no es fatal
  }

  // 2. Novedades de la semana — centinela_eventos del user, scope a sus expedientes,
  //    detected_at en rango. Eventos shared (user_id null) también aplican si
  //    expediente_id está en watchlist.
  const expNumeros = watchExpedientes.map((w) => w.entity_id);
  const { data: eventosUser } = await sb
    .from('centinela_eventos')
    .select('event_type, expediente_id, priority, detected_at, payload')
    .eq('user_id', userId)
    .in('expediente_id', expNumeros)
    .gte('detected_at', startIso)
    .lt('detected_at', endIso)
    .order('detected_at', { ascending: false });
  const { data: eventosShared } = await sb
    .from('centinela_eventos')
    .select('event_type, expediente_id, priority, detected_at, payload')
    .is('user_id', null)
    .in('expediente_id', expNumeros)
    .gte('detected_at', startIso)
    .lt('detected_at', endIso)
    .order('detected_at', { ascending: false });
  const novedades: NovedadAgregada[] = [
    ...((eventosUser ?? []) as NovedadAgregada[]),
    ...((eventosShared ?? []) as NovedadAgregada[]),
  ];

  // 3. Alertas críticas pendientes (no leídas + priority critical|high).
  const { data: alertas } = await sb
    .from('centinela_alerts_v2')
    .select('id, title, body, priority, delivered_at, read_at, snoozed_until')
    .eq('user_id', userId)
    .in('priority', ['critical', 'high'])
    .is('read_at', null)
    .order('delivered_at', { ascending: false })
    .limit(50);
  const alertas_criticas: AlertaCritica[] = ((alertas ?? []) as Array<{
    id: string;
    title: string;
    body: string;
    priority: string;
    delivered_at: string;
  }>).map((a) => ({
    id: a.id,
    title: a.title,
    body: a.body,
    priority: a.priority,
    delivered_at: a.delivered_at,
  }));

  // 4. Expedientes recién agregados a watchlist en la semana.
  const nuevosRaw = watchExpedientes.filter(
    (w) => w.created_at >= startIso && w.created_at < endIso,
  );
  let expedientes_nuevos: ExpedienteNuevo[] = [];
  if (nuevosRaw.length > 0) {
    const nums = nuevosRaw.map((w) => w.entity_id);
    const { data: exps } = await sb
      .from('sil_expedientes')
      .select('numero, titulo')
      .in('numero', nums);
    const titles = new Map<string, string | null>(
      ((exps ?? []) as Array<{ numero: string; titulo: string | null }>).map((r) => [
        r.numero,
        r.titulo,
      ]),
    );
    expedientes_nuevos = nuevosRaw.map((w) => ({
      numero: w.entity_id,
      titulo: titles.get(w.entity_id) ?? null,
      added_at: w.created_at,
    }));
  }

  return {
    user_id: userId,
    user_email: userEmail,
    semana_iso: semanaIso,
    rango_label: rangoLabel,
    range_start: startIso,
    range_end: endIso,
    watchlist_total: watchExpedientes.length,
    novedades,
    alertas_criticas,
    expedientes_nuevos,
  };
}

// ── Función principal ────────────────────────────────────────────────────────

export async function runGenerateInformesSemanales(
  opts: InformeScope = {},
  llmOverride?: LlmInformeCaller,
): Promise<InformeResult> {
  const startMs = Date.now();
  const semanaIso = opts.semana_iso ?? isoWeekString(new Date());
  const force = opts.force ?? false;
  const result: InformeResult = {
    users_processed: 0,
    informes_generated: 0,
    informes_skipped_exists: 0,
    errors: 0,
    duration_ms: 0,
  };

  logger.info('informe_semanal_start', { semana_iso: semanaIso, force, single_user: opts.user_id });

  const sb = supa();

  // 1. Lista de users con watchlist activa expediente.
  let userIds: string[] = [];
  if (opts.user_id) {
    userIds = [opts.user_id];
  } else {
    const { data, error } = await sb
      .from('centinela_watchlist')
      .select('user_id')
      .eq('entity_type', 'expediente');
    if (error) throw new Error(`informe_listUsers: ${error.message}`);
    const set = new Set<string>();
    for (const r of (data ?? []) as Array<{ user_id: string }>) set.add(r.user_id);
    userIds = [...set];
  }

  if (userIds.length === 0) {
    result.duration_ms = Date.now() - startMs;
    logger.info('informe_semanal_no_users', {});
    return result;
  }

  // 2. Loop por user.
  for (const userId of userIds) {
    result.users_processed++;

    // Skip si ya existe y no force.
    if (!force) {
      const { data: existing } = await sb
        .from('cl2_informes_semanales')
        .select('id')
        .eq('user_id', userId)
        .eq('semana_iso', semanaIso)
        .maybeSingle();
      if (existing) {
        result.informes_skipped_exists++;
        continue;
      }
    }

    try {
      const data = await aggregateForUser(sb, userId, semanaIso);
      if (!data) {
        logger.info('informe_user_no_data', { user_id: userId, semana_iso: semanaIso });
        continue;
      }

      const out = await generateOneInforme({ data, llm: llmOverride });

      const { error: upErr } = await sb.from('cl2_informes_semanales').upsert(
        {
          user_id: userId,
          semana_iso: semanaIso,
          cuerpo_md: out.cuerpo_md,
          novedades_count: data.novedades.length,
          alertas_criticas: data.alertas_criticas.length,
          expedientes_nuevos: data.expedientes_nuevos.length,
          acciones_propuestas: out.acciones_propuestas,
          generated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,semana_iso' },
      );

      if (upErr) {
        result.errors++;
        logger.warn('informe_persist_failed', {
          user_id: userId,
          semana_iso: semanaIso,
          error: upErr.message,
        });
        continue;
      }
      result.informes_generated++;
    } catch (err) {
      result.errors++;
      logger.warn('informe_one_failed', {
        user_id: userId,
        semana_iso: semanaIso,
        error: (err as Error).message,
      });
    }
  }

  result.duration_ms = Date.now() - startMs;
  logger.info('informe_semanal_complete', { ...result, semana_iso: semanaIso });
  return result;
}

// ── Test helpers ─────────────────────────────────────────────────────────────

export function _resetSupaClient(): void {
  _supa = null;
}
