import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { createClient } from '@supabase/supabase-js';

const execAsync = promisify(exec);
const supa = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export async function syncSilPipeline(): Promise<void> {
  console.log('[job:syncSilPipeline] Starting daily SIL E2E update pipeline...');
  const rootDir = process.cwd().includes('apps/worker') ? '../..' : '.';

  try {
    // 0. Find the latest expediente ID to know where to start scraping
    const { data } = await supa.from('sil_expedientes').select('id').order('id', { ascending: false }).limit(1);
    const startFrom = data && data.length > 0 ? data[0].id : 25600;
    const maxExpediente = startFrom + 50; // Try scraping 50 new numbers ahead

    // 1. Scrape new expedientes (metadata)
    console.log(`[job:syncSilPipeline] 1. backfill-sil-webforms from ${startFrom} to ${maxExpediente}`);
    await execAsync(`cd ${rootDir} && START_FROM=${startFrom} MAX_EXPEDIENTE=${maxExpediente} npx tsx scripts/backfill-sil-webforms.ts`);
    
    // 2. Download and index new documents
    console.log('[job:syncSilPipeline] 2. process-sil-docs');
    await execAsync(`cd ${rootDir} && LIMIT=100 npx tsx scripts/process-sil-docs.ts`);
    
    // 3. Enrich expedientes with full detail tabs
    console.log('[job:syncSilPipeline] 3. enrich-sil-expedientes');
    await execAsync(`cd ${rootDir} && RESUME_NULL=1 npx tsx scripts/enrich-sil-expedientes.ts`);
    
    // 4. Test pipeline / Lexa extraction
    console.log('[job:syncSilPipeline] 4. test-lexa');
    // Run the smoke test to verify RAG works on the newly downloaded documents
    await execAsync(`cd ${rootDir} && npx tsx scripts/smoke-rag.ts "Resumen del expediente ${startFrom}"`);
    
    console.log('[job:syncSilPipeline] SIL E2E pipeline finished successfully.');
  } catch (error) {
    console.error('[job:syncSilPipeline] Error running SIL pipeline:', error);
  }
}
