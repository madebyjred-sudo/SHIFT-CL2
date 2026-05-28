/**
 * whatsappAlerts — service layer para la cola de alertas WhatsApp.
 *
 * Ronald F3 MVP (2026-05-26). Mientras Twilio aprueba los templates, el
 * sender es un mock que loguea y marca status='sent' con sid sintético.
 * Cuando llegue el approval real, swap `WHATSAPP_SEND_MOCK=0` y la única
 * función que cambia es `actuallySend()`.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { logger } from './logger.js';
import { renderTemplate, buildDedupKey, WHATSAPP_TEMPLATES } from './whatsappTemplates.js';

let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env not set');
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

export interface WhatsappAlertRow {
  id: string;
  cliente_id: string;
  evento_id: string | null;
  template_name: string;
  body_text: string;
  contact_whatsapp: string;
  status: 'pending' | 'sent' | 'failed' | 'skipped';
  scheduled_for: string;
  sent_at: string | null;
  twilio_sid: string | null;
  error_message: string | null;
  dedup_key: string;
  created_at: string;
}

/**
 * Encola una nueva alerta. Idempotente vía dedup_key — si ya existe una
 * con esa key, retorna {duplicated: true} sin insertar.
 *
 * El sender mock corre inmediatamente después de encolar y marca como
 * 'sent'. En producción real, esto sería un cron worker separado.
 */
export interface QueueAlertInput {
  cliente_id: string;
  template_name: string;
  vars: Record<string, string | number | null | undefined>;
  contact_whatsapp: string;
  evento_id?: string | null;
  dedup_scope: string; // Identificador del scope (ej: numero_expediente, evento_id, ley_numero).
  scheduled_for?: string;
}

export interface QueueAlertResult {
  ok: true;
  alert_id: string;
  duplicated: boolean;
  body_text: string;
}

export async function queueAlert(input: QueueAlertInput): Promise<QueueAlertResult> {
  const tpl = WHATSAPP_TEMPLATES[input.template_name];
  if (!tpl) throw new Error(`Unknown template: ${input.template_name}`);

  const bodyText = renderTemplate(input.template_name, input.vars);
  const dedupKey = buildDedupKey(input.cliente_id, input.template_name, input.dedup_scope);

  const { data, error } = await supa()
    .from('whatsapp_alerts')
    .insert({
      cliente_id: input.cliente_id,
      evento_id: input.evento_id ?? null,
      template_name: input.template_name,
      body_text: bodyText,
      contact_whatsapp: input.contact_whatsapp,
      dedup_key: dedupKey,
      scheduled_for: input.scheduled_for ?? new Date().toISOString(),
    })
    .select('id')
    .maybeSingle();

  if (error) {
    // Code 23505 = unique violation → dedup hit. Es comportamiento esperado.
    if ((error as { code?: string }).code === '23505') {
      const { data: existing } = await supa()
        .from('whatsapp_alerts')
        .select('id, body_text')
        .eq('dedup_key', dedupKey)
        .maybeSingle();
      return {
        ok: true,
        alert_id: (existing as { id: string } | null)?.id ?? '',
        duplicated: true,
        body_text: (existing as { body_text: string } | null)?.body_text ?? bodyText,
      };
    }
    throw new Error(`queueAlert insert: ${error.message}`);
  }

  return {
    ok: true,
    alert_id: (data as { id: string }).id,
    duplicated: false,
    body_text: bodyText,
  };
}

/**
 * Marca una alerta como enviada exitosamente. Usado por el worker
 * (mock o real Twilio) tras lograr el envío.
 */
export async function markAlertSent(alertId: string, twilio_sid: string): Promise<void> {
  const { error } = await supa()
    .from('whatsapp_alerts')
    .update({ status: 'sent', sent_at: new Date().toISOString(), twilio_sid })
    .eq('id', alertId);
  if (error) throw new Error(`markAlertSent: ${error.message}`);
}

