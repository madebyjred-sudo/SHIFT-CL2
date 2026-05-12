/**
 * audit-sil-coverage.ts — mide la cobertura de documentos por rango y por
 * tipo. Útil antes/después de un bulk para saber el delta real.
 *
 * Uso:
 *   node --env-file=.env.local --import tsx scripts/audit-sil-coverage.ts
 *
 * Opcional:
 *   AUDIT_RANGES="15000-18000,18000-20000,20000-22000,22000-24000,24000-26000"
 *     Override de los buckets de análisis.
 */
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

interface BucketStat {
  lo: number;
  hi: number;
  total: number;
  conDoc: number;
  sinDoc: number;
  docsDocx: number;
  docsPdf: number;
  docsTextoBase: number;
  docsDictamen: number;
  docsTecnico: number;
  bytesP50: number;
  bytesP95: number;
}

async function fetchBucket(lo: number, hi: number): Promise<BucketStat> {
  // Supabase default limit is 1000 — necesitamos paginar para totales reales
  const idList: number[] = [];
  let offset = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await sb
      .from('sil_expedientes')
      .select('id')
      .gte('id', lo)
      .lt('id', hi)
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    idList.push(...data.map((d) => d.id));
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  const total = idList.length;
  if (total === 0) return { lo, hi, total: 0, conDoc: 0, sinDoc: 0, docsDocx: 0, docsPdf: 0, docsTextoBase: 0, docsDictamen: 0, docsTecnico: 0, bytesP50: 0, bytesP95: 0 };

  // docs por expediente — paginar por chunks de ids
  const docs: { expediente_id: number; mime_type: string | null; tipo: string; gcs_path: string }[] = [];
  for (let i = 0; i < idList.length; i += 500) {
    const chunk = idList.slice(i, i + 500);
    const { data, error } = await sb
      .from('sil_documentos')
      .select('expediente_id, mime_type, tipo, gcs_path')
      .in('expediente_id', chunk);
    if (error) throw error;
    if (data) docs.push(...(data as any));
  }

  const conDocSet = new Set<number>();
  let docsDocx = 0, docsPdf = 0;
  let docsTextoBase = 0, docsDictamen = 0, docsTecnico = 0;

  for (const d of docs) {
    conDocSet.add(d.expediente_id);
    const mime = (d.mime_type ?? '').toLowerCase();
    const path = (d.gcs_path ?? '').toLowerCase();
    if (mime.includes('pdf') || path.endsWith('.pdf')) docsPdf += 1;
    else docsDocx += 1; // default DOCX para pre-0029
    if (d.tipo === 'texto_base') docsTextoBase += 1;
    else if (d.tipo === 'dictamen') docsDictamen += 1;
    else if (d.tipo === 'tecnico') docsTecnico += 1;
  }

  const conDoc = conDocSet.size;
  const sinDoc = total - conDoc;

  return {
    lo, hi, total, conDoc, sinDoc, docsDocx, docsPdf,
    docsTextoBase, docsDictamen, docsTecnico,
    bytesP50: 0, bytesP95: 0,
  };
}

async function main() {
  const rangesEnv = process.env.AUDIT_RANGES ??
    '15000-18000,18000-20000,20000-22000,22000-24000,24000-26000';
  const ranges = rangesEnv.split(',').map((r) => {
    const [lo, hi] = r.split('-').map(Number);
    return { lo, hi };
  });

  console.log('rango      total  con_doc  sin_doc  cov%  docx  pdf  texto_base  dict  tec');
  console.log('─────────  ─────  ──────  ──────  ────  ───  ───  ──────────  ────  ───');

  let grandTotal = 0, grandConDoc = 0;

  for (const { lo, hi } of ranges) {
    const s = await fetchBucket(lo, hi);
    grandTotal += s.total;
    grandConDoc += s.conDoc;
    const cov = s.total > 0 ? (100 * s.conDoc / s.total).toFixed(1) : '—';
    console.log(
      `${lo}-${hi}`.padEnd(11) +
      ` ${String(s.total).padStart(5)}` +
      ` ${String(s.conDoc).padStart(6)}` +
      ` ${String(s.sinDoc).padStart(7)}` +
      ` ${cov.padStart(4)}%` +
      ` ${String(s.docsDocx).padStart(4)}` +
      ` ${String(s.docsPdf).padStart(4)}` +
      ` ${String(s.docsTextoBase).padStart(10)}` +
      ` ${String(s.docsDictamen).padStart(5)}` +
      ` ${String(s.docsTecnico).padStart(4)}`,
    );
  }

  console.log('─'.repeat(75));
  const grandCov = grandTotal > 0 ? (100 * grandConDoc / grandTotal).toFixed(1) : '—';
  console.log(`TOTAL      ${String(grandTotal).padStart(5)} ${String(grandConDoc).padStart(6)}  cov=${grandCov}%`);
}

main().catch((e) => { console.error(e); process.exit(1); });
