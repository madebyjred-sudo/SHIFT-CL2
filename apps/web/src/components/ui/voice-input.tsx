"use client"

/**
 * VoiceInput — push-to-record mic for the chat composer.
 *
 * Three states cycle: idle → recording → transcribing → idle.
 *
 * Pipeline:
 *   1. Click → request mic permission, start MediaRecorder (webm/opus).
 *   2. Click again → stop recording, POST blob to /api/voice/transcribe.
 *   3. ElevenLabs Scribe transcribes (~1-3s for short clips).
 *   4. onTranscript(text) fires → parent stuffs it into the textarea.
 *
 * Cost guardrails (mirrored on the server):
 *   - Audio capped at 5 minutes locally to avoid an accidental "left it on
 *     all afternoon" runaway. Server caps at 25MB.
 *   - We use webm/opus at the browser default bitrate (~64kbps) so even a
 *     5-min recording is ~2.4MB.
 *
 * Errors surface as a small inline state on the button itself — no toast,
 * no modal. The user can just click again.
 */
import React from "react"
import { Loader2, Mic, MicOff } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"

import { cn } from "@/lib/utils"
import { supabase } from "@/lib/supabase"

interface VoiceInputProps {
  /** Called once transcription completes. The text is already trimmed. */
  onTranscript?: (text: string) => void
  /** Optional: external "is busy" gate to disable the mic during streaming. */
  disabled?: boolean
  /** Accent color for the recording state pill (defaults to CL2 accent). */
  accent?: string
  className?: string
  /**
   * Override the transcribe endpoint. Defaults to '/api/voice/transcribe'
   * (auth-gated). The landing demo points this at '/api/public/voice'
   * which has stricter caps but no auth.
   */
  endpoint?: string
  /**
   * When true, do NOT attach the Supabase Bearer token. Required for the
   * public landing endpoint, which would otherwise see a stale anonymous
   * token if the user has a session and reject it as malformed.
   */
  skipAuth?: boolean
  /**
   * Fired on long-press (≥500ms hold) OR double-tap. Used to open the
   * conversational voice mode (VoiceConverseModal). When the handler is
   * provided, a long-press/double-tap will NOT trigger the standard
   * push-to-record STT flow. When omitted, the mic button behaves exactly
   * as before — single-click toggle.
   */
  onConversationalRequest?: () => void
}

const MAX_RECORD_MS = 5 * 60 * 1000  // 5 min — matches the cost guardrail

type State = "idle" | "recording" | "transcribing" | "error" | "denied"

