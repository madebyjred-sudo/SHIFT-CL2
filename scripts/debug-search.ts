import { searchSilCorpus } from '../apps/api/src/services/silClient.js';
import 'dotenv/config';

async function run() {
  console.log('Testing searchSilCorpus with expediente_numero: 22.991');
  const res = await searchSilCorpus({ query: 'Resumen', expediente_numero: '22.991' });
  console.log(JSON.stringify(res, null, 2));
}
run().catch(console.error);
