// Beamhop design tokens. tokens.css mirrors these as CSS custom properties.
export const colors = {
  midnight: '#0B0E1A',
  surface: '#141829',
  surfaceRaised: '#1C2138',
  border: '#2A3050',
  text: '#E8EAF6',
  textMuted: '#9AA0C3',
  teal: '#5EEAD4',
  violet: '#8B7BFF',
  success: '#4ADE80',
  warning: '#FBBF24',
  danger: '#F87171',
} as const

export const pathColors = {
  direct: colors.teal,
  turn: colors.violet,
  relay: colors.warning,
  memory: colors.textMuted,
} as const

export const radii = { sm: '6px', md: '10px', lg: '16px' } as const
export const fonts = {
  sans: "'Inter', system-ui, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, monospace",
} as const

/** Mascot states used for loading, empty and error states. */
export type MascotState = 'idle' | 'spinner' | 'smile' | 'angry' | 'secret'