export async function markAlertFailed(alertId: string, error_message: string): Promise<void> {
  const { error } = await supa()
    .from('whatsapp_alerts')
    .update({ status: 'failed', error_message })
    .eq('id', alertId);
  if (error) throw new Error(`markAlertFailed: ${error.message}`);
}

export async function markAlertSkipped(alertId: string, reason: string): Promise<void> {
  const { error } = await supa()
    .from('whatsapp_alerts')
    .update({ status: 'skipped', error_message: reason })
    .eq('id', alertId);
  if (error) throw new Error(`markAlertSkipped: ${error.message}`);
}

/**
 * Lista alertas con filtros. Usado por /api/admin/whatsapp-alerts.
 */
export interface ListAlertsArgs {
  cliente_id?: string;
  status?: 'pending' | 'sent' | 'failed' | 'skipped';
  limit?: number;
  offset?: number;
}

export async function listAlerts(args: ListAlertsArgs = {}): Promise<WhatsappAlertRow[]> {
  let q = supa()
    .from('whatsapp_alerts')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(args.limit ?? 50);

  if (args.cliente_id) q = q.eq('cliente_id', args.cliente_id);
  if (args.status) q = q.eq('status', args.status);
  if (args.offset) q = q.range(args.offset, args.offset + (args.limit ?? 50) - 1);

  const { data, error } = await q;
  if (error) throw new Error(`listAlerts: ${error.message}`);
  return (data ?? []) as WhatsappAlertRow[];
}

/**
 * Sender mock — usa esto mientras Twilio Business no apruebe los
 * templates. Loguea + marca como 'sent' con sid sintético.
 *
 * Activar el sender real: setear WHATSAPP_SEND_MOCK=0 + WHATSAPP_TWILIO_SID +
 * WHATSAPP_TWILIO_TOKEN. Implementación real es backlog post-Friday.
 */
export async function sendAlertMock(alertId: string): Promise<void> {
  const mockSid = `mock-${alertId.slice(0, 8)}-${Date.now()}`;
  logger.info('whatsapp_alert_mock_send', {
    alert_id: alertId,
    mock_sid: mockSid,
    note: 'Twilio Business approval pending — alert NOT sent to real WhatsApp.',
  });
  await markAlertSent(alertId, mockSid);
}

/**
 * Procesa las alertas pendientes en cola. Llamado por cron o manualmente
 * desde /api/admin/whatsapp-alerts/process. En MVP, todas las alertas
 * van por sendAlertMock; cuando se active Twilio real, branchea por env.
 */
export async function processPendingAlerts(limit = 20): Promise<{
  processed: number;
  sent: number;
  failed: number;
  skipped: number;
}> {
  const { data, error } = await supa()
    .from('whatsapp_alerts')
    .select('id, cliente_id, contact_whatsapp, body_text, template_name')
    .eq('status', 'pending')
    .lte('scheduled_for', new Date().toISOString())
    .order('scheduled_for', { ascending: true })
    .limit(limit);
  if (error) throw new Error(`processPendingAlerts query: ${error.message}`);

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const rows = (data ?? []) as Array<{ id: string; cliente_id: string; contact_whatsapp: string }>;

  for (const row of rows) {
    // Check opt-in (puede haberse desactivado entre encolado y send).
    const { data: cli } = await supa()
      .from('cl2_clients')
      .select('whatsapp_opt_in')
      .eq('id', row.cliente_id)
      .maybeSingle();
    if (!cli || !(cli as { whatsapp_opt_in: boolean }).whatsapp_opt_in) {
      await markAlertSkipped(row.id, 'cliente_opt_out');
      skipped++;
      continue;
    }
    try {
      await sendAlertMock(row.id);
      sent++;
    } catch (e) {
      await markAlertFailed(row.id, (e as Error).message);
      failed++;
    }
  }

  return { processed: rows.length, sent, failed, skipped };
}
