/**
 * whatsappTemplates — templates pre-aprobados de WhatsApp Business.
 *
 * Ronald F3 (2026-05-26). Twilio WhatsApp Business requiere approval por
 * template antes de poder enviarlos a clientes. Mientras espera approval
 * (~24-48h), el sender mock loguea pero no envía; el contenido sí queda
 * fijado acá para que Ronald valide el texto antes del go-live real.
 *
 * Convenciones:
 *   - Cada template tiene un `name` (referencia interna + el approval de Twilio
 *     debe coincidir con este string).
 *   - `bodyTemplate` usa `{{variable}}` para placeholders (estilo Twilio).
 *   - `requiredVars` declara qué variables el caller debe proveer.
 *   - `render(vars)` retorna el body final listo para enviar.
 *
 * Cuando se agreguen nuevos templates: agregar también en el panel de
 * Twilio Console para approval antes del próximo deploy.
 */

export interface WhatsappTemplate {
  name: string;
  description: string;
  bodyTemplate: string;
  requiredVars: string[];
  category: 'expediente' | 'votacion' | 'ley' | 'critica' | 'sesion';
}

export const WHATSAPP_TEMPLATES: Record<string, WhatsappTemplate> = {
  expediente_nuevo: {
    name: 'expediente_nuevo',
    description: 'Notificación cuando se presenta un nuevo expediente que matchea las prioridades del cliente.',
    bodyTemplate:
      'CL2 Alerta · Nuevo expediente presentado\n\n' +
      'Expediente N° {{numero}}: {{titulo}}\n' +
      'Proponente: {{proponente}}\n' +
      'Fecha presentación: {{fecha}}\n\n' +
      'Tema relevante para {{cliente_label}}: {{relevancia}}\n\n' +
      'Ver detalle: {{url}}',
    requiredVars: ['numero', 'titulo', 'proponente', 'fecha', 'cliente_label', 'relevancia', 'url'],
    category: 'expediente',
  },

  votacion_proxima: {
    name: 'votacion_proxima',
    description: 'Aviso de votación próxima de un expediente seguido por el cliente.',
    bodyTemplate:
      'CL2 Alerta · Votación próxima\n\n' +
      'El expediente {{numero}} ({{titulo}}) está agendado para votación en plenaria el {{fecha}}.\n\n' +
      'Tipo de debate: {{tipo_debate}}\n' +
      'Comisión dictaminadora: {{comision}}\n\n' +
      'Ver expediente: {{url}}',
    requiredVars: ['numero', 'titulo', 'fecha', 'tipo_debate', 'comision', 'url'],
    category: 'votacion',
  },

  ley_publicada: {
    name: 'ley_publicada',
    description: 'Aviso de publicación de ley en La Gaceta.',
    bodyTemplate:
      'CL2 Alerta · Ley publicada\n\n' +
      'La Ley N° {{numero_ley}} fue publicada en La Gaceta N° {{numero_gaceta}} el {{fecha}}.\n\n' +
      'Tema: {{titulo}}\n' +
      'Expediente original: {{numero_expediente}}\n\n' +
      'Esta ley puede afectar el sector {{sector}} de {{cliente_label}}. Recomendamos revisión.\n\n' +
      'Texto oficial: {{url}}',
    requiredVars: ['numero_ley', 'numero_gaceta', 'fecha', 'titulo', 'numero_expediente', 'sector', 'cliente_label', 'url'],
    category: 'ley',
  },

  alerta_critica: {
    name: 'alerta_critica',
    description: 'Alerta crítica de evento que requiere acción inmediata del cliente.',
    bodyTemplate:
      'CL2 Alerta CRÍTICA · {{tipo_evento}}\n\n' +
      '{{descripcion}}\n\n' +
      'Acción sugerida: {{accion_sugerida}}\n' +
      'Plazo: {{plazo}}\n\n' +
      'Detalle completo en plataforma: {{url}}',
    requiredVars: ['tipo_evento', 'descripcion', 'accion_sugerida', 'plazo', 'url'],
    category: 'critica',
  },

  sesion_relevante: {
    name: 'sesion_relevante',
    description: 'Aviso de sesión plenaria con temas relevantes para el cliente.',
    bodyTemplate:
      'CL2 Alerta · Sesión plenaria\n\n' +
      'La sesión {{tipo_sesion}} del {{fecha}} discutirá temas relevantes para {{cliente_label}}:\n\n' +
      '{{temas_relevantes}}\n\n' +
      'Resumen completo de la sesión: {{url}}',
    requiredVars: ['tipo_sesion', 'fecha', 'cliente_label', 'temas_relevantes', 'url'],
    category: 'sesion',
  },
};

/**
 * Renderiza un template sustituyendo {{vars}} con valores reales. Si falta
 * una variable requerida, lanza error con el nombre. Esto previene enviar
 * mensajes con "{{X}}" literal a clientes.
 */
export function renderTemplate(
  templateName: string,
  vars: Record<string, string | number | null | undefined>,
): string {
  const tpl = WHATSAPP_TEMPLATES[templateName];
  if (!tpl) throw new Error(`Unknown WhatsApp template: ${templateName}`);

  // Validar requiredVars antes de render.
  const missing = tpl.requiredVars.filter((v) => {
    const val = vars[v];
    return val === undefined || val === null || String(val).trim() === '';
  });
  if (missing.length > 0) {
    throw new Error(`Template ${templateName} missing required vars: ${missing.join(', ')}`);
  }

  let rendered = tpl.bodyTemplate;
  for (const [key, val] of Object.entries(vars)) {
    if (val === undefined || val === null) continue;
    rendered = rendered.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(val));
  }
  // Sanity check: si queda algún {{x}} sin sustituir, es bug del caller.
  const leftover = rendered.match(/\{\{(\w+)\}\}/);
  if (leftover) {
    throw new Error(`Template ${templateName} has unresolved placeholder: ${leftover[1]}`);
  }
  return rendered;
}

/**
 * Lista los nombres de templates disponibles (para UI/admin selectors).
 */
export function listTemplateNames(): string[] {
  return Object.keys(WHATSAPP_TEMPLATES);
}

/**
 * Genera la dedup_key canonical para un template + contexto.
 * Convención: <cliente_id>:<template_name>:<scope>
 *   scope = evento_id si hay, sino hash determinista del body.
 */
export function buildDedupKey(
  clienteId: string,
  templateName: string,
  scope: string,
): string {
  return `${clienteId}:${templateName}:${scope}`;
}
