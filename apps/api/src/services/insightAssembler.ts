/**
 * insightAssembler v2 — retrieval selectivo por dimensión.
 *
 * En vez de concatenar crudamente 4 dominios, este módulo:
 *   1. Clasifica la intención del usuario en una dimensión (keywords, no LLM).
 *   2. Busca SOLO en los dominios relevantes para esa dimensión.
 *   3. Limita el contexto a 5-8 chunks curados (nunca más de 8).
 *
 * Esto reduce ruido, tokens, y confusión del modelo.
 */

import { searchTranscripts, type ChunkHit as TranscriptHit } from './searchTranscripts.js';
import {
  searchSilCorpus,
  searchReglamento,
  searchConstitucionLoal,
  type SilChunkHit,
  type ReglamentoHit,
  type ConstitucionLoalHit,
} from './silClient.js';

export type InsightDimension =
  | 'impacto_normativo'
  | 'contexto_debate'
  | 'estado_expediente'
  | 'riesgo_obstruccion'
  | 'red_proponentes'
  | 'sintesis_general';

export interface InsightResult {
  dimension: InsightDimension;
  rendered: string;
  summary: {
    transcripts: number;
    sil: number;
    reglamento: number;
    constitucion_loal: number;
    total: number;
  };
}

/* ─── Clasificador: keywords simples, cero LLM ─────────────────────────── */

export function classifyDimension(query: string): InsightDimension {
  const q = query.toLowerCase();

  if (/reglamento|artículo|ley|normativa|legal|conflicto|constitucional|inconstitucional|vulnera|reforma/i.test(q))
    return 'impacto_normativo';

  if (/sesión|debate|discutieron|dijeron|plenario|comisión.*dijo|intervención|dijo.*diputad/i.test(q))
    return 'contexto_debate';

  if (/estancado|atascado|cuánto falta|plazo|días|obstrucción|trancado|detenido|tiempo|trámite/i.test(q))
    return 'riesgo_obstruccion';

  if (/proponente|diputado|autor|presentó|historial|fracción|patrocinador/i.test(q))
    return 'red_proponentes';

  if (/resumen|síntesis|executive summary|de qué trata|en qué va|panorama/i.test(q))
    return 'sintesis_general';

  return 'estado_expediente';
}

/* ─── Retrieval selectivo por dimensión ────────────────────────────────── */

export async function insightRetrieve(args: {
  query: string;
  expediente_numero?: string;
  k_per_bucket?: number;
}): Promise<InsightResult> {
  const dimension = classifyDimension(args.query);
  const k = Math.min(Math.max(args.k_per_bucket ?? 5, 1), 5);
  const exNum = args.expediente_numero;

  // Acumuladores
  let transcripts: TranscriptHit[] = [];
  let sil: SilChunkHit[] = [];
  let reglamento: ReglamentoHit[] = [];
  let constitucionLoal: ConstitucionLoalHit[] = [];

  switch (dimension) {
    case 'impacto_normativo': {
      // Solo reglamento + constitución/LOAL. Nada de transcripts ni SIL.
      [reglamento, constitucionLoal] = await Promise.all([
        searchReglamento({ query: args.query, k: Math.min(k, 3) }).catch((err) => {
          console.warn('[insight] reglamento retrieval failed:', err.message);
          return [] as ReglamentoHit[];
        }),
        searchConstitucionLoal({ query: args.query, k: Math.min(k, 2) }).catch((err) => {
          console.warn('[insight] constitución/LOAL retrieval failed:', err.message);
          return [] as ConstitucionLoalHit[];
        }),
      ]);
      break;
    }

    case 'contexto_debate': {
      // Solo transcripts. Nada de SIL ni reglamento.
      transcripts = await searchTranscripts({
        query: args.query,
        top_k: Math.min(k + 2, 5),
        expediente_numero: exNum,
      }).catch((err) => {
        console.warn('[insight] transcript retrieval failed:', err.message);
        return [] as TranscriptHit[];
      });
      break;
    }

    case 'estado_expediente': {
      // Solo SIL (expediente, dictamen, votación).
      sil = await searchSilCorpus({
        query: args.query,
        k: Math.min(k + 2, 6),
        expediente_numero: exNum,
      }).catch((err) => {
        console.warn('[insight] SIL retrieval failed:', err.message);
        return [] as SilChunkHit[];
      });
      break;
    }

    case 'riesgo_obstruccion': {
      // SIL: expediente + dictamen + votación. Mismo corpus que estado_expediente
      // pero la query suele ser más específica (atascado, plazo, etc.).
      sil = await searchSilCorpus({
        query: args.query,
        k: Math.min(k + 2, 6),
        expediente_numero: exNum,
      }).catch((err) => {
        console.warn('[insight] SIL retrieval failed:', err.message);
        return [] as SilChunkHit[];
      });
      break;
    }

    case 'red_proponentes': {
      // Solo SIL expediente (historial del proponente).
      sil = await searchSilCorpus({
        query: args.query,
        k: Math.min(k + 1, 5),
        expediente_numero: exNum,
      }).catch((err) => {
        console.warn('[insight] SIL retrieval failed:', err.message);
        return [] as SilChunkHit[];
      });
      break;
    }

    case 'sintesis_general': {
      // Máximo 2 dominios: SIL + el dominio contextual según expediente.
      // Si hay expediente, buscamos SIL. Si no, buscamos transcripts.
      if (exNum) {
        sil = await searchSilCorpus({
          query: args.query,
          k: Math.min(k, 4),
          expediente_numero: exNum,
        }).catch((err) => {
          console.warn('[insight] SIL retrieval failed:', err.message);
          return [] as SilChunkHit[];
        });
      } else {
        transcripts = await searchTranscripts({
          query: args.query,
          top_k: Math.min(k, 4),
          expediente_numero: exNum,
        }).catch((err) => {
          console.warn('[insight] transcript retrieval failed:', err.message);
          return [] as TranscriptHit[];
        });
      }
      break;
    }
  }

  // ─── Curar: limitar a 8 chunks totales ────────────────────────────────
  const maxTotal = 8;
  let t = transcripts.slice(0, 4);
  let s = sil.slice(0, 4);
  let r = reglamento.slice(0, 3);
  let c = constitucionLoal.slice(0, 2);

  // Si hay más de 8, recortar proporcionalmente
  let all = [...t, ...s, ...r, ...c];
  if (all.length > maxTotal) {
    // Estrategia: mantener distribución pero truncar
    const targetT = Math.min(t.length, 3);
    const targetS = Math.min(s.length, 3);
    const targetR = Math.min(r.length, 2);
    const targetC = Math.min(c.length, 2);
    let curated = [
      ...t.slice(0, targetT),
      ...s.slice(0, targetS),
      ...r.slice(0, targetR),
      ...c.slice(0, targetC),
    ];
    if (curated.length > maxTotal) {
      curated = curated.slice(0, maxTotal);
    }
    // Re-asignar a las variables según tipo
    t = curated.filter((h) => 'metadata' in h) as TranscriptHit[];
    s = curated.filter((h) => 'expediente_numero' in h) as SilChunkHit[];
    r = curated.filter((h) => 'articulo_full_title' in h) as ReglamentoHit[];
    c = curated.filter(
      (h) => 'articulo_numero' in h && !('articulo_full_title' in h),
    ) as ConstitucionLoalHit[];
    all = curated; // post-truncación: summary refleja chunks reales enviados
  }

  const rendered = renderForLlm(dimension, t, s, r, c);

  return {
    dimension,
    rendered,
    summary: {
      transcripts: t.length,
      sil: s.length,
      reglamento: r.length,
      constitucion_loal: c.length,
      total: all.length,
    },
  };
}

