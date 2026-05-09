/**
 * atlasContentGenerator — turns a workspace into structured editorial slide
 * content for the branded asset pipeline (carrusel / pptx / document).
 *
 * Why this exists:
 *   The previous pipeline shipped raw markdown to Gamma. Gamma decided the
 *   layout, picked stock photos, picked fonts, and produced something that
 *   didn't respect CL2's brand. This service replaces that step: we ask the
 *   LLM (OpenRouter, same key/path as the rest of the app — NOT Cerebro,
 *   we don't share model decisions there) to emit a structured JSON
 *   AssetContent that the htmlAssetRenderer consumes deterministically.
 *
 * Anti-hallucination contract (mirrors runArchitect in routes/workspace.ts):
 *   If the workspace prompt or hojas mention expediente numbers (CR format
 *   NN.NNN, range 12000-35000), we pre-fetch them from sil_expedientes and
 *   inject the verified blocks into the system prompt. The model is told to
 *   USE those facts, not invent new ones.
 *
 * Output contract (AssetContent):
 *   {
 *     title:    string;          // cover headline
 *     subtitle?: string;
 *     slides: AssetSlide[];      // ordered, idx-indexed
 *   }
 *
 * Slide kinds chosen per asset kind:
 *   carousel  — cover, content, stats, list, comparison, alert, quote, cta
 *               (8 slides default, 1 idea per slide, hooks)
 *   pptx      — cover, section, content, comparison, quote, cta
 *               (12-18 slides, 16:9, layout variety)
 *   document  — cover, section, content (long-form A4)
 *
 * The renderer reads slide.kind and picks the matching template block.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { withTimeout, withRetry, ResilienceError } from './resilience.js';
import { getExpedienteById } from './silClient.js';
import { logger } from './logger.js';

// ─── Supabase singleton (service-role; reads workspace_nodes bypassing RLS) ──
let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase env missing for atlasContentGenerator');
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

// ─── Types ──────────────────────────────────────────────────────────────────
export type AssetKind = 'carousel' | 'pptx' | 'document';

export type AssetSlideKind =
  | 'cover'
  | 'section'
  | 'content'
  | 'comparison'
  | 'quote'
  | 'cta'
  | 'stats'
  | 'list'
  | 'alert';

export interface AssetSlideItem {
  /** Short label (e.g. "Art. 7", "01", "L 10"). */
  label: string;
  /** Sentence-level claim or value. */
  value: string;
  /** Optional sub-line — context, source ref, secondary detail. */
  sub?: string;
}

export interface AssetSlideColumn {
  /** Col header eyebrow ("A favor", "En contra", "Antes", "Después"). */
  head: string;
  /** Col title — punchy phrase. */
  title: string;
  /** Bullet list rendered under the title. */
  bullets: string[];
}

export interface AssetSlideAlert {
  kind: 'recommendation' | 'warning' | 'note';
  title: string;
  text: string;
}

export interface AssetSlideMeta {
  /** Footer left text — defaults to "Análisis · cl2.cr" on the renderer. */
  footerLeft?: string;
  /** Footer right text — defaults to slide counter. */
  footerRight?: string;
}

export interface AssetSlide {
  idx: number;
  kind: AssetSlideKind;
  eyebrow?: string;
  headline: string;
  body?: string;
  items?: AssetSlideItem[];
  columns?: AssetSlideColumn[];
  alert?: AssetSlideAlert;
  meta?: AssetSlideMeta;
}

export interface AssetContent {
  title: string;
  subtitle?: string;
  slides: AssetSlide[];
}

export interface AssetGenerationOptions {
  /** "neutro, informativo" / "opinión clara" / "alerta urgente" / "explicativo". */
  tono?: string;
  /** "clientes corporativos" / "sector financiero" / "cuerpo legislativo" / "prensa". */
  audiencia?: string;
  /** Hook style for slide 1 (carousel/pptx). */
  hook?: string;
  /** Slide count override. Carousel default 8 (clamp 4..12), pptx default 14 (clamp 8..20). */
  numSlides?: number;
  /** Final CTA copy. */
  cta?: string;
  /** Brand voice notes from the user. */
  marca?: string;
  /** Emojis on/off. Default false (CL2 brand never uses them). */
  emojis?: boolean;
}

interface GenerateArgs {
  workspaceId: string;
  userId: string;
  kind: AssetKind;
  options?: AssetGenerationOptions;
}

