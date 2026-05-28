import { searchSilCorpus } from '../apps/api/src/services/silClient.js';
import 'dotenv/config';

async function run() {
  console.log('--- TEST 1: Búsqueda sin self-querying (solo vectores) ---');
  console.log('Query: "¿De qué trata el expediente 23.377?"');
  const res1 = await searchSilCorpus({ query: '¿De qué trata el expediente 23.377?' });
  const hits1 = res1.filter(h => h.source_ref.includes('23.377'));
  console.log(`Hits directos: ${hits1.length}`);
  if (hits1.length > 0) console.log(hits1[0].source_ref);

  console.log('\n--- TEST 2: Búsqueda con self-querying (expediente_numero extraído) ---');
  console.log('Query: "¿De qué trata el expediente 23.377?" | Filtro: "23.377"');
  const res2 = await searchSilCorpus({ query: '¿De qué trata el expediente 23.377?', expediente_numero: '23.377' });
  const hits2 = res2.filter(h => h.source_ref.includes('23.377'));
  console.log(`Hits directos: ${hits2.length}`);
  if (hits2.length > 0) console.log(hits2[0].source_ref);
}
run().catch(console.error);
