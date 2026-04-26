/**
 * VoiceCaptureModal — full-screen capture sheet for "new hoja by voice".
 *
 * Why a dedicated modal (not just dropping VoiceInput into the toolbar):
 * the JTBD here is "capture an idea fast, hands-busy". The user wants a
 * big, focused affordance, not a tiny mic next to other controls. This
 * modal:
 *
 *   - Live waveform from the input stream (Canvas2D + AudioContext) so
 *     the user feels the recording happen.
 *   - Auto-stop guardrail at 5 minutes (mirror of VoiceInput's MAX).
 *   - On stop → ElevenLabs Scribe via /api/voice/transcribe.
 *   - Shows the transcript inline before committing — the user can
 *     re-record if it came out wrong (Scribe is good, not perfect).
 *   - Confirm → calls onCommit({ title, md }) and closes.
 *
 * Title heuristic: first sentence of the transcript, capped to 60 chars.
 * Keeps the new hoja from showing up as "Sin título" by default.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Check, Loader2, Mic, MicOff, Square, X, RefreshCw } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onClose: () => void;
  onCommit: (data: { title: string; md: string }) => Promise<void> | void;
  /** "Nueva hoja por voz" or "Agregar a hoja" — drives header copy. */
  mode: 'new' | 'append';
}

const MAX_RECORD_MS = 5 * 60 * 1000;

type Phase = 'idle' | 'recording' | 'transcribing' | 'review' | 'error' | 'denied';

