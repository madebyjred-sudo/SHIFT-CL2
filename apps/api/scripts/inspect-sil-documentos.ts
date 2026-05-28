/**
 * Inspect sil_documentos shape — looking for text_extracted, tipo,
 * por_tanto_text, text_resumido, decision_inferida columns.
 *
 * Throwaway script for the LLM enrichment job design pass.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const s = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function main() {
  // 1) Total count + columns
  const { data, error, count } = await s
    .from('sil_documentos')
    .select('*', { count: 'exact' })
    .limit(1);
  if (error) { console.error('err:', error.message); process.exit(1); }
  console.log('rows total:', count);
  if (data && data[0]) {
    console.log('\ncolumns:', Object.keys(data[0]).join(', '));
    // Dump one full row, trimming text_extracted for legibility.
    const r: any = { ...data[0] };
    if (typeof r.text_extracted === 'string') {
      r.text_extracted = r.text_extracted.slice(0, 400) + '... [TRIMMED, len=' + (data[0] as any).text_extracted.length + ']';
    }
    console.log('\nsample row:\n', JSON.stringify(r, null, 2));
  }

  // 2) Distribution of tipo / doc_class — paginated
  console.log('\n--- distribución tipo ---');
  const tipoCounts: Record<string, number> = {};
  const docClassCounts: Record<string, number> = {};
  let from = 0; const PAGE = 1000;
  while (true) {
    const { data, error } = await s.from('sil_documentos').select('tipo, doc_class').range(from, from + PAGE - 1);
    if (error) { console.error('page err:', error.message); break; }
    if (!data || data.length === 0) break;
    for (const r of data as any[]) {
      const t = r.tipo ?? '(null)';
      tipoCounts[t] = (tipoCounts[t] ?? 0) + 1;
      const dc = r.doc_class ?? '(null)';
      docClassCounts[dc] = (docClassCounts[dc] ?? 0) + 1;
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  for (const [t, n] of Object.entries(tipoCounts).sort((a, b) => b[1] - a[1])) {
    console.log('  tipo:', t, '→', n);
  }
  console.log('---');
  for (const [t, n] of Object.entries(docClassCounts).sort((a, b) => b[1] - a[1])) {
    console.log('  doc_class:', t, '→', n);
  }

  // 3) How many ready for resumen
  const { count: pendingResumen } = await s
    .from('sil_documentos')
    .select('id', { count: 'exact', head: true })
    .is('text_resumido', null)
    .gt('text_chars', 500);
  console.log('\npending resumen (text_resumido null, text_chars>500):', pendingResumen);

  // 4) How many ready for POR TANTO (Sala IV / dictamen)
  const { count: pendingPorTanto } = await s
    .from('sil_documentos')
    .select('id', { count: 'exact', head: true })
    .is('por_tanto_text', null)
    .or('tipo.ilike.%dictamen%,tipo.ilike.%sala%,tipo.ilike.%resolucion%')
    .gt('text_chars', 200);
  console.log('pending por_tanto candidates (dictamen/sala/resolucion):', pendingPorTanto);

  // 5) Sample of dictamen/sala docs to see what POR TANTO looks like
  console.log('\n--- sample dictamen/sala text_extracted (looking for POR TANTO) ---');
  const { data: samples } = await s
    .from('sil_documentos')
    .select('id, tipo, text_chars, text_extracted')
    .or('tipo.ilike.%dictamen%,tipo.ilike.%sala%,tipo.ilike.%resolucion%')
    .gt('text_chars', 1000)
    .limit(3);
  for (const r of (samples ?? []) as any[]) {
    console.log('\n>>> id', r.id, 'tipo', r.tipo, 'chars', r.text_chars);
    const txt = String(r.text_extracted ?? '');
    const pt = txt.match(/POR\s+(LO\s+)?TANTO/i);
    if (pt) {
      const i = pt.index!;
      console.log('  POR TANTO found at', i, 'preview:', txt.slice(i, i + 500));
    } else {
      console.log('  no POR TANTO match');
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