// ─── OpenRouter call (same pattern as runArchitect; non-streaming JSON mode) ─
const OR_BASE = 'https://openrouter.ai/api/v1';
const OR_TIMEOUT_MS = 90_000;
const OR_RETRY_ATTEMPTS = 2;
const OR_RETRY_BASE_MS = 800;

const DEFAULT_MODEL = process.env.ATLAS_ASSET_MODEL ?? 'anthropic/claude-sonnet-4.6';

// ─── Workspace markdown composition ─────────────────────────────────────────
interface WorkspaceContext {
  title: string;
  description: string;
  hojas: Array<{ title: string; subtitle: string; md: string; type: string }>;
  documents: Array<{ title: string; extracted: string }>;
}

async function loadWorkspaceContext(workspaceId: string, userId: string): Promise<WorkspaceContext> {
  const { data: ws, error: wsErr } = await supa()
    .from('workspaces')
    .select('id, title, description')
    .eq('id', workspaceId)
    .eq('user_id', userId)
    .single();
  if (wsErr || !ws) throw new Error('workspace_not_found');

  const { data: nodes, error: nErr } = await supa()
    .from('workspace_nodes')
    .select('title, subtitle, content, type, x, y')
    .eq('workspace_id', workspaceId)
    .in('type', ['hoja', 'note', 'document', 'cite', 'expediente_ref']);
  if (nErr) throw new Error(`load_nodes_failed: ${nErr.message}`);

  // Snap to 200px y-bands then sort left-to-right (same reading order as
  // workspace export endpoints — keeps results deterministic for cache).
  const ordered = (nodes ?? []).slice().sort((a, b) => {
    const yA = Math.floor((a.y as number) / 200);
    const yB = Math.floor((b.y as number) / 200);
    if (yA !== yB) return yA - yB;
    return (a.x as number) - (b.x as number);
  });

  const hojas: WorkspaceContext['hojas'] = [];
  const documents: WorkspaceContext['documents'] = [];

  for (const n of ordered) {
    const c = (n.content ?? {}) as Record<string, unknown>;
    const md = typeof c.md === 'string' ? c.md.trim() : '';
    const extracted = typeof c.extracted_text === 'string' ? c.extracted_text.trim() : '';
    if (n.type === 'document' && extracted) {
      documents.push({ title: String(n.title ?? 'Documento'), extracted: extracted.slice(0, 8_000) });
    } else if (md) {
      hojas.push({
        title: String(n.title ?? 'Sin título'),
        subtitle: String(n.subtitle ?? ''),
        md: md.slice(0, 6_000),
        type: String(n.type ?? 'hoja'),
      });
    }
  }

  return {
    title: String(ws.title ?? 'Workspace'),
    description: String(ws.description ?? ''),
    hojas,
    documents,
  };
}

function composeWorkspaceMarkdown(ctx: WorkspaceContext): string {
  const lines: string[] = [];
  lines.push(`# ${ctx.title}`);
  if (ctx.description) lines.push('', ctx.description);
  for (const h of ctx.hojas) {
    lines.push('', '---', '');
    lines.push(`## ${h.title}`);
    if (h.subtitle) lines.push(`_${h.subtitle}_`);
    if (h.md) lines.push('', h.md);
  }
  for (const d of ctx.documents) {
    lines.push('', '---', '');
    lines.push(`## [Documento] ${d.title}`);
    lines.push('', d.extracted);
  }
  // Cap at 200K chars to fit comfortably in a 200K context window with overhead.
  return lines.join('\n').slice(0, 200_000);
}

