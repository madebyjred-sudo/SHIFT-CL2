"use client"

/**
 * VoiceConverseModal — hands-free conversational mode with Lexa.
 *
 * UX:
 *   1. Modal opens in `idle` state — single orb, "Tocá el orbe para hablar".
 *   2. Tap orb → `listening` (mic captures webm/opus).
 *   3. Tap orb again → `thinking` (POST /api/voice/converse, all roundtrips
 *      happen server-side: STT → Lexa LLM → TTS).
 *   4. Audio arrives → `speaking` (HTMLAudioElement plays the mp3).
 *      Transcript scrolls below.
 *   5. Audio ends → back to `idle`. Each turn is appended to a local
 *      history array sent on the NEXT request as context. History does NOT
 *      persist — closing the modal forgets it.
 *
 * Orb states use color + scale pulse via framer-motion:
 *   - idle      → static burgundy
 *   - listening → red, pulse 0.95→1.05 / 1.2s
 *   - thinking  → amber, pulse 0.97→1.03 / 0.8s
 *   - speaking  → green, pulse 0.93→1.08 / 0.6s
 *   - error     → red ring + retry hint
 *
 * Why a single orb instead of separate mic / play buttons:
 *   It's the same conversational unit — "the entity you're talking to is
 *   doing something". Mode is implicit in color/pulse. Mirrors voice-first
 *   apps like ChatGPT mobile and Pi.
 *
 * Doctrine — TTS is the only stretch piece in Sprint 3. Cost guardrails
 * are explicit and conservative; the server caps audio in (5MB), LLM
 * tokens (300), TTS chars (800), conversations/min (10), and monthly TTS
 * chars (90k ≈ 30 min). Read /api/voice/quota for the UI footer.
 */
import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Mic, MicOff, Loader2, AlertCircle, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';

const MAX_RECORD_MS = 5 * 60 * 1000; // 5 min — server caps at 5MB anyway

type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error' | 'denied';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  /** Timestamp for stable list key + ordering. */
  t: number;
}

interface VoiceConverseModalProps {
  open: boolean;
  onClose: () => void;
}