export function VoiceInput({
  onTranscript,
  disabled = false,
  accent = "#F93549",
  className,
  endpoint = "/api/voice/transcribe",
  skipAuth = false,
  onConversationalRequest,
}: VoiceInputProps) {
  const [state, setState] = React.useState<State>("idle")
  const [seconds, setSeconds] = React.useState(0)
  const recorderRef = React.useRef<MediaRecorder | null>(null)
  const chunksRef = React.useRef<Blob[]>([])
  const streamRef = React.useRef<MediaStream | null>(null)
  const tickRef = React.useRef<ReturnType<typeof setInterval> | null>(null)
  const autoStopRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  // Long-press + double-tap gesture refs. The press timer fires after
  // 500ms of held click → opens conversational mode. A second click within
  // 300ms of the first also opens it. Either gesture suppresses the normal
  // single-click STT trigger via the suppressClickRef flag.
  const pressTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastTapRef = React.useRef<number>(0)
  const suppressClickRef = React.useRef<boolean>(false)
  const LONG_PRESS_MS = 500
  const DOUBLE_TAP_MS = 300

  const stopTracks = React.useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }, [])

  const cleanup = React.useCallback(() => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null }
    if (autoStopRef.current) { clearTimeout(autoStopRef.current); autoStopRef.current = null }
    stopTracks()
    setSeconds(0)
  }, [stopTracks])

  React.useEffect(() => {
    return () => cleanup()
  }, [cleanup])

  // ── Send blob to BFF and surface text via callback ──────────────────
  const transcribeBlob = React.useCallback(async (blob: Blob) => {
    setState("transcribing")
    try {
      let headers: HeadersInit | undefined
      if (!skipAuth) {
        const { data } = await supabase.auth.getSession()
        const token = data?.session?.access_token
        if (token) headers = { Authorization: `Bearer ${token}` }
      }

      const fd = new FormData()
      fd.append("audio", blob, `recording.${blob.type.includes("webm") ? "webm" : "ogg"}`)

      const res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: fd,
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const { text } = (await res.json()) as { text: string }
      if (text && text.length > 0) {
        onTranscript?.(text)
      }
      setState("idle")
    } catch (err) {
      console.warn("voice transcribe failed", err)
      setState("error")
      // Auto-clear error state after 2.5s so the user can retry
      setTimeout(() => setState("idle"), 2500)
    }
  }, [onTranscript, endpoint, skipAuth])

  // ── Start ──────────────────────────────────────────────────────────
  const startRecording = React.useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      chunksRef.current = []

      // Pick the most-supported codec. Safari needs mp4/m4a fallback.
      const mimeCandidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
        "audio/mp4",
      ]
      const mime = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? ""

      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      recorderRef.current = recorder

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" })
        cleanup()
        if (blob.size > 1024) {
          // 1KB floor — anything smaller is almost certainly silence
          // and would waste a Scribe call.
          transcribeBlob(blob)
        } else {
          setState("idle")
        }
      }

      recorder.start()
      setState("recording")
      setSeconds(0)
      tickRef.current = setInterval(() => setSeconds((s) => s + 1), 1000)
      // Hard auto-stop guardrail (cost guardrail mirror)
      autoStopRef.current = setTimeout(() => {
        if (recorderRef.current?.state === "recording") recorderRef.current.stop()
      }, MAX_RECORD_MS)
    } catch (err) {
      console.warn("getUserMedia denied", err)
      setState("denied")
      setTimeout(() => setState("idle"), 2500)
    }
  }, [cleanup, transcribeBlob])

  // ── Stop (then transcribe via the onstop handler) ──────────────────
  const stopRecording = React.useCallback(() => {
    if (recorderRef.current?.state === "recording") {
      recorderRef.current.stop()
    }
  }, [])

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (disabled) return
    // Gesture suppression: long-press or double-tap already handled the
    // interaction. Reset the flag and skip the normal toggle.
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    if (state === "idle" || state === "error" || state === "denied") {
      startRecording()
    } else if (state === "recording") {
      stopRecording()
    }
    // No-op while transcribing
  }

  // Pointer-down starts the long-press timer. We deliberately use pointer
  // events instead of mouse + touch separately — pointer covers both and
  // matches what motion/framer-motion expects.
  const handlePointerDown = (_e: React.PointerEvent) => {
    if (disabled || !onConversationalRequest) return
    if (state !== "idle" && state !== "error" && state !== "denied") return
    if (pressTimerRef.current) clearTimeout(pressTimerRef.current)
    pressTimerRef.current = setTimeout(() => {
      pressTimerRef.current = null
      suppressClickRef.current = true
      onConversationalRequest()
    }, LONG_PRESS_MS)
  }

  const cancelPressTimer = () => {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current)
      pressTimerRef.current = null
    }
  }

  const handlePointerUp = (_e: React.PointerEvent) => {
    // If the long-press timer is still pending, this was a quick tap →
    // cancel the long-press, fall through to double-tap detection.
    cancelPressTimer()
    if (!onConversationalRequest) return
    if (disabled) return
    const now = Date.now()
    if (now - lastTapRef.current < DOUBLE_TAP_MS) {
      suppressClickRef.current = true
      lastTapRef.current = 0
      // If we're mid-recording from the first tap of the double, abort it.
      if (state === "recording") {
        // Stop without sending — the user wanted the modal, not a one-shot.
        try { recorderRef.current?.stop() } catch { /* swallow */ }
      }
      onConversationalRequest()
      return
    }
    lastTapRef.current = now
  }

  // If the pointer leaves the button while held, treat as cancel — avoids
  // accidental modal opens when the user drags off mid-press.
  const handlePointerLeave = () => {
    cancelPressTimer()
  }

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60)
    const r = s % 60
    return `${m.toString().padStart(2, "0")}:${r.toString().padStart(2, "0")}`
  }

  const isRecording = state === "recording"
  const isTranscribing = state === "transcribing"

  const tooltip =
    state === "denied" ? "Permiso de micrófono denegado"
    : state === "error" ? "Error en transcripción — clickeá para reintentar"
    : state === "transcribing" ? "Transcribiendo…"
    : state === "recording" ? "Click para terminar y enviar"
    : onConversationalRequest
      ? "Dictar pregunta — mantené presionado o doble-click para modo conversación"
      : "Dictar pregunta (ElevenLabs Scribe)"

  return (
    <div className={cn("flex items-center", className)}>
      <motion.button
        type="button"
        data-testid="voice-input-button"
        onClick={handleClick}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onPointerCancel={handlePointerLeave}
        disabled={disabled || isTranscribing}
        title={tooltip}
        aria-label={tooltip}
        aria-pressed={isRecording}
        className={cn(
          "flex h-8 px-2 items-center justify-center rounded-full cursor-pointer border transition-colors",
          "disabled:opacity-60 disabled:cursor-not-allowed",
          isRecording || isTranscribing
            ? "border-transparent text-white"
            : state === "error" || state === "denied"
              ? "border-red-400/50 text-red-500 hover:text-red-600"
              : "border-black/10 dark:border-white/15 text-[#0e1745]/55 dark:text-white/55 hover:text-[#0e1745] dark:hover:text-white",
        )}
        layout
        transition={{
          layout: { duration: 0.35, type: "spring", stiffness: 280, damping: 30 },
        }}
        style={isRecording || isTranscribing ? { backgroundColor: accent } : undefined}
      >
        <div className="h-4 w-4 items-center justify-center flex">
          {isTranscribing ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : isRecording ? (
            <motion.div
              className="w-2.5 h-2.5 bg-white rounded-sm"
              animate={{ scale: [1, 1.15, 1] }}
              transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
            />
          ) : state === "denied" ? (
            <MicOff className="w-3.5 h-3.5" />
          ) : (
            <Mic className="w-3.5 h-3.5" />
          )}
        </div>

        <AnimatePresence mode="wait">
          {(isRecording || isTranscribing) && (
            <motion.div
              initial={{ opacity: 0, width: 0, marginLeft: 0 }}
              animate={{ opacity: 1, width: "auto", marginLeft: 8 }}
              exit={{ opacity: 0, width: 0, marginLeft: 0 }}
              transition={{ duration: 0.35 }}
              className="overflow-hidden flex gap-2 items-center justify-center"
            >
              <div className="flex gap-[2px] items-center justify-center">
                {[...Array(10)].map((_, i) => (
                  <motion.div
                    key={i}
                    className="w-[2px] bg-white/90 rounded-full"
                    initial={{ height: 2 }}
                    animate={{
                      height: isRecording
                        ? [2, 3 + Math.random() * 10, 3 + Math.random() * 5, 2]
                        : 2,
                    }}
                    transition={{
                      duration: isRecording ? 1 : 0.3,
                      repeat: isRecording ? Infinity : 0,
                      delay: isRecording ? i * 0.05 : 0,
                      ease: "easeInOut",
                    }}
                  />
                ))}
              </div>
              <div className="text-[10px] font-mono w-9 text-center tabular-nums text-white/95">
                {isTranscribing ? "···" : formatTime(seconds)}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.button>
    </div>
  )
}