// ─── Anti-hallucination: pre-fetch expedientes mentioned in workspace ────────
async function fetchExpedienteContextFromText(text: string): Promise<string> {
  const numbers = new Set<number>();
  const re = /\b(\d{2})[.,]?(\d{3})\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const num = Number(`${m[1]}${m[2]}`);
    if (num >= 12000 && num <= 35000) numbers.add(num);
  }
  if (numbers.size === 0) return '';

  const ids = [...numbers].slice(0, 4);
  const expedientes = await Promise.all(
    ids.map((n) => getExpedienteById(n).catch(() => null)),
  );
  const found = expedientes.filter((e): e is NonNullable<typeof e> => e !== null);
  if (found.length === 0) {
    return `\n\n[CONTEXTO SIL]\nLas hojas mencionan expediente(s) ${ids.join(', ')} pero no están indexados. NO inventés datos sobre ellos — usá el contenido que ya está en las hojas y marcá lo que falte como "[verificar]".`;
  }

  const blocks = found.map((e) => {
    const docs = (e.documentos ?? []).slice(0, 3).map((d) => `  - ${d.tipo ?? 'doc'}: ${d.titulo ?? '(sin título)'}`).join('\n');
    return [
      `### Expediente N° ${e.numero}`,
      e.titulo ? `Título: ${e.titulo}` : '',
      e.proponente ? `Proponente: ${e.proponente}` : '',
      e.comision ? `Ubicación actual del trámite: ${e.comision}` : '',
      e.estado ? `Estado / Comisión técnica de origen: ${e.estado}` : '',
      e.fecha_presentacion ? `Fecha presentación: ${e.fecha_presentacion.slice(0, 10)}` : '',
      docs ? `Documentos adjuntos:\n${docs}` : '',
    ].filter(Boolean).join('\n');
  });

  return `\n\n[CONTEXTO SIL — DATOS REALES VERIFICADOS]\nUSÁ ESTOS DATOS al construir slides. NO inventés proponentes, comisiones, fechas, ni números de artículo que no estén aquí. Si necesitás un dato no incluido, marcalo como "[verificar]" en el body de la slide.\n\n${blocks.join('\n\n')}`;
}

