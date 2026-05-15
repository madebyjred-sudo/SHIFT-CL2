/**
 * rechunk-corpus-jurisprudencia.ts
 *
 * Track G — Heurística "POR TANTO" re-chunking retroactivo
 * Sprint 1 CL2 v3 · 2026-05-14
 *
 * Aplica la heurística legalDocChunker al corpus sil_documentos existente.
 * Para cada documento que ya tiene text_extracted (status = parsed | embedded),
 * corre chunkLegalDoc y actualiza:
 *   - doc_class
 *   - chunks_strategy
 *   - text_resumido
 *   - por_tanto_text
 *   - decision_inferida
 *
 * NO re-embedea — eso se puede encolar por separado una vez que se haya
 * validado que el chunking es correcto. Ver Track A para el pipeline de embed.
 *
 * Run (dry-run, muestra stats sin escribir):
 *   DRY_RUN=1 tsx -r dotenv/config scripts/rechunk-corpus-jurisprudencia.ts dotenv_config_path=.env.local
 *
 * Run (producción):
 *   tsx -r dotenv/config scripts/rechunk-corpus-jurisprudencia.ts dotenv_config_path=.env.local
 *
 * Variables de entorno necesarias:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Opcionales:
 *   LIMIT       → número máximo de docs a procesar (default: 1000)
 *   DRY_RUN     → si '1', no escribe en DB (solo loguea)
 *   ONLY_TIPOS  → CSV de tipos de doc a filtrar (default: todos)
 *               Ej: ONLY_TIPOS=dictamen_mayoria,dictamen_minoria
 *
 * Resumable: docs con chunks_strategy != 'standard' se saltan
 * (ya procesados) a menos que FORCE=1.
 */

import 'dotenv/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  chunkLegalDoc,
  type ChunkedLegalDoc,
} from '../apps/api/src/services/legalDocChunker.js';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LIMIT = parseInt(process.env.LIMIT ?? '1000', 10);
const DRY_RUN = process.env.DRY_RUN === '1';
const FORCE = process.env.FORCE === '1';
const ONLY_TIPOS = process.env.ONLY_TIPOS
  ? process.env.ONLY_TIPOS.split(',').map(s => s.trim())
  : null;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface SilDocRow {
  id: string;
  tipo: string;
  titulo: string | null;
  source_url: string;
  text_extracted: string | null;
  chunks_strategy: string | null;
  doc_class: string | null;
}

interface ProcessStats {
  total: number;
  skipped_no_text: number;
  skipped_already_chunked: number;
  processed: number;
  por_tanto_applied: number;
  standard_fallback: number;
  errors: number;
  tokens_saved_total: number;
  by_doc_class: Record<string, number>;
  by_decision: Record<string, number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  if (!SUPA_URL || !SUPA_KEY) {
    console.error('ERROR: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY son requeridos.');
    process.exit(1);
  }

  const supa: SupabaseClient = createClient(SUPA_URL, SUPA_KEY);

  console.log('='.repeat(60));
  console.log('rechunk-corpus-jurisprudencia — Track G Sprint 1 CL2 v3');
  console.log('='.repeat(60));
  console.log(`DRY_RUN=${DRY_RUN} | FORCE=${FORCE} | LIMIT=${LIMIT}`);
  if (ONLY_TIPOS) console.log(`ONLY_TIPOS=${ONLY_TIPOS.join(',')}`);
  console.log('');

  // ── Query docs con texto extraído ─────────────────────────────────────────
  let query = supa
    .from('sil_documentos')
    .select('id, tipo, titulo, source_url, text_extracted, chunks_strategy, doc_class')
    .not('text_extracted', 'is', null)
    .in('status', ['parsed', 'embedded'])
    .limit(LIMIT);

  if (ONLY_TIPOS) {
    query = query.in('tipo', ONLY_TIPOS);
  }

  if (!FORCE) {
    // Skip docs already processed with por_tanto or paragrafo
    query = query.eq('chunks_strategy', 'standard');
  }

  // Also prioritize legal document types
  query = query.order('tipo', { ascending: false }); // dictamen* first

  const { data: docs, error } = await query;
  if (error) {
    console.error('Supabase query error:', error.message);
    process.exit(1);
  }

