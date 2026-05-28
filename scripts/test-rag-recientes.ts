import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function run() {
  const exps = Array.from({ length: 46 }, (_, i) => 25555 + i);
  console.log("Verificando chunks de expedientes recientes en Vertex AI / Supabase...");
  
  let missing = 0;
  let found = 0;
  for (const exp of exps) {
    const { count } = await supa
      .from('legislative_chunks')
      .select('*', { count: 'exact', head: true })
      .eq('metadata->>sil_expediente_id', String(exp));
      
    if ((count ?? 0) > 0) {
      found++;
    } else {
      missing++;
      console.log(`Expediente ${exp} NO tiene chunks.`);
    }
  }
  
  console.log(`\nResumen: ${found} indexados exitosamente, ${missing} faltantes.`);
}
run();