// ─── System prompts per kind ───────────────────────────────────────────────
function buildSystemPrompt(kind: AssetKind, options: AssetGenerationOptions | undefined): string {
  const numSlidesDefault = kind === 'carousel' ? 8 : kind === 'pptx' ? 14 : 6;
  const numSlides = clampSlides(kind, options?.numSlides ?? numSlidesDefault);
  const tono = options?.tono ?? 'editorial, técnico-político, asesor senior';
  const audiencia = options?.audiencia ?? 'consultores y clientes corporativos en Costa Rica';
  const cta = options?.cta ?? 'Conversemos sobre cómo afecta a tu organización · contacto@cl2.cr';
  const emojis = options?.emojis === true ? '' : 'NO uses emojis ni iconos decorativos. ';
  const hook = options?.hook ? `Estilo de hook (slide 1): ${options.hook}.` : '';
  const marca = options?.marca ? `Lineamientos de marca adicionales: ${options.marca}.` : '';

  const slideShape = `
Cada slide debe tener este shape:
{
  "idx": <int empezando en 1>,
  "kind": "cover" | "section" | "content" | "comparison" | "quote" | "cta" | "stats" | "list" | "alert",
  "eyebrow": "<corto, mayúsculas, contexto rápido — opcional>",
  "headline": "<titular principal — el componente más importante>",
  "body": "<2-3 oraciones — opcional cuando 'items' o 'columns' bastan>",
  "items": [{"label":"...","value":"...","sub":"..."}],          // para 'list'/'stats'
  "columns": [{"head":"...","title":"...","bullets":["...","..."]}],  // para 'comparison' (2 cols)
  "alert": {"kind":"recommendation"|"warning"|"note","title":"...","text":"..."},  // para 'alert'
  "meta": {"footerLeft":"...","footerRight":"..."}                // opcional
}

REGLA DE ÉNFASIS: para resaltar palabras clave, envolvelas en *asteriscos*
(formato markdown italic). El template las renderiza en cursiva burgundy.
NO uses **bold** — el sistema visual ya tiene su propia jerarquía tipográfica.
Reservá el énfasis para 1-2 palabras por slide, no abuses.
`;

  const carouselSpec = `
TIPO DE ASSET: carrusel CL2 cuadrado (1080x1080) para LinkedIn / IG / X.

REGLAS:
- Generá EXACTAMENTE ${numSlides} slides.
- Slide 1 = cover (kind="cover"). Headline grande, hook que detenga el scroll.
- Slides 2..${numSlides - 1} = mezcla de content, stats, list, comparison, alert, quote.
  - 'stats' cuando hay números clave (cantidades, fechas, puntuaciones).
  - 'list' cuando hay 3-5 puntos enumerables (artículos, hitos del calendario).
  - 'comparison' cuando hay dos posturas / antes-después.
  - 'alert' para recomendaciones, advertencias o notas editoriales (1 sola por carrusel max).
  - 'quote' para una frase clave de un actor verificable.
- Slide ${numSlides} = cta (kind="cta"). Cierre con mensaje de acción.
- Una idea por slide. Frases cortas. Ningún body de más de 2 oraciones.
- Tono: ${tono}. Audiencia: ${audiencia}.
- ${emojis}${hook} ${marca}
- CTA final exacto: "${cta}".
`;

  const pptxSpec = `
TIPO DE ASSET: presentación corporativa CL2 (16:9, 1920x1080).

REGLAS:
- Generá entre ${numSlides - 2} y ${numSlides + 2} slides (apuntá a ${numSlides}).
- Slide 1 = cover (kind="cover"). Título del proyecto + subtítulo + eyebrow ("ASUNTOS PÚBLICOS · COSTA RICA").
- Después, ALTERNÁ entre estos tipos para variar layouts (no 5 slides 'content' seguidas):
  - 'section' como divisor entre módulos del análisis (cada 3-4 slides de content).
  - 'content' para análisis sustancial — body con 3-5 oraciones, eyebrow + headline arriba.
  - 'stats' cuando hay números fuertes.
  - 'list' para enumeraciones (artículos, calendarios, recomendaciones).
  - 'comparison' para posturas, antes-después, escenarios A/B.
  - 'quote' para una cita literal con atribución.
  - 'alert' para 1-2 highlights críticos (recomendación o warning).
- Slide final = cta. Acción concreta, contacto, próximo paso.
- Tono: ${tono}. Audiencia: ${audiencia}.
- ${emojis}${marca}
- CTA: "${cta}".
`;

  const documentSpec = `
TIPO DE ASSET: documento ejecutivo A4 multipágina (210mm x 297mm portrait).

REGLAS:
- Generá entre ${numSlides} y ${numSlides + 4} secciones (cada slide = una sección/página A4).
- Slide 1 = cover (kind="cover"). Header con eyebrow ("BRIEF EJECUTIVO · CL2"), título grande, subtítulo con autor + fecha.
- Slides 2..N = mayoría 'content' con párrafos largos (4-7 oraciones por body, no recortes).
  - Usá 'section' como subtítulos de capítulo (1 cada 2-3 páginas).
  - 'list' para enumeraciones que deban quedar tabuladas (cronología, recomendaciones).
  - 'alert' para 1-2 recuadros de "recomendación CL2" o "advertencia editorial".
  - 'quote' opcional, 1 max, para citar al proponente.
- NO uses 'stats' ni 'comparison' (no quedan bien en formato A4 portrait).
- Slide final = cta. Contacto + próximos pasos.
- Tono: ${tono}. Audiencia: ${audiencia}.
- ${emojis}${marca}
- Voz: editorial, profesional, asesor senior. Sin chat-prose. Empezá con la sustancia.
`;

  const spec = kind === 'carousel' ? carouselSpec : kind === 'pptx' ? pptxSpec : documentSpec;

  return `Sos el equipo editorial de CL2 Consultoría — firma de asuntos públicos en Costa Rica.
Convertís el contenido de un workspace de análisis legislativo en un asset publicable, manteniendo
voz editorial, anclaje a fuentes verificables del SIL, y la estructura visual de la marca.

${spec}

REGLAS GENERALES (todas obligatorias):
- Español de Costa Rica. Usá vos en lugar de tú. Vocabulario legislativo técnico (dictamen,
  fracción, plenario, comisión, mociones, artículo, expediente N° NN.NNN).
- NO inventés expedientes, votaciones, fechas, ni nombres de diputados. Si las hojas no traen
  el dato, omitilo o usá lenguaje cuidadoso ("según la última actualización del SIL").
- Anti-marketing: NO uses "potenciá", "transformá", "innovador", "disruptivo". Voz editorial seca.
- NO uses emojis salvo que se te indique explícitamente.
- Las palabras de énfasis van en *cursiva* (asteriscos simples) — el template las pinta burgundy.

${slideShape}

Devolvé SOLO un objeto JSON con shape:
{
  "title": "<título del asset — corto, sustantivo>",
  "subtitle": "<una línea de contexto, opcional>",
  "slides": [ ... ]
}
NO incluyas backticks ni \`\`\`json. NO comentes el JSON. Solo el objeto.`;
}

function clampSlides(kind: AssetKind, n: number): number {
  if (kind === 'carousel') return Math.max(4, Math.min(12, Math.round(n)));
  if (kind === 'pptx') return Math.max(8, Math.min(20, Math.round(n)));
  return Math.max(4, Math.min(16, Math.round(n)));
}

