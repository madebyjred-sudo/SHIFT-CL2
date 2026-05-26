/**
 * seed-whatsapp-alerts.ts — Ronald F3 demo seed.
 *
 * Crea 2 clientes sintéticos (FEDEFARMA, ICT) + 6 alertas WhatsApp demo
 * que cubren los 5 templates. Lex el cliente queda con opt_in=true y un
 * contact_whatsapp dummy (+506-XXXX-XXXX placeholder; mientras Twilio
 * Business no apruebe, no se envía a nadie real).
 *
 * Idempotente: si los clientes seed ya existen, los reusa.
 *
 * Uso:
 *   set -a && source .env.local && set +a
 *   npx tsx apps/api/scripts/seed-whatsapp-alerts.ts
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { queueAlert } from '../src/services/whatsappAlerts.js';

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const SEED_OWNER_EMAIL = 'proyectoasambleadigital@gmail.com'; // El admin owner.
const DEMO_WHATSAPP_PLACEHOLDER = '+50688888888'; // No real, no se envía.

interface ClienteSeed {
  slug: string;
  label: string;
  sector: string;
  context_prompt: string;
  context_keywords: string[];
  whatsapp_priorities: Record<string, unknown>;
}

const SEED_CLIENTES: ClienteSeed[] = [
  {
    slug: 'fedefarma',
    label: 'FEDEFARMA',
    sector: 'farmacéutico',
    context_prompt:
      'FEDEFARMA es la federación de empresas farmacéuticas privadas de Centroamérica. ' +
      'Tiene entre sus asociados a las principales empresas de medicamentos innovadores ' +
      'que venden en Costa Rica. Sus prioridades incluyen regulación del mercado de ' +
      'medicamentos, registros de moléculas, importaciones paralelas, compras públicas, ' +
      'acuerdos innovadores, modificaciones en la CCSS, inmunizaciones y tecnologías ' +
      'sanitarias. Recientemente enfrentaron retos por la ley de fortalecimiento de ' +
      'competencia en mercado de medicamentos y por proyectos como el expediente 23.496 ' +
      '(importación paralela sin autorización) y 24.819 (responsabilidad por residuos ' +
      'medicamentos). Cliente proactivo con cercanía a Casa Presidencial y diputados PUSC.',
    context_keywords: [
      'medicamentos', 'farmacéuticas', 'CCSS', 'importación paralela',
      'compras públicas medicamentos', 'patentes farmacéuticas', 'control precios',
      'márgenes comercialización', 'cadena valor medicamentos', 'inmunizaciones',
    ],
    whatsapp_priorities: {
      expedientes_seguir: ['23.496', '24.819', '25.136'],
      tipos_alerta: ['expediente_nuevo', 'votacion_proxima', 'ley_publicada', 'alerta_critica'],
    },
  },
  {
    slug: 'ict',
    label: 'Instituto Costarricense de Turismo (ICT)',
    sector: 'turismo',
    context_prompt:
      'ICT es Institución Autónoma del Estado con interés en turismo, hospedaje, ' +
      'alquileres de corta estancia, parques nacionales, zona marítimo-terrestre, ' +
      'transporte aéreo, feriados y planes reguladores. Foco especial en proyectos ' +
      'turísticos del Golfo de Papagayo y CANATUR.',
    context_keywords: [
      'turismo', 'hoteles', 'Airbnb', 'parques nacionales', 'SINAC',
      'zona marítimo terrestre', 'aerolíneas', 'aeropuertos', 'feriados',
      'planes reguladores', 'Papagayo', 'CANATUR',
    ],
    whatsapp_priorities: {
      tipos_alerta: ['expediente_nuevo', 'ley_publicada', 'sesion_relevante'],
    },
  },
];

async function ensureCliente(s: ClienteSeed): Promise<string> {
  // Buscar owner.
  const { data: ownerAccess } = await supa
    .from('user_access')
    .select('user_id')
    .eq('email', SEED_OWNER_EMAIL)
    .maybeSingle();
  const ownerId = (ownerAccess as { user_id: string } | null)?.user_id;
  if (!ownerId) throw new Error(`Seed owner ${SEED_OWNER_EMAIL} no encontrado en user_access`);

  // Upsert cliente.
  const { data: existing } = await supa
    .from('cl2_clients')
    .select('id')
    .eq('user_id', ownerId)
    .eq('slug', s.slug)
    .maybeSingle();

  if (existing) {
    // Update with seed content (refresca prompts/keywords).
    await supa
      .from('cl2_clients')
      .update({
        label: s.label,
        sector: s.sector,
        context_prompt: s.context_prompt,
        context_keywords: s.context_keywords,
        whatsapp_priorities: s.whatsapp_priorities,
        whatsapp_opt_in: true,
        contact_whatsapp: DEMO_WHATSAPP_PLACEHOLDER,
      })
      .eq('id', (existing as { id: string }).id);
    return (existing as { id: string }).id;
  }

  const { data: created, error } = await supa
    .from('cl2_clients')
    .insert({
      user_id: ownerId,
      slug: s.slug,
      label: s.label,
      sector: s.sector,
      contact_whatsapp: DEMO_WHATSAPP_PLACEHOLDER,
      whatsapp_opt_in: true,
      context_prompt: s.context_prompt,
      context_keywords: s.context_keywords,
      whatsapp_priorities: s.whatsapp_priorities,
    })
    .select('id')
    .single();
  if (error) throw new Error(`insert cliente ${s.slug}: ${error.message}`);
  return (created as { id: string }).id;
}

async function main() {
  console.log('[seed-whatsapp-alerts] start');

  const fedefarmaId = await ensureCliente(SEED_CLIENTES[0]);
  const ictId = await ensureCliente(SEED_CLIENTES[1]);
  console.log(`  cliente FEDEFARMA: ${fedefarmaId}`);
  console.log(`  cliente ICT: ${ictId}`);

  // Seed alertas — usar dedup distinto cada run para que se vean acumular
  // en la UI. Si quieren idempotencia estricta, fijá scope a un valor estable.
  const ts = new Date().toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
  const baseUrl = 'https://cl2-v2.agentescl2.com';
  const alertSeeds: Array<{
    cliente_id: string;
    template: string;
    vars: Record<string, string | number | null | undefined>;
    scope: string;
  }> = [
    {
      cliente_id: fedefarmaId,
      template: 'expediente_nuevo',
      scope: `seed-23496-${ts}`,
      vars: {
        numero: '23.496',
        titulo: 'Importación paralela de medicamentos sin autorización de casa farmacéutica',
        proponente: 'Diputada Vianney Mora Vega',
        fecha: '2024-08-15',
        cliente_label: 'FEDEFARMA',
        relevancia: 'afecta directamente el mercado de medicamentos innovadores',
        url: `${baseUrl}/expediente/23.496`,
      },
    },
    {
      cliente_id: fedefarmaId,
      template: 'votacion_proxima',
      scope: `seed-23496-vote-${ts}`,
      vars: {
        numero: '23.496',
        titulo: 'Importación paralela medicamentos',
        fecha: '12 de junio de 2026',
        tipo_debate: 'Primer debate',
        comision: 'SOCIALES (ÁREA II)',
        url: `${baseUrl}/expediente/23.496`,
      },
    },
    {
      cliente_id: fedefarmaId,
      template: 'ley_publicada',
      scope: `seed-ley-fortalecimiento-${ts}`,
      vars: {
        numero_ley: '10580',
        numero_gaceta: '189',
        fecha: '2026-04-22',
        titulo: 'Fortalecimiento de la competencia en mercado de medicamentos',
        numero_expediente: '24.142',
        sector: 'farmacéutico',
        cliente_label: 'FEDEFARMA',
        url: `${baseUrl}/expediente/24.142`,
      },
    },
    {
      cliente_id: fedefarmaId,
      template: 'alerta_critica',
      scope: `seed-decreto-margenes-${ts}`,
      vars: {
        tipo_evento: 'Decreto en consulta pública',
        descripcion: 'El Ejecutivo publicó borrador de decreto que regula márgenes de comercialización en toda la cadena de valor farmacéutica.',
        accion_sugerida: 'Preparar comentarios al borrador antes del cierre de consulta pública',
        plazo: '15 días hábiles',
        url: `${baseUrl}/decretos/borrador-margenes-medicamentos`,
      },
    },
    {
      cliente_id: ictId,
      template: 'expediente_nuevo',
      scope: `seed-25291-${ts}`,
      vars: {
        numero: '25.291',
        titulo: 'Modernización del régimen del Polo Turístico Golfo de Papagayo',
        proponente: 'Diputado Carlos Felipe García Molina',
        fecha: '2026-03-12',
        cliente_label: 'ICT',
        relevancia: 'reforma directa al PTGP — alto impacto en proyectos turísticos costeros',
        url: `${baseUrl}/expediente/25.291`,
      },
    },
    {
      cliente_id: ictId,
      template: 'sesion_relevante',
      scope: `seed-sesion-21may-${ts}`,
      vars: {
        tipo_sesion: 'Plenaria ordinaria',
        fecha: '21 de mayo de 2026',
        cliente_label: 'ICT',
        temas_relevantes:
          '• Expediente 24.998 (Acuerdo de transporte aéreo Costa Rica-Chile) — aprobado 2do debate\n' +
          '• Discusión sobre concesiones en zona marítimo-terrestre',
        url: `${baseUrl}/sesion/2026-05-21`,
      },
    },
  ];

  let queued = 0;
  let duplicated = 0;
  for (const a of alertSeeds) {
    const r = await queueAlert({
      cliente_id: a.cliente_id,
      template_name: a.template,
      vars: a.vars,
      contact_whatsapp: DEMO_WHATSAPP_PLACEHOLDER,
      dedup_scope: a.scope,
    });
    if (r.duplicated) duplicated++;
    else queued++;
    console.log(`  ${r.duplicated ? '·' : '✓'} ${a.template} → ${(a.vars.cliente_label as string) ?? '?'} (alert ${r.alert_id.slice(0, 8)})`);
  }

  console.log('');
  console.log(`[seed-whatsapp-alerts] done`);
  console.log(`  alertas nuevas: ${queued}`);
  console.log(`  alertas existentes (dedup): ${duplicated}`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
