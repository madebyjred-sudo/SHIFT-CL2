/**
 * CL2 Design Tokens
 * Extraídos de Figma: https://www.figma.com/design/KGy0pV71x0VmkWccgSzwf9/CL2-UX-UI
 */

export const colors = {
  // Base
  bg: 'rgb(12 12 16)',
  surface: 'rgb(22 22 28)',
  'surface-hover': 'rgb(28 28 36)',
  border: 'rgb(38 38 48)',
  'border-subtle': 'rgb(30 30 38)',
  fg: 'rgb(240 240 245)',
  'fg-secondary': 'rgb(200 200 210)',
  muted: 'rgb(140 140 155)',
  'muted-light': 'rgb(180 180 190)',
  accent: 'rgb(99 152 255)',
  'accent-hover': 'rgb(120 170 255)',

  // Agents
  lexa: 'rgb(37 99 235)',
  'lexa-light': 'rgb(219 234 254)',
  atlas: 'rgb(5 150 105)',
  'atlas-light': 'rgb(209 250 229)',
  centinela: 'rgb(244 63 94)',
  'centinela-light': 'rgb(255 228 230)',

  // Semantic
  success: 'rgb(16 185 129)',
  warning: 'rgb(245 158 11)',
  error: 'rgb(244 63 94)',
  info: 'rgb(59 130 246)',

  // Highlight
  highlight: 'rgb(254 240 138)',
  'highlight-bg': 'rgb(254 252 232)',
} as const;

export const typography = {
  fontFamily: {
    sans: "'Inter', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    mono: "'Nimbus Mono PS', 'Courier New', monospace",
  },
  fontSize: {
    xs: '10px',
    sm: '12px',
    base: '14px',
    lg: '16px',
    xl: '20px',
  },
  fontWeight: {
    regular: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
  },
  lineHeight: {
    tight: '16px',
    normal: '20px',
    relaxed: '26px',
  },
} as const;

export const spacing = {
  px: '1px',
  0: '0',
  0.5: '2px',
  1: '4px',
  1.5: '6px',
  2: '8px',
  2.5: '10px',
  3: '12px',
  4: '16px',
  5: '20px',
  6: '24px',
  8: '32px',
  10: '40px',
  12: '48px',
} as const;

export const borderRadius = {
  none: '0',
  sm: '8px',
  DEFAULT: '12px',
  full: '9999px',
} as const;

export const shadows = {
  sm: '0 1px 2px rgb(0 0 0 / 0.05)',
  DEFAULT: '0 4px 6px rgb(0 0 0 / 0.1)',
  lg: '0 10px 15px rgb(0 0 0 / 0.1)',
  glow: '0 0 20px rgb(99 152 255 / 0.3)',
} as const;

export const transitions = {
  fast: '150ms ease',
  DEFAULT: '200ms ease',
  slow: '300ms ease',
} as const;

export const agents = {
  lexa: {
    id: 'lexa',
    name: 'Lexa',
    tagline: 'Consultas legislativas',
    description: 'Experta en actas, proyectos de ley, mociones y orden del día.',
    color: 'rgb(37 99 235)',
    'color-light': 'rgb(219 234 254)',
    icon: 'Scale',
  },
  atlas: {
    id: 'atlas',
    name: 'Atlas',
    tagline: 'Documental y análisis',
    description: 'Procesa documentos, genera resúmenes y presentaciones.',
    color: 'rgb(5 150 105)',
    'color-light': 'rgb(209 250 229)',
    icon: 'FileText',
  },
  centinela: {
    id: 'centinela',
    name: 'Centinela',
    tagline: 'Monitoreo y alertas',
    description: 'Deep Insight, comparativas históricas y patrones.',
    color: 'rgb(244 63 94)',
    'color-light': 'rgb(255 228 230)',
    icon: 'Radar',
  },
} as const;

export type AgentId = keyof typeof agents;