export function VoiceCaptureModal({ open, onClose, onCommit, mode }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [committing, setCommitting] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Reset everything on close.
  useEffect(() => {
    if (open) return;
    cleanup();
    setPhase('idle');
    setTranscript('');
    setError(null);
    setSeconds(0);
    setCommitting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const cleanup = useCallback(() => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    if (autoStopRef.current) { clearTimeout(autoStopRef.current); autoStopRef.current = null; }
    if (animationRef.current) { cancelAnimationFrame(animationRef.current); animationRef.current = null; }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => null);
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    stopTracks();
    setSeconds(0);
  }, [stopTracks]);

  // Live waveform on the canvas while recording. Uses an AnalyserNode
  // bound to the same MediaStream multer captures from. Pure cosmetic;
  // no bytes leave the browser from this audio context.
  const startWaveform = useCallback((stream: MediaStream) => {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    audioCtxRef.current = ctx;
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.7;
    source.connect(analyser);
    analyserRef.current = analyser;

    const buffer = new Uint8Array(analyser.frequencyBinCount);
    const draw = () => {
      animationRef.current = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      if (!canvas || !analyserRef.current) return;
      analyserRef.current.getByteFrequencyData(buffer);
      const c = canvas.getContext('2d');
      if (!c) return;
      const w = canvas.width;
      const h = canvas.height;
      c.clearRect(0, 0, w, h);
      const bars = 48;
      const step = Math.floor(buffer.length / bars);
      const gap = 3;
      const barW = (w - gap * (bars - 1)) / bars;
      for (let i = 0; i < bars; i++) {
        const v = buffer[i * step] / 255;
        const barH = Math.max(3, v * h * 0.85);
        const x = i * (barW + gap);
        const y = (h - barH) / 2;
        c.fillStyle = '#7A3B47';
        c.fillRect(x, y, barW, barH);
      }
    };
    draw();
  }, []);

  // ── Send blob to BFF ──────────────────────────────────────────────
  const transcribeBlob = useCallback(async (blob: Blob) => {
    setPhase('transcribing');
    try {
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      const fd = new FormData();
      fd.append('audio', blob, `recording.${blob.type.includes('webm') ? 'webm' : 'ogg'}`);
      const res = await fetch('/api/voice/transcribe', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: fd,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const { text } = (await res.json()) as { text: string };
      const t = (text ?? '').trim();
      if (!t) throw new Error('No se reconoció ninguna palabra. Intentá hablar más cerca del micrófono.');
      setTranscript(t);
      setPhase('review');
    } catch (err) {
      setError((err as Error).message);
      setPhase('error');
    }
  }, []);

  // ── Start ──────────────────────────────────────────────────────────
  const startRecording = useCallback(async () => {
    try {
      setError(null);
      setTranscript('');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      const mimeCandidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/mp4',
      ];
      const mime = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recorderRef.current = recorder;

      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        // Stop tracks + waveform now that recording is over.
        if (animationRef.current) { cancelAnimationFrame(animationRef.current); animationRef.current = null; }
        stopTracks();
        if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
        if (autoStopRef.current) { clearTimeout(autoStopRef.current); autoStopRef.current = null; }
        if (blob.size > 1024) {
          void transcribeBlob(blob);
        } else {
          setPhase('idle');
        }
      };

      recorder.start();
      setPhase('recording');
      setSeconds(0);
      // Haptic on supported devices.
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        try { navigator.vibrate?.(10); } catch { /* fail silent */ }
      }
      startWaveform(stream);
      tickRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
      autoStopRef.current = setTimeout(() => {
        if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
      }, MAX_RECORD_MS);
    } catch (err) {
      setError((err as Error).message);
      setPhase('denied');
    }
  }, [stopTracks, startWaveform, transcribeBlob]);

  const stopRecording = useCallback(() => {
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.stop();
      // Haptic on stop too.
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        try { navigator.vibrate?.([10, 30, 10]); } catch { /* fail silent */ }
      }
    }
  }, []);

  const commitNow = async () => {
    if (!transcript.trim() || committing) return;
    setCommitting(true);
    try {
      const title = deriveTitle(transcript);
      await onCommit({ title, md: transcript.trim() });
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setPhase('error');
      setCommitting(false);
    }
  };

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m.toString().padStart(2, '0')}:${r.toString().padStart(2, '0')}`;
  };

  if (!open) return null;

  return (
    <AnimatePresence>
      <motion.div
        key="vc-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-0 z-[200] bg-black/55 backdrop-blur-sm"
      />
      <motion.div
        key="vc-dialog"
        initial={{ opacity: 0, y: 20, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.97 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        className="fixed left-1/2 top-1/2 z-[201] w-[min(94vw,560px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-[#0e1745]/[0.08] dark:border-white/[0.08] bg-white dark:bg-[#231f1f] shadow-[0_30px_80px_rgba(14,23,69,0.20)]"
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-[#0e1745]/[0.06] dark:border-white/[0.06]">
          <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-cl2-burgundy/10 text-cl2-burgundy dark:text-[#d8a4ad]">
            <Mic size={15} />
          </span>
          <div className="flex-1 min-w-0">
            <div className="font-display text-[18px] tracking-tight text-[#0e1745] dark:text-white">
              {mode === 'new' ? 'Nueva hoja por voz' : 'Agregar a la hoja por voz'}
            </div>
            <div className="text-[11px] text-[#0e1745]/55 dark:text-white/55">
              Hablá natural. Después podés revisar el texto antes de guardarlo.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-[#0e1745]/[0.05] dark:hover:bg-white/[0.05] text-[#0e1745]/60 dark:text-white/60"
            aria-label="Cerrar"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-6">
          {/* Waveform / state visual */}
          <div className="relative h-[120px] rounded-xl bg-[#0e1745]/[0.04] dark:bg-white/[0.04] border border-[#0e1745]/[0.06] dark:border-white/[0.06] overflow-hidden flex items-center justify-center">
            {phase === 'recording' ? (
              <canvas ref={canvasRef} width={500} height={120} className="w-full h-full" />
            ) : phase === 'transcribing' ? (
              <div className="flex items-center gap-2.5 text-[#0e1745]/65 dark:text-white/65">
                <Loader2 size={18} className="animate-spin text-cl2-burgundy dark:text-cl2-accent-soft" />
                <span className="text-[13px]">Transcribiendo…</span>
              </div>
            ) : phase === 'review' ? (
              <div className="px-4 py-3 w-full">
                <div className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-cl2-burgundy dark:text-[#d8a4ad] mb-1.5">
                  Transcripción
                </div>
                <div className="text-[13.5px] leading-relaxed text-[#0e1745] dark:text-white max-h-[88px] overflow-y-auto">
                  {transcript}
                </div>
              </div>
            ) : phase === 'denied' ? (
              <div className="flex items-center gap-2 text-rose-600 dark:text-rose-300 text-[13px]">
                <MicOff size={16} /> Permiso de micrófono denegado
              </div>
            ) : (
              <div className="text-[#0e1745]/45 dark:text-white/45 text-[13px]">
                Click el botón rojo para empezar
              </div>
            )}
          </div>

          {/* Timer + state copy under the visual */}
          <div className="mt-3 flex items-center justify-between text-[11px] font-mono text-[#0e1745]/55 dark:text-white/55">
            <span className="tabular-nums">
              {phase === 'recording' ? formatTime(seconds) : '00:00'}
            </span>
            <span>
              {phase === 'recording' && 'grabando…'}
              {phase === 'review' && 'revisá antes de guardar'}
            </span>
          </div>

          {error && (
            <div className="mt-3 rounded-md border border-rose-300/40 bg-rose-50 dark:bg-rose-500/10 dark:border-rose-500/30 px-3 py-2 text-[12.5px] text-rose-700 dark:text-rose-300">
              {error}
            </div>
          )}

          {/* Primary action — context-dependent */}
          <div className="mt-5 flex items-center justify-center">
            {(phase === 'idle' || phase === 'error' || phase === 'denied') && (
              <button
                type="button"
                onClick={() => void startRecording()}
                className="inline-flex items-center gap-2 px-5 py-3 rounded-full bg-cl2-accent hover:bg-cl2-accent-hover text-white text-[13px] font-semibold shadow-sm shadow-cl2-accent/30"
              >
                <Mic size={14} />
                {phase === 'error' ? 'Reintentar' : 'Empezar a grabar'}
              </button>
            )}
            {phase === 'recording' && (
              <button
                type="button"
                onClick={stopRecording}
                className="inline-flex items-center gap-2 px-5 py-3 rounded-full bg-[#0e1745] dark:bg-white text-white dark:text-[#0e1745] text-[13px] font-semibold"
              >
                <Square size={12} className="fill-current" />
                Terminar
              </button>
            )}
            {phase === 'review' && (
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => void startRecording()}
                  className={cn(
                    'inline-flex items-center gap-1.5 px-4 py-2.5 rounded-full text-[12.5px] font-medium',
                    'bg-[#0e1745]/[0.05] dark:bg-white/[0.06] text-[#0e1745]/75 dark:text-white/75',
                    'hover:bg-[#0e1745]/[0.08] dark:hover:bg-white/[0.10]',
                  )}
                >
                  <RefreshCw size={12} /> Re-grabar
                </button>
                <button
                  type="button"
                  onClick={() => void commitNow()}
                  disabled={committing || !transcript.trim()}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-cl2-accent hover:bg-cl2-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white text-[13px] font-semibold shadow-sm shadow-cl2-accent/30"
                >
                  {committing ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                  {mode === 'new' ? 'Crear hoja' : 'Agregar al body'}
                </button>
              </div>
            )}
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

/** First sentence (or chars 0..60) → title. */
function deriveTitle(text: string): string {
  const t = text.trim();
  if (!t) return 'Nota por voz';
  const sentenceEnd = t.search(/[.!?]/);
  const firstSentence = sentenceEnd > 0 ? t.slice(0, sentenceEnd) : t;
  const cleaned = firstSentence.replace(/\s+/g, ' ').trim();
  return cleaned.length > 60 ? cleaned.slice(0, 57).trimEnd() + '…' : cleaned;
}
