import { createClient } from '@supabase/supabase-js';
import { PredictionServiceClient, helpers } from '@google-cloud/aiplatform';
import 'dotenv/config';
import { searchSilCorpus } from '../apps/api/src/services/silClient.js';

const supa = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const project = process.env.GCP_PROJECT_ID!;
const location = process.env.GCP_LOCATION ?? 'us-central1';
const embedModel = process.env.VERTEX_EMBEDDING_MODEL ?? 'gemini-embedding-001';
const dim = Number(process.env.VERTEX_EMBEDDING_DIM ?? 3072);
const vertex = new PredictionServiceClient({ apiEndpoint: `${location}-aiplatform.googleapis.com` });
const endpoint = `projects/${project}/locations/${location}/publishers/google/models/${embedModel}`;

async function embed(text: string): Promise<number[]> {
  const instance = helpers.toValue({ content: text, task_type: 'RETRIEVAL_QUERY' });
  const parameters = helpers.toValue({ outputDimensionality: dim });
  const [res] = await vertex.predict({ endpoint, instances: instance ? [instance] : [], parameters });
  const decoded = helpers.fromValue(res.predictions?.[0] as never) as any;
  return decoded?.embeddings?.values ?? [];
}

async function run() {
  const months: string[] = [];
  for (let y = 2022; y <= 2026; y++) {
    const maxM = y === 2026 ? 5 : 12;
    for (let m = 1; m <= maxM; m++) months.push(`${y}-${String(m).padStart(2, '0')}`);
  }

  // Build doc set
  const docSet = new Set<number>();
  let off = 0;
  while (true) {
    const { data } = await supa.from('sil_documentos').select('expediente_id').range(off, off + 999);
    if (!data || data.length === 0) break;
    for (const r of data) docSet.add(r.expediente_id as number);
    if (data.length < 1000) break;
    off += 1000;
  }

  // Build chunks set from sil_documentos with text_chars > 0 (means text was extracted AND embedded)
  const embeddedSet = new Set<number>();
  off = 0;
  while (true) {
    const { data } = await supa.from('sil_documentos').select('expediente_id').gt('text_chars', 0).range(off, off + 999);
    if (!data || data.length === 0) break;
    for (const r of data) embeddedSet.add(r.expediente_id as number);
    if (data.length < 1000) break;
    off += 1000;
  }

  console.log('MES        | TOTAL | con_doc | embebidos  | sin_doc | DOC%    | RAG%');
  console.log('-----------|-------|--------|------------|---------|---------|-----');

  const problemMonths: string[] = [];

  for (const month of months) {
    const fromDate = `${month}-01`;
    const y = parseInt(month.split('-')[0]);
    const m = parseInt(month.split('-')[1]);
    const lastDay = new Date(y, m, 0).getDate();
    const toDate = `${month}-${lastDay}`;

    const { data: exps } = await supa
      .from('sil_expedientes')
      .select('id')
      .gte('fecha_presentacion', fromDate)
      .lte('fecha_presentacion', toDate);

    const total = exps?.length ?? 0;
    if (total === 0) { console.log(`${month}    |     0 |      - |          - |       - |       - |    -`); continue; }

    let withDoc = 0, withEmbed = 0;
    const missingDoc: number[] = [];
    for (const e of (exps ?? [])) {
      if (docSet.has(e.id)) withDoc++;
      else missingDoc.push(e.id);
      if (embeddedSet.has(e.id)) withEmbed++;
    }

    const docPct = ((withDoc / total) * 100).toFixed(0);
    const ragPct = ((withEmbed / total) * 100).toFixed(0);
    const flag = parseInt(docPct) < 80 ? ' ← BAJO' : '';
    console.log(`${month}    | ${String(total).padStart(5)} | ${String(withDoc).padStart(6)} | ${String(withEmbed).padStart(10)} | ${String(missingDoc.length).padStart(7)} | ${docPct.padStart(5)}%  | ${ragPct.padStart(3)}%${flag}`);
    if (parseInt(docPct) < 80) problemMonths.push(month);
  }

  // RAG spot-check: pick DIFFERENT expedientes per quarter
  console.log('\n=== RAG SPOT-CHECK (1 consulta real por trimestre) ===\n');
  const quarters = [
    { q: 'Q1-2022', from: '2022-01-01', to: '2022-03-31' },
    { q: 'Q3-2022', from: '2022-07-01', to: '2022-09-30' },
    { q: 'Q1-2023', from: '2023-01-01', to: '2023-03-31' },
    { q: 'Q3-2023', from: '2023-07-01', to: '2023-09-30' },
    { q: 'Q1-2024', from: '2024-01-01', to: '2024-03-31' },
    { q: 'Q3-2024', from: '2024-07-01', to: '2024-09-30' },
    { q: 'Q1-2025', from: '2025-01-01', to: '2025-03-31' },
    { q: 'Q3-2025', from: '2025-07-01', to: '2025-09-30' },
    { q: 'Q1-2026', from: '2026-01-01', to: '2026-03-31' },
    { q: 'Q2-2026', from: '2026-04-01', to: '2026-05-31' },
  ];

  for (const { q, from, to } of quarters) {
    // Pick an expediente that HAS a doc
    const { data: sample } = await supa
      .from('sil_expedientes')
      .select('id, numero, titulo')
      .gte('fecha_presentacion', from)
      .lte('fecha_presentacion', to)
      .not('titulo', 'is', null)
      .order('id', { ascending: false })
      .limit(1);

    if (!sample || sample.length === 0) { console.log(`${q}: Sin expedientes`); continue; }
    const exp = sample[0];

    // Check if it has chunks directly
    const { count: chunkCount } = await supa
      .from('legislative_chunks')
      .select('id', { count: 'exact', head: true })
      .like('source_ref', `%${exp.numero}%`);

    // Also do a vector search (using Lexa's Option C: Hybrid + Self Querying)
    try {
      const query = `Resumen del expediente ${exp.numero} ${(exp.titulo ?? '').slice(0, 50)}`;
      const hits = await searchSilCorpus({ query, k: 3, expediente_numero: exp.numero });
      const topHit = hits?.[0];
      const sim = topHit ? `${(topHit.similarity * 100).toFixed(1)}%` : 'N/A';
      const directMatch = (hits ?? []).some((h: any) => h.source_ref?.includes(exp.numero));
      const chunks = chunkCount ?? 0;
      const icon = chunks > 0 && directMatch ? '✅' : chunks > 0 ? '🟡' : '❌';
      console.log(`${q.padEnd(8)} | Exp. ${exp.numero.padEnd(7)} | ${icon} chunks=${chunks} sim=${sim} | ${(exp.titulo ?? '').slice(0, 50)}`);
    } catch (err) {
      console.log(`${q.padEnd(8)} | Exp. ${exp.numero.padEnd(7)} | ❌ ERROR: ${(err as Error).message.slice(0, 60)}`);
    }
  }

  if (problemMonths.length > 0) {
    console.log(`\n⚠️  MESES CON COBERTURA <80%: ${problemMonths.join(', ')}`);
  } else {
    console.log('\n✅ Todos los meses 2022-2026 tienen cobertura de documentos ≥80%.');
  }
}

run().catch(e => { console.error(e); process.exit(1); });