// ─── OpenRouter JSON-mode call ─────────────────────────────────────────────
async function callOpenRouterJson(args: {
  systemPrompt: string;
  userPrompt: string;
  model?: string;
}): Promise<string> {
  const orKey = process.env.OPENROUTER_API_KEY ?? '';
  if (!orKey) throw new Error('OPENROUTER_API_KEY not set');

  return withRetry(async () => {
    const res = await withTimeout(
      (signal) =>
        fetch(`${OR_BASE}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${orKey}`,
            'HTTP-Referer': 'https://agentescl2.com',
            'X-Title': 'Shift CL2 Asset Pipeline',
          },
          body: JSON.stringify({
            model: args.model ?? DEFAULT_MODEL,
            messages: [
              { role: 'system', content: args.systemPrompt },
              { role: 'user', content: args.userPrompt },
            ],
            max_tokens: 8000,
            temperature: 0.5,
            response_format: { type: 'json_object' },
          }),
          signal,
        }),
      { ms: OR_TIMEOUT_MS, label: 'atlasContent:openrouter' },
    );

    if (!res.ok) {
      const text = await res.text();
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        throw new ResilienceError(`openrouter ${res.status}: ${text.slice(0, 200)}`, 'aborted');
      }
      throw new Error(`openrouter ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return json?.choices?.[0]?.message?.content ?? '';
  }, {
    attempts: OR_RETRY_ATTEMPTS,
    baseDelayMs: OR_RETRY_BASE_MS,
    label: 'atlasContent:openrouter',
  });
}

// ─── JSON parsing with fallback (some models wrap in code fences) ──────────
function parseAssetContent(raw: string): AssetContent {
  const tryParse = (s: string): AssetContent | null => {
    try {
      const obj = JSON.parse(s) as Partial<AssetContent>;
      if (typeof obj?.title !== 'string' || !Array.isArray(obj.slides)) return null;
      return obj as AssetContent;
    } catch { return null; }
  };
  const first = tryParse(raw);
  if (first) return first;
  const fence = raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fence) {
    const second = tryParse(fence[1]);
    if (second) return second;
  }
  // Last resort: find first { and last }.
  const open = raw.indexOf('{');
  const close = raw.lastIndexOf('}');
  if (open >= 0 && close > open) {
    const third = tryParse(raw.slice(open, close + 1));
    if (third) return third;
  }
  throw new Error('atlas_asset_invalid_json');
}

// ─── Slide normalization ───────────────────────────────────────────────────
function normalizeAssetContent(content: AssetContent, kind: AssetKind): AssetContent {
  const slides: AssetSlide[] = (content.slides ?? [])
    .map((s, i) => ({
      idx: typeof s.idx === 'number' && s.idx > 0 ? Math.floor(s.idx) : i + 1,
      kind: validateSlideKind(s.kind, kind, i),
      eyebrow: typeof s.eyebrow === 'string' ? s.eyebrow.trim() : undefined,
      headline: typeof s.headline === 'string' && s.headline.trim().length > 0
        ? s.headline.trim()
        : 'Sin titular',
      body: typeof s.body === 'string' ? s.body.trim() : undefined,
      items: Array.isArray(s.items)
        ? s.items.filter((it) => it && typeof it === 'object').map((it) => ({
            label: String(it.label ?? '').trim(),
            value: String(it.value ?? '').trim(),
            sub: typeof it.sub === 'string' ? it.sub.trim() : undefined,
          })).filter((it) => it.label || it.value)
        : undefined,
      columns: Array.isArray(s.columns)
        ? s.columns.slice(0, 2).map((c) => ({
            head: String(c.head ?? '').trim(),
            title: String(c.title ?? '').trim(),
            bullets: Array.isArray(c.bullets)
              ? c.bullets.map((b) => String(b ?? '').trim()).filter(Boolean).slice(0, 6)
              : [],
          }))
        : undefined,
      alert: s.alert && typeof s.alert === 'object' ? {
        kind: ((s.alert.kind === 'warning' || s.alert.kind === 'note') ? s.alert.kind : 'recommendation') as AssetSlideAlert['kind'],
        title: String(s.alert.title ?? '').trim() || 'Recomendación CL2',
        text: String(s.alert.text ?? '').trim(),
      } satisfies AssetSlideAlert : undefined,
      meta: s.meta && typeof s.meta === 'object' ? {
        footerLeft: typeof s.meta.footerLeft === 'string' ? s.meta.footerLeft : undefined,
        footerRight: typeof s.meta.footerRight === 'string' ? s.meta.footerRight : undefined,
      } : undefined,
    }))
    // Re-index defensively so renderer counter (idx / total) is monotonic.
    .map((s, i) => ({ ...s, idx: i + 1 }));

  return {
    title: typeof content.title === 'string' && content.title.trim().length > 0
      ? content.title.trim() : 'Brief CL2',
    subtitle: typeof content.subtitle === 'string' ? content.subtitle.trim() : undefined,
    slides,
  };
}

function validateSlideKind(k: unknown, asset: AssetKind, idx: number): AssetSlideKind {
  const allowed: AssetSlideKind[] = ['cover','section','content','comparison','quote','cta','stats','list','alert'];
  if (typeof k === 'string' && (allowed as string[]).includes(k)) return k as AssetSlideKind;
  // Sensible defaults: first slide is always cover, last always cta, rest content.
  if (idx === 0) return 'cover';
  return 'content';
}

// ─── Public entry point ────────────────────────────────────────────────────
export async function generateAssetContent(args: GenerateArgs): Promise<AssetContent> {
  const { workspaceId, userId, kind, options } = args;
  const t0 = Date.now();

  const ctx = await loadWorkspaceContext(workspaceId, userId);
  const md = composeWorkspaceMarkdown(ctx);
  const silContext = await fetchExpedienteContextFromText(md);

  const systemPrompt = buildSystemPrompt(kind, options) + silContext;
  const userPrompt = `Workspace fuente:\n\n${md}`;

  const raw = await callOpenRouterJson({ systemPrompt, userPrompt });
  const parsed = parseAssetContent(raw);
  const normalized = normalizeAssetContent(parsed, kind);

  logger.info('atlas_asset_content_generated', {
    workspaceId,
    kind,
    slides: normalized.slides.length,
    ms: Date.now() - t0,
  });

  return normalized;
}

// ─── Edit a single slide — drives the per-slide chat-edit endpoint ─────────
export async function editSingleSlide(args: {
  slide: AssetSlide;
  instruction: string;
  assetKind: AssetKind;
  workspaceTitle: string;
}): Promise<AssetSlide> {
  const { slide, instruction, assetKind, workspaceTitle } = args;

  const systemPrompt = `Sos editor del equipo CL2. Recibís UN slide existente y una instrucción del usuario.
Devolvés el MISMO slide con el campo correspondiente ajustado, manteniendo el shape exacto:
{ idx, kind, eyebrow?, headline, body?, items?, columns?, alert?, meta? }

REGLAS:
- NO cambies idx ni el slide.kind (a menos que la instrucción explícitamente pida cambiar layout).
- Mantené español de Costa Rica, voz editorial, sin chat-prose.
- Las palabras de énfasis van en *cursiva* (asteriscos simples).
- Si la instrucción es ambigua, aplicala al campo más relevante (headline si pide "más fuerte",
  body si pide "más detalle", items si pide "agregá un punto").
- NO inventés expedientes ni datos. Si te falta data, marcala "[verificar]".
- Devolvé SOLO el JSON del slide. NO comentes. NO uses backticks.

Asset: ${assetKind}. Workspace: "${workspaceTitle}".`;

  const userPrompt = `Slide actual:\n${JSON.stringify(slide, null, 2)}\n\nInstrucción del usuario:\n${instruction}\n\nDevolvé el slide editado.`;

  const raw = await callOpenRouterJson({ systemPrompt, userPrompt });

  // Reuse the parser / normalizer for safety.
  let edited: AssetSlide;
  try {
    const obj = JSON.parse(raw);
    edited = obj as AssetSlide;
  } catch {
    const fence = raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
    if (!fence) throw new Error('atlas_slide_edit_invalid_json');
    edited = JSON.parse(fence[1]) as AssetSlide;
  }

  // Normalize: pass through normalizeAssetContent on a single-slide doc.
  const normalized = normalizeAssetContent(
    { title: workspaceTitle, slides: [edited] },
    assetKind,
  );
  // Preserve the original idx — normalize re-indexes from 1.
  return { ...normalized.slides[0], idx: slide.idx };
}
