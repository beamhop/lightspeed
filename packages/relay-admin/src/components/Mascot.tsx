import type { MascotState } from '@beamhop/ui'
import type { ReactNode } from 'react'

export type { MascotState }

const FUR = 'var(--bh-text)'
const LINE = 'var(--bh-midnight)'

/** Hand-drawn Beamhop bunny. States: idle, spinner (loading), smile (empty/success), angry (error), secret. */
export function Mascot({
  state = 'idle',
  size = 96,
  title,
}: {
  state?: MascotState
  size?: number
  title?: string
}) {
  const earInner = state === 'angry' ? 'var(--bh-danger)' : 'var(--bh-violet)'
  const label = title ?? `Bunny mascot (${state})`
  return (
    <svg
      viewBox="0 0 120 120"
      width={size}
      height={size}
      role="img"
      aria-label={label}
      data-mascot={state}
      style={{ overflow: 'visible' }}
    >
      <title>{label}</title>
      {state === 'spinner' && (
        <g style={{ transformOrigin: '60px 64px', animation: 'bh-spin 1.1s linear infinite' }}>
          <circle cx="60" cy="64" r="54" fill="none" stroke="var(--bh-border)" strokeWidth="5" />
          <path
            d="M60 10 A54 54 0 0 1 114 64"
            fill="none"
            stroke="var(--bh-teal)"
            strokeWidth="5"
            strokeLinecap="round"
          />
        </g>
      )}
      <g
        style={{
          transformOrigin: '60px 110px',
          animation:
            state === 'spinner'
              ? 'bh-hop 0.9s ease-in-out infinite'
              : state === 'angry'
                ? 'bh-shake 0.5s ease-in-out 2'
                : undefined,
        }}
      >
        {/* ears */}
        <g transform="rotate(-14 46 40)">
          <ellipse cx="46" cy="24" rx="10" ry="24" fill={FUR} />
          <ellipse cx="46" cy="26" rx="4.5" ry="16" fill={earInner} opacity="0.8" />
        </g>
        <g transform={state === 'secret' ? 'rotate(40 74 40)' : 'rotate(14 74 40)'}>
          <ellipse cx="74" cy="24" rx="10" ry="24" fill={FUR} />
          <ellipse cx="74" cy="26" rx="4.5" ry="16" fill={earInner} opacity="0.8" />
        </g>
        {/* body + head */}
        <ellipse cx="60" cy="98" rx="30" ry="18" fill={FUR} />
        <circle cx="60" cy="66" r="28" fill={FUR} />
        {/* cheeks */}
        {(state === 'smile' || state === 'angry') && (
          <>
            <ellipse
              cx="42"
              cy="74"
              rx="5"
              ry="3"
              fill={state === 'angry' ? 'var(--bh-danger)' : 'var(--bh-violet)'}
              opacity="0.45"
            />
            <ellipse
              cx="78"
              cy="74"
              rx="5"
              ry="3"
              fill={state === 'angry' ? 'var(--bh-danger)' : 'var(--bh-violet)'}
              opacity="0.45"
            />
          </>
        )}
        <Eyes state={state} />
        {/* nose */}
        <path d="M56 72 L64 72 L60 77 Z" fill="var(--bh-teal)" />
        <Mouth state={state} />
        {state === 'secret' && (
          <g>
            {/* paw over mouth + lock */}
            <ellipse cx="60" cy="86" rx="9" ry="6" fill={FUR} stroke={LINE} strokeWidth="1.5" />
            <g transform="translate(86 78)">
              <rect x="0" y="8" width="20" height="16" rx="3" fill="var(--bh-violet)" />
              <path
                d="M4 8 V4 a6 6 0 0 1 12 0 V8"
                fill="none"
                stroke="var(--bh-violet)"
                strokeWidth="3"
              />
              <circle cx="10" cy="16" r="2.4" fill={LINE} />
            </g>
          </g>
        )}
      </g>
    </svg>
  )
}

function Eyes({ state }: { state: MascotState }) {
  switch (state) {
    case 'smile':
      return (
        <g fill="none" stroke={LINE} strokeWidth="3" strokeLinecap="round">
          <path d="M44 64 Q49 57 54 64" />
          <path d="M66 64 Q71 57 76 64" />
        </g>
      )
    case 'angry':
      return (
        <g>
          <path d="M42 54 L54 59" stroke={LINE} strokeWidth="3" strokeLinecap="round" />
          <path d="M78 54 L66 59" stroke={LINE} strokeWidth="3" strokeLinecap="round" />
          <circle cx="49" cy="64" r="3" fill={LINE} />
          <circle cx="71" cy="64" r="3" fill={LINE} />
        </g>
      )
    case 'secret':
      return (
        <g fill="none" stroke={LINE} strokeWidth="3" strokeLinecap="round">
          <path d="M44 63 L54 63" />
          <path d="M66 63 L76 63" />
        </g>
      )
    default:
      return (
        <g style={{ transformOrigin: '60px 63px', animation: 'bh-blink 4s infinite' }}>
          <circle cx="49" cy="63" r="4" fill={LINE} />
          <circle cx="71" cy="63" r="4" fill={LINE} />
          <circle cx="50.5" cy="61.5" r="1.3" fill={FUR} />
          <circle cx="72.5" cy="61.5" r="1.3" fill={FUR} />
        </g>
      )
  }
}

function Mouth({ state }: { state: MascotState }) {
  if (state === 'secret') return null
  if (state === 'smile') return <path d="M52 80 Q60 90 68 80 Z" fill={LINE} />
  if (state === 'angry')
    return (
      <path
        d="M53 85 Q60 79 67 85"
        fill="none"
        stroke={LINE}
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    )
  return (
    <path
      d="M54 80 Q57 83 60 80 Q63 83 66 80"
      fill="none"
      stroke={LINE}
      strokeWidth="2"
      strokeLinecap="round"
    />
  )
}

/** Mascot + message block used for loading, empty and error states. */
export function MascotMessage({
  state,
  title,
  children,
  compact,
}: {
  state: MascotState
  title: string
  children?: ReactNode
  compact?: boolean
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center text-center gap-3 ${compact ? 'py-6' : 'py-12'}`}
      role={state === 'angry' ? 'alert' : 'status'}
    >
      <Mascot state={state} size={compact ? 64 : 96} />
      <div className="font-semibold text-foreground">{title}</div>
      {children && <div className="text-sm text-muted-foreground max-w-sm">{children}</div>}
    </div>
  )
}
