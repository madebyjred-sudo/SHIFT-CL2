import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function expIdToNumero(id: number): string {
  const s = String(id);
  if (s.length <= 3) return s;
  const head = s.slice(0, s.length - 3);
  const tail = s.slice(-3);
  return `${head}.${tail}`;
}

async function run() {
  const exps = Array.from({ length: 46 }, (_, i) => 25555 + i);
  console.log("Verificando chunks de expedientes recientes usando IN (source_ref)...");
  
  const numeros = exps.map(exp => `Exp. ${expIdToNumero(exp)} — texto_base`);
  
  const { data, error } = await supa
    .from('legislative_chunks')
    .select('source_ref')
    .in('source_ref', numeros);
    
  if (error) {
    console.error("Error:", error);
    return;
  }
  
  const foundRefs = new Set((data ?? []).map(d => d.source_ref));
  
  let missing = 0;
  let found = 0;
  for (const exp of exps) {
    const ref = `Exp. ${expIdToNumero(exp)} — texto_base`;
    if (foundRefs.has(ref)) {
      found++;
    } else {
      missing++;
      console.log(`Expediente ${exp} NO tiene chunks indexados.`);
    }
  }
  
  console.log(`\nResumen: ${found} indexados exitosamente, ${missing} faltantes.`);
}
run();