/* ─── Render para LLM ─────────────────────────────────────────────────── */

function renderForLlm(
  dimension: InsightDimension,
  transcripts: TranscriptHit[],
  sil: SilChunkHit[],
  reglamento: ReglamentoHit[],
  constitucionLoal: ConstitucionLoalHit[],
): string {
  const hasAny =
    transcripts.length > 0 ||
    sil.length > 0 ||
    reglamento.length > 0 ||
    constitucionLoal.length > 0;

  if (!hasAny) {
    return '(No se encontró información relevante en el corpus legislativo para esta dimensión de análisis.)';
  }

  const lines: string[] = [
    `=== DIMENSIÓN: ${dimension.replace(/_/g, ' ').toUpperCase()} ===`,
    '',
  ];

  if (reglamento.length > 0) {
    lines.push('--- Reglamento de la Asamblea ---');
    reglamento.forEach((h, i) => {
      lines.push(`[R${i + 1}] ${h.articulo_full_title} (sim: ${(h.similarity * 100).toFixed(0)}%)`);
      lines.push(h.content);
      lines.push('');
    });
  }

  if (constitucionLoal.length > 0) {
    lines.push('--- Constitución Política / LOAL ---');
    constitucionLoal.forEach((h, i) => {
      const tag = h.source_type === 'constitucion' ? 'Const' : 'LOAL';
      const art = h.articulo_numero ? `Art. ${h.articulo_numero}` : 'Artículo';
      lines.push(`[C${i + 1}] ${art} (${tag}) (sim: ${(h.similarity * 100).toFixed(0)}%)`);
      lines.push(h.content);
      lines.push('');
    });
  }

  if (sil.length > 0) {
    lines.push('--- SIL (Sistema de Información Legislativa) ---');
    sil.forEach((h, i) => {
      lines.push(`[S${i + 1}] ${h.source_ref} (sim: ${(h.similarity * 100).toFixed(0)}%)`);
      lines.push(h.content);
      lines.push('');
    });
  }

  if (transcripts.length > 0) {
    lines.push('--- Transcripciones de Sesiones ---');
    transcripts.forEach((h, i) => {
      const tc = h.metadata?.start ? ` · ${formatTimecode(h.metadata.start)}` : '';
      lines.push(`[T${i + 1}] ${h.source_ref}${tc} (sim: ${(h.similarity * 100).toFixed(0)}%)`);
      lines.push(h.content);
      lines.push('');
    });
  }

  return lines.join('\n');
}

function formatTimecode(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}
