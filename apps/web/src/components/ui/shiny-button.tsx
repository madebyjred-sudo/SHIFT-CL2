import type React from "react"
import { cn } from "@/lib/utils"

interface ShinyButtonProps {
  children: React.ReactNode
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void
  className?: string
  active?: boolean
  ariaLabel?: string
  title?: string
}

export function ShinyButton({
  children,
  onClick,
  className = "",
  active = false,
  ariaLabel,
  title,
}: ShinyButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={ariaLabel}
      title={title}
      className={cn(active ? "shiny-cta shiny-cta--on" : "shiny-cta shiny-cta--off", className)}
    >
      <span>{children}</span>
    </button>
  )
}
