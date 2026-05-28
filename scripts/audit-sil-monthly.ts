import { createClient } from '@supabase/supabase-js';
import { PredictionServiceClient, helpers } from '@google-cloud/aiplatform';
import 'dotenv/config';

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
  // Build month list 2022-01 to 2026-05
  const months: string[] = [];
  for (let y = 2022; y <= 2026; y++) {
    const maxM = y === 2026 ? 5 : 12;
    for (let m = 1; m <= maxM; m++) {
      months.push(`${y}-${String(m).padStart(2, '0')}`);
    }
  }

  // Get all doc expediente_ids
  const docSet = new Set<number>();
  let off = 0;
  while (true) {
    const { data } = await supa.from('sil_documentos').select('expediente_id').range(off, off + 999);
    if (!data || data.length === 0) break;
    for (const r of data) docSet.add(r.expediente_id as number);
    if (data.length < 1000) break;
    off += 1000;
  }

  // Get all chunks source_refs for quick lookup
  const chunkExpSet = new Set<number>();
  const { data: chunkSample } = await supa
    .from('legislative_chunks')
    .select('source_ref')
    .like('source_ref', 'Exp.%')
    .limit(50000);
  for (const c of (chunkSample ?? [])) {
    const m = (c.source_ref as string).match(/Exp\.\s*([\d.]+)/);
    if (m) {
      const id = parseInt(m[1].replace('.', ''));
      chunkExpSet.add(id);
    }
  }

  console.log('MES        | TOTAL | con_doc | con_chunks | sin_doc | COBERTURA | RAG_OK');
  console.log('-----------|-------|--------|------------|---------|-----------|-------');

  const gapMonths: string[] = [];
  
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
    if (total === 0) {
      console.log(`${month}    |     0 |      - |          - |       - |         - |     -`);
      gapMonths.push(month);
      continue;
    }

    let withDoc = 0;
    let withChunks = 0;
    const missingIds: number[] = [];
    for (const e of (exps ?? [])) {
      if (docSet.has(e.id)) withDoc++;
      else missingIds.push(e.id);
      if (chunkExpSet.has(e.id)) withChunks++;
    }

    const pct = ((withDoc / total) * 100).toFixed(0);
    const ragPct = ((withChunks / total) * 100).toFixed(0);
    const flag = parseInt(pct) < 80 ? ' ← BAJO' : '';
    console.log(`${month}    | ${String(total).padStart(5)} | ${String(withDoc).padStart(6)} | ${String(withChunks).padStart(10)} | ${String(missingIds.length).padStart(7)} | ${pct.padStart(7)}%  | ${ragPct.padStart(4)}%${flag}`);
    
    if (parseInt(pct) < 80) gapMonths.push(month);
  }

  // RAG spot-check: pick one expediente per quarter and query Lexa's vector store
  console.log('\n=== RAG SPOT-CHECK (1 query por trimestre) ===\n');
  const quarters = ['2022-03', '2022-09', '2023-03', '2023-09', '2024-03', '2024-09', '2025-03', '2025-09', '2026-03'];
  
  for (const q of quarters) {
    const fromDate = `${q}-01`;
    const { data: sample } = await supa
      .from('sil_expedientes')
      .select('id, numero, titulo')
      .gte('fecha_presentacion', fromDate)
      .not('titulo', 'is', null)
      .limit(1);
    
    if (!sample || sample.length === 0) { console.log(`${q}: No hay expedientes`); continue; }
    
    const exp = sample[0];
    const query = `¿De qué trata el expediente ${exp.numero}?`;
    
    try {
      const vec = await embed(query);
      const { data: hits } = await supa.rpc('match_chunks', {
        query_embedding: vec,
        match_count: 3,
        filter_session_id: null,
        filter_comision: null,
        filter_fecha_from: null,
        filter_fecha_to: null,
      });
      
      const relevant = (hits ?? []).filter((h: any) => 
        h.source_ref?.includes(exp.numero) || h.content?.includes(String(exp.id))
      );
      
      const status = relevant.length > 0 ? '✅ CITABLE' : '⚠️ no encontrado directo';
      const topSim = hits?.[0] ? `(top sim: ${(hits[0].similarity * 100).toFixed(1)}%)` : '';
      console.log(`${q} | Exp. ${exp.numero} | ${status} ${topSim}`);
    } catch (err) {
      console.log(`${q} | Exp. ${exp.numero} | ❌ ERROR: ${(err as Error).message}`);
    }
  }

  if (gapMonths.length > 0) {
    console.log(`\n⚠️  MESES CON BAJA COBERTURA: ${gapMonths.join(', ')}`);
  } else {
    console.log('\n✅ Todos los meses tienen buena cobertura de documentos.');
  }
}

run().catch(e => { console.error(e); process.exit(1); });
