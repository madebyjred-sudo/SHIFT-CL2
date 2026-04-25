/**
 * ConfidenceBadge — Centinela's "bandera de confianza".
 *
 * Renders a colored chip with score + level label. Hover shows the
 * rationale (which sources were counted, mean similarity, etc).
 *
 * Only displayed for agents whose response_contract.must_show_confidence
 * is true (currently Centinela). Lexa/Atlas hide this to keep the bubble
 * clean — confidence is implicit in their citation count.
 */
import { ShieldCheck, ShieldAlert, ShieldQuestion } from 'lucide-react';
import type { Confidence } from '@/lib/chat-context';

interface ConfidenceBadgeProps {
  confidence: Confidence;
}

const STYLES: Record<
  Confidence['level'],
  { label: string; bg: string; fg: string; border: string; Icon: typeof ShieldCheck }
> = {
  high: {
    label: 'Confianza alta',
    bg: 'bg-emerald-500/10',
    fg: 'text-emerald-700 dark:text-emerald-300',
    border: 'border-emerald-500/30',
    Icon: ShieldCheck,
  },
  medium: {
    label: 'Confianza media',
    bg: 'bg-amber-500/10',
    fg: 'text-amber-700 dark:text-amber-300',
    border: 'border-amber-500/30',
    Icon: ShieldQuestion,
  },
  low: {
    label: 'Confianza baja',
    bg: 'bg-rose-500/10',
    fg: 'text-rose-700 dark:text-rose-300',
    border: 'border-rose-500/30',
    Icon: ShieldAlert,
  },
};

export function ConfidenceBadge({ confidence }: ConfidenceBadgeProps) {
  const style = STYLES[confidence.level];
  const Icon = style.Icon;
  return (
    <div
      className={`mt-3 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium ${style.bg} ${style.fg} ${style.border}`}
      title={confidence.rationale || undefined}
    >
      <Icon className="w-3.5 h-3.5" />
      <span>{style.label}</span>
      <span className="opacity-70 font-semibold">·</span>
      <span className="font-semibold tabular-nums">{confidence.score}/100</span>
    </div>
  );
}
