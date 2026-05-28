/**
 * seed-alerts-for-capture.mjs — inserta alertas realistas en centinela_alerts
 * para que /centinela tenga contenido cuando tomemos screenshots.
 *
 * No corre en prod en condiciones normales — solo lo corremos antes de
 * capturar el documento de 28 pedidos.
 */
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://romccykiucfltfdfatrx.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_EMAIL = 'madebyjred@gmail.com';

const supa = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data: { users } } = await supa.auth.admin.listUsers();
const user = users.find((u) => u.email === ADMIN_EMAIL);
if (!user) throw new Error(`user not found: ${ADMIN_EMAIL}`);
const USER_ID = user.id;
console.log(`User: ${USER_ID}`);

// Limpiar alertas viejas de este user (no destructivo — sólo este user)
const { error: delErr } = await supa
  .from('centinela_alerts')
  .delete()
  .eq('user_id', USER_ID);
if (delErr) console.warn('delete failed:', delErr.message);

const now = new Date();
const tomorrow = new Date(now);
tomorrow.setDate(tomorrow.getDate() + 1);
const yesterday = new Date(now);
yesterday.setDate(yesterday.getDate() - 1);

// Alertas diseñadas para demostrar los 4 pedidos de Centinela
const alerts = [
  // 16b — regla 24h: agenda alert generada >24h antes de la sesión
  {
    user_id: USER_ID,
    entity_type: 'expediente',
    entity_id: '23.511',
    alert_type: 'agenda',
    severity: 'warning',
    payload: {
      fecha: tomorrow.toISOString().slice(0, 10),
      comision: 'Plenario Legislativo',
      hora_inicio: '15:00',
      titulo: 'Ley Marco del Recurso Hídrico',
      capitulo: 'Capítulo Tercero',
      debate: 'Primer Debate',
    },
    detected_at: new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString(), // 25h antes
    dedup_key: `agenda-23.511-${tomorrow.toISOString().slice(0, 10)}`,
  },
  // 16d crítica: audiencia confirmada
  {
    user_id: USER_ID,
    entity_type: 'expediente',
    entity_id: '23.511',
    alert_type: 'agenda',
    severity: 'critical',
    payload: {
      fecha: tomorrow.toISOString().slice(0, 10),
      comision: 'Comisión Permanente de Asuntos Hacendarios',
      hora_inicio: '10:00',
      titulo: 'Audiencia con INS sobre Ley Marco del Recurso Hídrico',
      entidad: 'Instituto Nacional de Seguros (INS)',
      tipo: 'Audiencia técnica confirmada',
    },
    detected_at: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
    dedup_key: `audiencia-23.511-ins-${tomorrow.toISOString().slice(0, 10)}`,
  },
  // 16d high: moción 137 presentada
  {
    user_id: USER_ID,
    entity_type: 'expediente',
    entity_id: '24.018',
    alert_type: 'state_change',
    severity: 'warning',
    payload: {
      from: 'En comisión',
      to: 'Moción 137 presentada',
      comision: 'Plenario Legislativo',
      fecha: now.toISOString().slice(0, 10),
      titulo: 'Reforma al Reglamento de Donaciones',
      diputado_proponente: 'Carolina Delgado Ramírez',
      firmas: 12,
    },
    detected_at: new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString(),
    dedup_key: `mocion-137-24.018-${now.toISOString().slice(0, 10)}`,
  },
  // 16d info: orden del día rutinaria
  {
    user_id: USER_ID,
    entity_type: 'expediente',
    entity_id: '25.262',
    alert_type: 'mention',
    severity: 'info',
    payload: {
      session_id: 'plenario-2026-05-17',
      segment_ids: ['seg-1', 'seg-2'],
      excerpt: 'El expediente 25.262 fue mencionado en el orden del día de hoy bajo el capítulo de Régimen Interno.',
      comision: 'Plenario Legislativo',
      titulo: 'Modificación a la Ley del Sistema Financiero',
    },
    detected_at: new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString(),
    dedup_key: `mention-25.262-${now.toISOString().slice(0, 10)}`,
  },
  // 16f — comisión Control y Fiscalización
  {
    user_id: USER_ID,
    entity_type: 'expediente',
    entity_id: '24.696',
    alert_type: 'state_change',
    severity: 'warning',
    payload: {
      from: 'En proceso',
      to: 'Recepción en Comisión de Control y Fiscalización de la Hacienda Pública',
      comision: 'Comisión de Control y Fiscalización de la Hacienda Pública',
      fecha: yesterday.toISOString().slice(0, 10),
      titulo: 'Investigación sobre presupuesto extraordinario 2026',
    },
    detected_at: new Date(now.getTime() - 20 * 60 * 60 * 1000).toISOString(),
    dedup_key: `control-fiscalizacion-24.696-${yesterday.toISOString().slice(0, 10)}`,
  },
  // Extra: deadline próximo
  {
    user_id: USER_ID,
    entity_type: 'expediente',
    entity_id: '23.511',
    alert_type: 'deadline',
    severity: 'warning',
    payload: {
      tipo_plazo: 'Dictamen estimado en Comisión',
      articulo_ref: 'Reglamento Art. 81',
      dias_restantes: 7,
      fecha_vencimiento: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      titulo: 'Ley Marco del Recurso Hídrico',
    },
    detected_at: new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString(),
    dedup_key: `deadline-23.511-dictamen-${now.toISOString().slice(0, 10)}`,
  },
];

console.log(`Inserting ${alerts.length} alerts for ${ADMIN_EMAIL}...`);
const { data, error } = await supa
  .from('centinela_alerts')
  .insert(alerts)
  .select();

if (error) {
  console.error('insert failed:', error);
  process.exit(1);
}
console.log(`✓ Inserted ${data.length} alerts`);

// Asegurar que la comisión control esté en watchlist con label legible
await supa
  .from('centinela_watchlist')
  .upsert({
    user_id: USER_ID,
    entity_type: 'comision',
    entity_id: 'control_fiscalizacion_hacienda_publica',
    label: 'Comisión de Control y Fiscalización de la Hacienda Pública',
  }, { onConflict: 'user_id,entity_type,entity_id' });
console.log('✓ Watchlist updated');
