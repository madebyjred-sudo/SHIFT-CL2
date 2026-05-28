import { openRouterStream } from '../apps/api/src/services/openRouterClient.js';
import 'dotenv/config';

async function run() {
  console.log('--- PREGUNTANDO A LEXA SOBRE EL EXPEDIENTE 25.600 ---');
  let finalResponse = '';
  
  await openRouterStream({
    agent_id: 'lexa' as any,
    query: '¿De qué trata el expediente 25.600?',
    deep_insight: false,
    onChunk: (chunk: any) => {
      if (chunk.type === 'text') {
        process.stdout.write(chunk.text);
        finalResponse += chunk.text;
      } else if (chunk.type === 'tool_call') {
        console.log(`\n\n[LEXA LLAMÓ A LA HERRAMIENTA]: ${chunk.tool} con argumentos: ${JSON.stringify(chunk.args)}`);
      } else if (chunk.type === 'tool_result') {
        console.log(`[LEXA RECIBIÓ LOS DATOS DE LA BASE DE DATOS Y ESTÁ LEYENDO...]`);
      }
    }
  });

  console.log('\n\n--- FIN DE LA RESPUESTA ---');
}

run().catch(console.error);
