import { createClient } from '@supabase/supabase-js';
import { openRouterStream } from '../apps/api/src/services/openRouterClient.js';
import 'dotenv/config';

const supa = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

interface TestResult {
  month: string;
  numero: string;
  titulo: string;
  tool_used: string;
  response_length: number;
  mentions_numero: boolean;
  pass: boolean;
  error?: string;
}

async function testExpediente(numero: string): Promise<{ tool_used: string; response: string; error?: string }> {
  let tool_used = '';
  let response = '';

  try {
    await openRouterStream({
      agent_id: 'lexa' as any,
      query: `¿De qué trata el expediente ${numero}?`,
      deep_insight: false,
      onChunk: (chunk: any) => {
        if (chunk.type === 'token' && chunk.payload) {
          response += String(chunk.payload);
        } else if (chunk.type === 'tool_call' && chunk.payload) {
          const p = chunk.payload as any;
          tool_used = p.name || p.tool || tool_used;
        }
      },
    });
    return { tool_used, response };
  } catch (err) {
    return { tool_used, response, error: (err as Error).message.slice(0, 120) };
  }
}

async function run() {
  const months: string[] = [];
  for (let y = 2022; y <= 2026; y++) {
    const maxM = y === 2026 ? 5 : 12;
    for (let m = 1; m <= maxM; m++) months.push(`${y}-${String(m).padStart(2, '0')}`);
  }

  const results: TestResult[] = [];
  let passed = 0;
  let failed = 0;

  console.log('╔══════════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║  PRUEBA MASIVA DE LEXA — 1 expediente aleatorio por mes (2022-01 a 2026-05)        ║');
  console.log('║  Cada prueba invoca al agente LLM completo (openRouterStream → tool → respuesta)   ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════════════════╝');
  console.log('');

  for (const month of months) {
    const fromDate = `${month}-01`;
    const y = parseInt(month.split('-')[0]);
    const m = parseInt(month.split('-')[1]);
    const lastDay = new Date(y, m, 0).getDate();
    const toDate = `${month}-${lastDay}`;

    const { data: exps } = await supa
      .from('sil_expedientes')
      .select('id, numero, titulo')
      .gte('fecha_presentacion', fromDate)
      .lte('fecha_presentacion', toDate)
      .not('titulo', 'is', null);

    if (!exps || exps.length === 0) {
      console.log(`${month} | ⏭️  Sin expedientes`);
      continue;
    }

    const exp = exps[Math.floor(Math.random() * exps.length)];
    const tituloShort = (exp.titulo ?? '').slice(0, 55);

    process.stdout.write(`${month} | Exp. ${exp.numero.padEnd(8)} | `);

    const { tool_used, response, error } = await testExpediente(exp.numero);

    const mentionsNumero = response.includes(exp.numero);
    const hasContent = response.length > 50;
    const pass = hasContent && !error;

    if (pass) passed++;
    else failed++;

    const icon = pass ? '✅' : '❌';
    console.log(`${icon} tool=${tool_used || 'none'} resp=${response.length}ch menciona=${mentionsNumero ? 'SÍ' : 'NO'} | ${tituloShort}`);

    results.push({ month, numero: exp.numero, titulo: tituloShort, tool_used, response_length: response.length, mentions_numero: mentionsNumero, pass, error });

    await new Promise((r) => setTimeout(r, 500));
  }

  console.log('');
  console.log('═══════════════════════════════════════════════');
  console.log(`  RESULTADO FINAL: ${passed} ✅  /  ${failed} ❌  de ${results.length} meses`);
  console.log(`  Tasa de éxito: ${((passed / results.length) * 100).toFixed(1)}%`);
  console.log('═══════════════════════════════════════════════');

  if (failed > 0) {
    console.log('\nFALLIDOS:');
    for (const r of results.filter((r) => !r.pass)) {
      console.log(`  ${r.month} | Exp. ${r.numero} | ${r.error ?? 'respuesta vacía'}`);
    }
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