export function VoiceConverseModal({ open, onClose }: VoiceConverseModalProps): React.JSX.Element | null {
  const [state, setState] = React.useState<OrbState>('idle');
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const [showTranscript, setShowTranscript] = React.useState(false);
  const [turns, setTurns] = React.useState<Turn[]>([]);
  const [quotaExhausted, setQuotaExhausted] = React.useState(false);

  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const autoStopRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset everything when the modal opens. Closing tears down via the
  // unmount effect below; turn history is local-only so a fresh open
  // intentionally starts with a clean slate.
  React.useEffect(() => {
    if (open) {
      setState('idle');
      setErrorMsg(null);
      setShowTranscript(false);
      setTurns([]);
      setQuotaExhausted(false);
    }
  }, [open]);

  // Hard teardown on unmount: stop any in-flight audio, stop mic tracks,
  // clear the auto-stop timer.
  React.useEffect(() => {
    return () => {
      if (recorderRef.current?.state === 'recording') {
        try { recorderRef.current.stop(); } catch { /* swallow */ }
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      if (autoStopRef.current) clearTimeout(autoStopRef.current);
    };
  }, []);

  const stopMicTracks = React.useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // ── Send recorded blob to /api/voice/converse ──────────────────────
  const sendConverse = React.useCallback(async (blob: Blob) => {
    setState('thinking');
    setErrorMsg(null);

    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess?.session?.access_token;
      if (!token) {
        setState('error');
        setErrorMsg('Iniciá sesión para usar el modo voz.');
        return;
      }

      const fd = new FormData();
      const ext = blob.type.includes('webm') ? 'webm' : 'ogg';
      fd.append('audio', blob, `recording.${ext}`);
      // Send last 20 turns as context. Server also caps; this just keeps
      // the payload tight.
      fd.append(
        'history',
        JSON.stringify(turns.slice(-20).map((t) => ({ role: t.role, content: t.content }))),
      );

      const res = await fetch('/api/voice/converse', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        if (body.error === 'monthly_tts_quota_exhausted') {
          setQuotaExhausted(true);
          setState('error');
          setErrorMsg('Alcanzaste tu cuota de voz mensual.');
          return;
        }
        if (body.error === 'rate_limit' || res.status === 429) {
          setState('error');
          setErrorMsg('Esperá un momento entre conversaciones.');
          return;
        }
        if (body.error === 'empty_transcript') {
          // Silence / non-speech. Quiet recovery — don't shout at the user.
          setState('idle');
          return;
        }
        setState('error');
        setErrorMsg(body.message ?? body.error ?? 'No pude procesar el audio.');
        return;
      }

      const payload = (await res.json()) as {
        ok: boolean;
        transcript_user: string;
        transcript_lexa: string;
        audio_url: string;
      };

      // Append both turns to the rolling local history.
      const now = Date.now();
      setTurns((prev) => [
        ...prev,
        { role: 'user', content: payload.transcript_user, t: now },
        { role: 'assistant', content: payload.transcript_lexa, t: now + 1 },
      ]);

      // Play the audio. When playback ends we auto-return to idle so the
      // user can tap again without extra UI cleanup.
      setState('speaking');
      const audio = new Audio(payload.audio_url);
      audioRef.current = audio;
      audio.addEventListener('ended', () => {
        if (audioRef.current === audio) audioRef.current = null;
        setState('idle');
      });
      audio.addEventListener('error', () => {
        setState('error');
        setErrorMsg('No se pudo reproducir el audio.');
      });
      void audio.play().catch(() => {
        setState('error');
        setErrorMsg('No se pudo reproducir el audio.');
      });
    } catch (err) {
      console.warn('voice converse failed', err);
      setState('error');
      setErrorMsg((err as Error).message ?? 'No se pudo conectar con el servidor.');
    }
  }, [turns]);

  // ── Mic capture ────────────────────────────────────────────────────
  const startRecording = React.useCallback(async () => {
    try {
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

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        stopMicTracks();
        if (autoStopRef.current) {
          clearTimeout(autoStopRef.current);
          autoStopRef.current = null;
        }
        if (blob.size > 1024) {
          void sendConverse(blob);
        } else {
          // Sub-1KB = essentially silence; don't waste a paid roundtrip.
          setState('idle');
        }
      };

      recorder.start();
      setState('listening');

      // Auto-stop guard — mirror the server's 5MB cap roughly.
      autoStopRef.current = setTimeout(() => {
        if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
      }, MAX_RECORD_MS);
    } catch (err) {
      console.warn('mic denied', err);
      setState('denied');
      setErrorMsg('Permiso de micrófono denegado.');
    }
  }, [sendConverse, stopMicTracks]);

  const stopRecording = React.useCallback(() => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  }, []);

  const handleOrbClick = () => {
    if (quotaExhausted) return;
    if (state === 'idle' || state === 'error' || state === 'denied') {
      void startRecording();
      return;
    }
    if (state === 'listening') {
      stopRecording();
      return;
    }
    if (state === 'speaking') {
      // Tap during playback → cut Lexa off and immediately start listening.
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      void startRecording();
      return;
    }
    // No-op while thinking (we're already waiting on the server)
  };

  // ── Render gates ───────────────────────────────────────────────────
  if (!open) return null;

  // Visual config per state. Color is the orb's radial-gradient inner
  // color; the outer ring stays burgundy regardless so the brand reads
  // through.
  const orbConfig: Record<OrbState, {
    inner: string;
    outer: string;
    scale: number[];
    duration: number;
    label: string;
  }> = {
    idle:      { inner: '#7A1F2B', outer: '#3D0F16', scale: [1, 1.015, 1],    duration: 4.0, label: 'Tocá el orbe para hablar' },
    listening: { inner: '#F93549', outer: '#7A1F2B', scale: [0.95, 1.05, 0.95], duration: 1.2, label: 'Te escucho — tocá de nuevo cuando termines' },
    thinking:  { inner: '#D97706', outer: '#7A1F2B', scale: [0.97, 1.03, 0.97], duration: 0.8, label: 'Lexa está pensando…' },
    speaking:  { inner: '#16A34A', outer: '#7A1F2B', scale: [0.93, 1.08, 0.93], duration: 0.6, label: 'Lexa responde — tocá para interrumpir' },
    error:     { inner: '#7A1F2B', outer: '#3D0F16', scale: [1, 1.02, 1],     duration: 2.0, label: errorMsg ?? 'Algo salió mal — tocá para reintentar' },
    denied:    { inner: '#7A1F2B', outer: '#3D0F16', scale: [1, 1.02, 1],     duration: 2.0, label: errorMsg ?? 'Permiso de micrófono denegado' },
  };

  const cur = orbConfig[state];

  return (
    <AnimatePresence>
      <motion.div
        key="voice-converse-modal"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.25 }}
        className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-[#0e0507] text-white"
        role="dialog"
        aria-modal="true"
        aria-label="Modo voz con Lexa"
      >
        {/* Close button */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar modo voz"
          className="absolute top-6 right-6 p-2 rounded-full hover:bg-white/10 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Orb */}
        <motion.button
          type="button"
          onClick={handleOrbClick}
          disabled={state === 'thinking' || quotaExhausted}
          aria-label={cur.label}
          aria-pressed={state === 'listening'}
          className={cn(
            'relative w-64 h-64 rounded-full flex items-center justify-center',
            'cursor-pointer disabled:cursor-not-allowed',
            'focus:outline-none focus:ring-4 focus:ring-white/20',
          )}
          animate={{ scale: cur.scale }}
          transition={{
            duration: cur.duration,
            repeat: Infinity,
            ease: 'easeInOut',
          }}
          style={{
            background: `radial-gradient(circle at 35% 30%, ${cur.inner} 0%, ${cur.outer} 70%, #0e0507 100%)`,
            boxShadow: `0 0 80px 8px ${cur.inner}55`,
          }}
        >
          {/* Inner icon hint */}
          <div className="text-white/85">
            {state === 'thinking' ? (
              <Loader2 className="w-10 h-10 animate-spin" />
            ) : state === 'denied' ? (
              <MicOff className="w-10 h-10" />
            ) : state === 'error' ? (
              <AlertCircle className="w-10 h-10" />
            ) : (
              <Mic className={cn('w-10 h-10', state === 'listening' && 'opacity-90')} />
            )}
          </div>
        </motion.button>

        {/* State label */}
        <div className="mt-10 text-center max-w-md px-6">
          <p className={cn(
            'text-sm font-medium tracking-wide',
            (state === 'error' || state === 'denied') ? 'text-red-300' : 'text-white/80',
          )}>
            {cur.label}
          </p>
          {quotaExhausted && (
            <p className="mt-2 text-xs text-amber-200/80">
              Llegaste al límite mensual de voz. Las conversaciones por texto siguen disponibles.
            </p>
          )}
        </div>

        {/* Transcript toggle + panel */}
        <div className="absolute bottom-8 left-0 right-0 px-6">
          {turns.length > 0 && (
            <div className="mx-auto max-w-2xl">
              <button
                type="button"
                onClick={() => setShowTranscript((v) => !v)}
                className="flex items-center gap-1.5 text-xs text-white/60 hover:text-white/90 transition-colors mx-auto"
                aria-expanded={showTranscript}
              >
                <ChevronDown
                  className={cn(
                    'w-3.5 h-3.5 transition-transform',
                    showTranscript ? 'rotate-180' : 'rotate-0',
                  )}
                />
                {showTranscript ? 'Ocultar transcripción' : `Mostrar transcripción (${turns.length})`}
              </button>

              <AnimatePresence initial={false}>
                {showTranscript && (
                  <motion.div
                    key="transcript-panel"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.25 }}
                    className="overflow-hidden mt-3"
                  >
                    <div className="max-h-64 overflow-y-auto rounded-lg bg-white/5 border border-white/10 p-4 space-y-3 text-sm">
                      {turns.map((turn) => (
                        <div
                          key={turn.t}
                          className={cn(
                            'leading-relaxed',
                            turn.role === 'user' ? 'text-white/70' : 'text-white/95',
                          )}
                        >
                          <span className={cn(
                            'inline-block px-1.5 py-0.5 mr-2 text-[10px] uppercase tracking-wider rounded',
                            turn.role === 'user'
                              ? 'bg-white/10 text-white/60'
                              : 'bg-cl2-burgundy/40 text-white/90',
                          )}>
                            {turn.role === 'user' ? 'Vos' : 'Lexa'}
                          </span>
                          {turn.content}
                        </div>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
