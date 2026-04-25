/**
 * Backfill fecha column in sessions table for rows where fecha IS NULL.
 *
 * Re-runs parseTitle against the YouTube title stored in metadata.title.
 * Fixes ~all "fecha desconocida" UX warts in citations without re-fetching
 * oEmbed (titles are already cached).
 *
 * Run: npx tsx -r dotenv/config scripts/backfill-session-fechas.ts dotenv_config_path=.env.local [--dry-run]
 */
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) throw new Error('Supabase env missing');

const supa = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });
const dryRun = process.argv.includes('--dry-run');

const MONTHS_ES: Record<string, string> = {
  enero: '01', febrero: '02', marzo: '03', abril: '04', mayo: '05', junio: '06',
  julio: '07', agosto: '08', septiembre: '09', setiembre: '09', octubre: '10',
  noviembre: '11', diciembre: '12',
  // English months too — some YT titles are EN.
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
};

function extractFecha(title: string | null | undefined): string | null {
  if (!title) return null;

  // Pattern A: "17 de marzo de 2026" / "17 marzo 2026" / "17Marzo 2026" (no space)
  const a = title.match(/(\d{1,2})\s*(?:de\s+)?([A-Za-zÁÉÍÓÚáéíóúñÑ]+)\s+(?:de\s+)?(\d{4})/);
  if (a) {
    const day = a[1].padStart(2, '0');
    const month = MONTHS_ES[a[2].toLowerCase()];
    if (month) return `${a[3]}-${month}-${day}`;
  }

  // Pattern B: "marzo 17, 2026" / "March 17 2026"
  const b = title.match(/(\w+)\s+(\d{1,2})[,\s]+(\d{4})/i);
  if (b) {
    const month = MONTHS_ES[b[1].toLowerCase()];
    if (month) {
      const day = b[2].padStart(2, '0');
      return `${b[3]}-${month}-${day}`;
    }
  }

  // Pattern C: ISO-ish "2026-03-17" or "2026/03/17"
  const c = title.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (c) {
    return `${c[1]}-${c[2].padStart(2, '0')}-${c[3].padStart(2, '0')}`;
  }

  // Pattern D: "17/03/2026" or "17-03-2026" (DMY)
  const d = title.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (d) {
    return `${d[3]}-${d[2].padStart(2, '0')}-${d[1].padStart(2, '0')}`;
  }

  return null;
}

interface SessionRow {
  id: string;
  legacy_video_id: string | null;
  fecha: string | null;
  metadata: { title?: string | null } | null;
}

async function main() {
  console.log(`[backfill] dry-run=${dryRun}`);

  const { data, error } = await supa
    .from('sessions')
    .select('id, legacy_video_id, fecha, metadata')
    .is('fecha', null);

  if (error) throw new Error(`select sessions: ${error.message}`);
  const rows = (data ?? []) as SessionRow[];
  console.log(`[backfill] found ${rows.length} sessions with fecha=null`);

  let updated = 0;
  let stillUnknown = 0;
  for (const row of rows) {
    const title = row.metadata?.title ?? null;
    const fecha = extractFecha(title);
    if (!fecha) {
      stillUnknown++;
      console.log(`[skip] ${row.legacy_video_id} title="${title ?? '(none)'}"`);
      continue;
    }
    console.log(`[ok ] ${row.legacy_video_id} → ${fecha}  (from "${title}")`);
    if (!dryRun) {
      const { error: updErr } = await supa
        .from('sessions')
        .update({ fecha, updated_at: new Date().toISOString() })
        .eq('id', row.id);
      if (updErr) {
        console.error(`[err] update ${row.id}: ${updErr.message}`);
        continue;
      }
    }
    updated++;
  }

  console.log(
    `\n[backfill] done. ${updated} updated, ${stillUnknown} still unknown, ${rows.length} total. ${dryRun ? '(dry-run, nothing written)' : ''}`,
  );
}

main().catch((err) => {
  console.error('[backfill] fatal', err);
  process.exit(1);
});