  const rows = (docs ?? []) as SilDocRow[];
  console.log(`Docs a procesar: ${rows.length}`);
  console.log('');

  const stats: ProcessStats = {
    total: rows.length,
    skipped_no_text: 0,
    skipped_already_chunked: 0,
    processed: 0,
    por_tanto_applied: 0,
    standard_fallback: 0,
    errors: 0,
    tokens_saved_total: 0,
    by_doc_class: {},
    by_decision: {},
  };

  // ── Process each doc ──────────────────────────────────────────────────────
  for (const doc of rows) {
    if (!doc.text_extracted || doc.text_extracted.trim().length < 50) {
      stats.skipped_no_text++;
      continue;
    }

    if (!FORCE && doc.chunks_strategy && doc.chunks_strategy !== 'standard') {
      stats.skipped_already_chunked++;
      continue;
    }

    let result: ChunkedLegalDoc;
    try {
      result = chunkLegalDoc(doc.text_extracted, {
        fileName: doc.titulo ?? doc.source_url,
      });
    } catch (err) {
      console.error(`  ERROR procesando ${doc.id}: ${(err as Error).message}`);
      stats.errors++;
      continue;
    }

    const tokensSaved = result.tokens_full_estimate - result.tokens_resumido_estimate;
    const reductionPct = Math.round((tokensSaved / result.tokens_full_estimate) * 100);

    // Stats
    stats.processed++;
    stats.tokens_saved_total += tokensSaved;
    stats.by_doc_class[result.doc_class] = (stats.by_doc_class[result.doc_class] ?? 0) + 1;

    if (result.strategy === 'por_tanto') {
      stats.por_tanto_applied++;
      if (result.decision_inferida) {
        stats.by_decision[result.decision_inferida] = (stats.by_decision[result.decision_inferida] ?? 0) + 1;
      }
    } else {
      stats.standard_fallback++;
    }

    console.log(
      `[${stats.processed}/${rows.length}] ${doc.id.slice(0, 8)}... ` +
      `${result.doc_class} | ${result.strategy} | ` +
      `tokens: ${result.tokens_full_estimate} → ${result.tokens_resumido_estimate} (-${reductionPct}%)` +
      (result.decision_inferida ? ` | ${result.decision_inferida}` : '')
    );

    if (DRY_RUN) continue;

    // ── Write to DB ─────────────────────────────────────────────────────────
    const { error: updateErr } = await supa
      .from('sil_documentos')
      .update({
        doc_class: result.doc_class,
        chunks_strategy: result.strategy,
        text_resumido: result.text_resumido,
        por_tanto_text: result.por_tanto_text ?? null,
        decision_inferida: result.decision_inferida ?? null,
      })
      .eq('id', doc.id);

    if (updateErr) {
      console.error(`  ERROR update ${doc.id}: ${updateErr.message}`);
      stats.errors++;
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('');
  console.log('='.repeat(60));
  console.log('RESUMEN');
  console.log('='.repeat(60));
  console.log(`Total encontrados:          ${stats.total}`);
  console.log(`Sin texto:                  ${stats.skipped_no_text}`);
  console.log(`Ya procesados (skip):       ${stats.skipped_already_chunked}`);
  console.log(`Procesados:                 ${stats.processed}`);
  console.log(`  → POR TANTO aplicado:     ${stats.por_tanto_applied}`);
  console.log(`  → Fallback standard:      ${stats.standard_fallback}`);
  console.log(`  → Errores:                ${stats.errors}`);
  console.log(`Tokens ahorrados (total):   ${stats.tokens_saved_total.toLocaleString()}`);
  console.log('');
  console.log('Por clase de documento:');
  for (const [cls, count] of Object.entries(stats.by_doc_class).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cls.padEnd(35)} ${count}`);
  }
  if (Object.keys(stats.by_decision).length > 0) {
    console.log('');
    console.log('Por decisión inferida:');
    for (const [dec, count] of Object.entries(stats.by_decision).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${dec.padEnd(35)} ${count}`);
    }
  }

  if (DRY_RUN) {
    console.log('');
    console.log('[DRY_RUN] Ningún cambio fue escrito en la base de datos.');
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
