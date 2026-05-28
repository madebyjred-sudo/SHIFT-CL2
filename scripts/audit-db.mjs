/**
 * Auditoría completa y rigurosa de la DB CL2 — v2 con nombres reales.
 */
import { createClient } from '@supabase/supabase-js';

const supa = createClient(
  'https://romccykiucfltfdfatrx.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

async function rowCount(table) {
  const { count, error } = await supa.from(table).select('*', { count: 'exact', head: true });
  return error ? `ERR: ${error.message}` : count;
}

async function paginatedUnique(table, col) {
  const ids = new Set();
  let total = 0;
  for (let off = 0; off < 200_000; off += 1000) {
    const { data, error } = await supa.from(table).select(col).range(off, off + 999);
    if (error) return { error: error.message };
    if (!data || data.length === 0) break;
    for (const r of data) ids.add(r[col]);
    total += data.length;
    if (data.length < 1000) break;
  }
  return { uniqueCount: ids.size, totalRows: total };
}

async function countWhere(table, build) {
  let q = supa.from(table).select('*', { count: 'exact', head: true });
  q = build(q);
  const { count, error } = await q;
  return error ? `ERR: ${error.message}` : count;
}

async function groupBy(table, col, max = 15) {
  const map = new Map();
  for (let off = 0; off < 200_000; off += 1000) {
    const { data, error } = await supa.from(table).select(col).range(off, off + 999);
    if (error) return [['ERR ' + error.message, 0]];
    if (!data || data.length === 0) break;
    for (const r of data) {
      const v = r[col] ?? '(null)';
      map.set(v, (map.get(v) ?? 0) + 1);
    }
    if (data.length < 1000) break;
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, max);
}

const out = [];
const log = (s = '') => out.push(s);

(async () => {
  log('═══════════════════════════════════════════════════════════════════');
  log('   AUDITORÍA COMPLETA DB CL2  —  ' + new Date().toISOString().slice(0, 19) + 'Z');
  log('═══════════════════════════════════════════════════════════════════');

  // ───────── 1. CATÁLOGO MAESTRO ─────────
  log('\n┌─ 1. CATÁLOGO MAESTRO ─────────────────────────────────────────────');
  const expTotal = await rowCount('sil_expedientes');
  const expConFecha = await countWhere('sil_expedientes', (q) => q.not('fecha_presentacion', 'is', null));
  log(`│ sil_expedientes (todos los exps de la Asamblea): ${expTotal}`);
  log(`│   └─ con fecha_presentacion poblada:             ${expConFecha} (${((100 * expConFecha) / expTotal).toFixed(1)}%)`);
  log('└─');

  // ───────── 2. DOCUMENTOS DEL SIL ─────────
  log('\n┌─ 2. DOCUMENTOS DEL SIL (sil_documentos) ──────────────────────────');
  const docTotal = await rowCount('sil_documentos');
  const docConStorage = await countWhere('sil_documentos', (q) => q.not('storage_path', 'is', null));
  const docPending = await countWhere('sil_documentos', (q) => q.eq('embed_status', 'pending'));
  const docIndexed = await countWhere('sil_documentos', (q) => q.eq('embed_status', 'indexed'));
  const docFailed = await countWhere('sil_documentos', (q) => q.eq('embed_status', 'failed'));
  const docOther = await countWhere('sil_documentos', (q) => q.not('embed_status', 'in', '("pending","indexed","failed")'));
  log(`│ Total documentos:                    ${docTotal}`);
  log(`│   ├─ con storage_path (DESCARGADOS):  ${docConStorage}`);
  log(`│   ├─ embed_status='indexed' (CITABLES): ${docIndexed}`);
  log(`│   ├─ embed_status='pending':           ${docPending}`);
  log(`│   ├─ embed_status='failed':            ${docFailed}`);
  log(`│   └─ embed_status='otro':              ${docOther}`);
  log('│');
  log('│ Breakdown por tipo:');
  const tipos = await groupBy('sil_documentos', 'tipo');
  for (const [t, n] of tipos) log(`│   ${String(n).padStart(6)}  ${t}`);
  log('│');
  log('│ Breakdown por embed_status:');
  const statuses = await groupBy('sil_documentos', 'embed_status');
  for (const [s, n] of statuses) log(`│   ${String(n).padStart(6)}  ${s}`);
  log('└─');

  // ───────── 3. LEGISLATIVE_CHUNKS (lo que Lexa cita) ─────────
  log('\n┌─ 3. LEGISLATIVE_CHUNKS — corpus que Lexa puede citar ──────────────');
  const chunksTotal = await rowCount('legislative_chunks');
  log(`│ Total chunks indexados:              ${chunksTotal}`);
  log('│');
  log('│ Por source_type:');
  const lc = await groupBy('legislative_chunks', 'source_type');
  for (const [t, n] of lc) log(`│   ${String(n).padStart(6)}  ${t}`);
  log('│');
  // Sessions únicos en chunks
  const chunksBySession = await paginatedUnique('legislative_chunks', 'session_id');
  if (!chunksBySession.error) log(`│ sesiones únicos con chunks:          ${chunksBySession.uniqueCount}`);
  log('└─');

  // ───────── 4. SESIONES PLENARIAS ─────────
  log('\n┌─ 4. SESIONES PLENARIAS (sessions + transcript_segments) ──────────');
  const sessTotal = await rowCount('sessions');
  log(`│ Total sesiones en 'sessions':        ${sessTotal}`);
  log('│');
  // Status de sesiones
  log('│ Por status:');
  const sessStatus = await groupBy('sessions', 'status');
  for (const [s, n] of sessStatus) log(`│   ${String(n).padStart(6)}  ${s}`);
  log('│');
  const segTotal = await rowCount('transcript_segments');
  log(`│ Total transcript_segments:           ${segTotal}`);
  const sessConSegments = await paginatedUnique('transcript_segments', 'session_id');
  if (!sessConSegments.error) {
    log(`│   └─ sesiones únicos con segments:    ${sessConSegments.uniqueCount}  (← transcritas)`);
  }
  log('│');
  // Sesiones con resumen
  const sessFields = await supa.from('sessions').select('*').limit(1);
  const sessCols = Object.keys(sessFields.data?.[0] ?? {});
  if (sessCols.includes('resumen_ejecutivo')) {
    const conResumen = await countWhere('sessions', (q) => q.not('resumen_ejecutivo', 'is', null));
    log(`│ con resumen_ejecutivo:               ${conResumen}`);
  }
  if (sessCols.includes('transcript_url')) {
    const conTranscript = await countWhere('sessions', (q) => q.not('transcript_url', 'is', null));
    log(`│ con transcript_url:                  ${conTranscript}`);
  }
  log(`│ columnas en 'sessions': ${sessCols.join(', ')}`);
  log('│');
  // Correcciones
  const correcciones = await rowCount('transcript_corrections');
  log(`│ transcript_corrections (revisión):   ${correcciones}`);
  const transcripcionesReview = await rowCount('transcripciones_review');
  log(`│ transcripciones_review:              ${transcripcionesReview}`);
  log('└─');

  // ───────── 5. EXPEDIENTES ENRIQUECIDOS (los 28 pedidos) ─────────
  log('\n┌─ 5. ENRICH POR EXPEDIENTE (post 28 pedidos del 14-may) ───────────');
  const enriched = [
    ['sil_expediente_proponentes', 'Proponentes con orden de firma'],
    ['sil_expediente_documentos', 'Docs metadata (no descarga)'],
    ['sil_expediente_audiencias', 'Audiencias programadas'],
    ['sil_expediente_consultas', 'Consultas institucionales'],
    ['sil_expediente_consultas_sala', 'Consultas a Sala IV'],
    ['sil_expediente_orden_dia_apariciones', 'Apariciones en orden del día (cap/debate)'],
    ['sil_expediente_actas_indexadas', 'Actas indexadas'],
    ['sil_expediente_fechas_vigentes', 'Fechas estimadas vigentes'],
    ['sil_expediente_tramite', 'Eventos de trámite'],
    ['sil_expediente_convocatoria', 'Convocatorias ejecutivas por expediente'],
  ];
  for (const [t, desc] of enriched) {
    const filas = await rowCount(t);
    if (typeof filas === 'string') {
      log(`│ ${t.padEnd(42)} ERR`);
      continue;
    }
    const u = await paginatedUnique(t, 'expediente_id');
    log(`│ ${t.padEnd(42)} filas ${String(filas).padStart(6)} | exps ${String(u.uniqueCount).padStart(5)} — ${desc}`);
  }
  log('└─');

  // ───────── 6. RAL / REGLAMENTO ─────────
  log('\n┌─ 6. RAL — Reglamento de la Asamblea (corpus doctrinal) ──────────');
  const ral = ['ral_articulos', 'ral_reglas', 'ral_interpretaciones', 'reglamento_plazos'];
  for (const t of ral) {
    log(`│ ${t.padEnd(30)} ${await rowCount(t)}`);
  }
  log('└─');

  // ───────── 7. LEYES + AFECTACIONES + DOCTRINA ─────────
  log('\n┌─ 7. LEYES + AFECTACIONES + DOCTRINA ──────────────────────────────');
  for (const t of ['sil_leyes', 'sil_leyes_afectaciones', 'doctrina_pdfs']) {
    log(`│ ${t.padEnd(35)} ${await rowCount(t)}`);
  }
  log('└─');

  // ───────── 8. CENTINELA ─────────
  log('\n┌─ 8. CENTINELA — vigilancia + alertas + eventos ───────────────────');
  for (const t of ['centinela_watchlist', 'centinela_alerts', 'centinela_eventos', 'centinela_alert_prefs']) {
    log(`│ ${t.padEnd(30)} ${await rowCount(t)}`);
  }
  log('└─');

  // ───────── 9. SHAREPOINT / CRAWLERS ─────────
  log('\n┌─ 9. SHAREPOINT / CRAWLERS (alimentación) ─────────────────────────');
  for (const t of ['sil_sharepoint_raw', 'sharepoint_cursors', 'agenda_legislativa', 'lista_despacho_items', 'decretos_ejecutivos', 'estado_plenario_actual']) {
    log(`│ ${t.padEnd(30)} ${await rowCount(t)}`);
  }
  log('│');
  const { data: cursors } = await supa.from('sharepoint_cursors').select('list_title, last_run_at').order('last_run_at', { ascending: false });
  log('│ Últimas corridas del crawler SharePoint:');
  for (const c of cursors ?? []) log(`│   ${c.last_run_at?.slice(0, 16)}  ${c.list_title?.slice(0, 45)}`);
  log('└─');

  // ───────── 10. USO + WORKSPACE ─────────
  log('\n┌─ 10. USUARIOS + USO + WORKSPACE ──────────────────────────────────');
  for (const t of ['user_access', 'user_profile', 'conversations', 'messages', 'ai_call_log', 'audit_log', 'bug_reports', 'workspaces', 'workspace_nodes', 'workspace_citations']) {
    log(`│ ${t.padEnd(28)} ${await rowCount(t)}`);
  }
  log('└─');

  console.log(out.join('\n'));
})().catch((e) => { console.error(e); process.exit(1); });
