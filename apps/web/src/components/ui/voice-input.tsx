"use client"

import React from "react"
import { Mic } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"

import { cn } from "@/lib/utils"

interface VoiceInputProps {
  onStart?: () => void
  onStop?: () => void
  accent?: string
}

export function VoiceInput({
  className,
  onStart,
  onStop,
  accent = "#F43F5E",
}: React.ComponentProps<"div"> & VoiceInputProps) {
  const [_listening, _setListening] = React.useState<boolean>(false)
  const [_time, _setTime] = React.useState<number>(0)

  React.useEffect(() => {
    let intervalId: ReturnType<typeof setInterval>

    if (_listening) {
      onStart?.()
      intervalId = setInterval(() => {
        _setTime((t) => t + 1)
      }, 1000)
    } else {
      onStop?.()
      _setTime(0)
    }

    return () => clearInterval(intervalId)
  }, [_listening])

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
  }

  const onClickHandler = (e: React.MouseEvent) => {
    e.stopPropagation()
    _setListening(!_listening)
  }

  return (
    <div className={cn("flex items-center", className)}>
      <motion.div
        className={cn(
          "flex h-8 px-2 items-center justify-center rounded-full cursor-pointer border transition-colors",
          _listening
            ? "border-transparent text-white"
            : "border-black/10 dark:border-white/15 text-[#0e1745]/55 dark:text-white/55 hover:text-[#0e1745] dark:hover:text-white",
        )}
        layout
        transition={{
          layout: { duration: 0.35, type: "spring", stiffness: 280, damping: 30 },
        }}
        style={_listening ? { backgroundColor: accent } : undefined}
        onClick={onClickHandler}
        aria-label={_listening ? "Detener grabación" : "Grabar nota de voz"}
      >
        <div className="h-4 w-4 items-center justify-center flex">
          {_listening ? (
            <motion.div
              className="w-2.5 h-2.5 bg-white rounded-sm"
              animate={{ scale: [1, 1.15, 1] }}
              transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
            />
          ) : (
            <Mic className="w-3.5 h-3.5" />
          )}
        </div>
        <AnimatePresence mode="wait">
          {_listening && (
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
                      height: _listening
                        ? [2, 3 + Math.random() * 10, 3 + Math.random() * 5, 2]
                        : 2,
                    }}
                    transition={{
                      duration: _listening ? 1 : 0.3,
                      repeat: _listening ? Infinity : 0,
                      delay: _listening ? i * 0.05 : 0,
                      ease: "easeInOut",
                    }}
                  />
                ))}
              </div>
              <div className="text-[10px] font-mono w-9 text-center tabular-nums">
                {formatTime(_time)}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  )
}
