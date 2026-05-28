/**
 * insightAssembler — retrieval paralelo por dominio para Deep Insight.
 *
 * Cuando deep_insight está activo, esta función hace búsqueda semántica en
 * paralelo sobre cada dominio (transcripts, SIL, reglamento, constitución/LOAL)
 * y devuelve los hits combinados. Cada dominio se busca con su propia tool
 * para evitar que uno ahogue a otro en el ranking.
 *
 * No hay scoring mágico ni "dimensiones" abstractas. Simplemente:
 *   1. Llamamos las 4 búsquedas en paralelo.
 *   2. Concatenamos los resultados con su dominio etiquetado.
 *   3. Renderizamos para el LLM con citas claras.
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

export interface InsightResult {
  rendered: string;
  summary: {
    transcripts: number;
    sil: number;
    reglamento: number;
    constitucion_loal: number;
  };
}

export async function insightRetrieve(args: {
  query: string;
  k_per_bucket?: number;
}): Promise<InsightResult> {
  const k = Math.min(Math.max(args.k_per_bucket ?? 5, 1), 10);

  // Retrieval paralelo — cada dominio en su propia taza.
  const [transcripts, sil, reglamento, constitucionLoal] = await Promise.all([
    searchTranscripts({ query: args.query, top_k: k }).catch((err) => {
      console.warn('[insight] transcript retrieval failed:', err.message);
      return [] as TranscriptHit[];
    }),
    searchSilCorpus({ query: args.query, k }).catch((err) => {
      console.warn('[insight] SIL retrieval failed:', err.message);
      return [] as SilChunkHit[];
    }),
    searchReglamento({ query: args.query, k }).catch((err) => {
      console.warn('[insight] reglamento retrieval failed:', err.message);
      return [] as ReglamentoHit[];
    }),
    searchConstitucionLoal({ query: args.query, k }).catch((err) => {
      console.warn('[insight] constitución/LOAL retrieval failed:', err.message);
      return [] as ConstitucionLoalHit[];
    }),
  ]);

  const rendered = renderForLlm(transcripts, sil, reglamento, constitucionLoal);

  return {
    rendered,
    summary: {
      transcripts: transcripts.length,
      sil: sil.length,
      reglamento: reglamento.length,
      constitucion_loal: constitucionLoal.length,
    },
  };
}

function renderForLlm(
  transcripts: TranscriptHit[],
  sil: SilChunkHit[],
  reglamento: ReglamentoHit[],
  constitucionLoal: ConstitucionLoalHit[],
): string {
  if (
    transcripts.length === 0 &&
    sil.length === 0 &&
    reglamento.length === 0 &&
    constitucionLoal.length === 0
  ) {
    return '(No se encontró información relevante en el corpus legislativo.)';
  }

  const lines: string[] = [
    '=== CONTEXTO LEGISLATIVO (Deep Insight) ===',
    '',
  ];

  if (transcripts.length > 0) {
    lines.push('--- Transcripciones de Sesiones ---');
    transcripts.forEach((h, i) => {
      const tc = h.metadata?.start ? ` · ${formatTimecode(h.metadata.start)}` : '';
      lines.push(`[T${i + 1}] ${h.source_ref}${tc} (sim: ${(h.similarity * 100).toFixed(0)}%)`);
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
