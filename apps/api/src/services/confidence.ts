/**
 * Heuristic confidence scoring — deterministic, server-side, no LLM call.
 *
 * Scoring inputs:
 *   - citation count (more sources = higher confidence)
 *   - mean similarity score (closer matches = higher confidence)
 *   - presence of refusal language ("no encontré", "no tengo") in the answer
 *     (refusals are HONEST — they keep score from being penalized; the user
 *     gets a low-confidence flag specifically when evidence is sparse, not
 *     when the model is honest about gaps)
 *
 * The number is illustrative, not statistical. Centinela's contract says
 * "must_show_confidence" — this satisfies it without inventing precision
 * we don't have. If we ever ground these weights against eval data,
 * upgrade to a calibrated classifier.
 */
import type { ConfidencePayload } from '@shift-cl2/shared-types';
import type { CitationRow } from './conversationStore.js';

const REFUSAL_PHRASES = [
  'no encontré',
  'no tengo',
  'no aparece',
  'no figura',
  'no consta',
];

export function estimateConfidence(
  answer: string,
  citations: CitationRow[],
): ConfidencePayload {
  let score = 40; // baseline — assistant produced *something*
  const reasons: string[] = [];

  if (citations.length > 0) {
    score += 20;
    reasons.push(`${citations.length} fuente${citations.length === 1 ? '' : 's'} citada${citations.length === 1 ? '' : 's'}`);
  } else {
    reasons.push('sin fuentes recuperadas');
  }

  if (citations.length >= 3) {
    score += 10;
    reasons.push('cobertura amplia');
  }

  const sims = citations.map((c) => c.similarity).filter((s) => typeof s === 'number');
  if (sims.length > 0) {
    const meanSim = sims.reduce((a, b) => a + b, 0) / sims.length;
    if (meanSim >= 0.55) {
      score += 20;
      reasons.push(`alta similitud semántica (${meanSim.toFixed(2)})`);
    } else if (meanSim >= 0.4) {
      score += 10;
      reasons.push(`similitud media (${meanSim.toFixed(2)})`);
    } else {
      reasons.push(`similitud baja (${meanSim.toFixed(2)})`);
    }
  }

  const lower = answer.toLowerCase();
  const hasRefusal = REFUSAL_PHRASES.some((p) => lower.includes(p));
  if (hasRefusal && citations.length === 0) {
    // Honest refusal with no evidence — confidence in the refusal itself is high,
    // but we report it as low because the user got little actionable info.
    score = Math.min(score, 45);
    reasons.push('respuesta honesta de "no encontré"');
  }

  score = Math.max(0, Math.min(100, score));
  const level: ConfidencePayload['level'] = score >= 75 ? 'high' : score >= 60 ? 'medium' : 'low';

  return {
    score,
    level,
    rationale: reasons.join(' · '),
  };
}
