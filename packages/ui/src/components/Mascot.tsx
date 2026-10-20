/** @jsxImportSource preact */
import type { JSX } from 'preact'
import { colors, type MascotState } from '../tokens'
import { cx } from './util'

export interface MascotProps {
  state?: MascotState
  size?: number
  /** Accessible label; defaults to a description of the state. */
  label?: string
  class?: string
}

const LABELS: Record<MascotState, string> = {
  idle: 'Beamhop bunny',
  spinner: 'Loading',
  smile: 'Beamhop bunny smiling',
  angry: 'Beamhop bunny looking upset',
  secret: 'Beamhop bunny keeping a secret',
}

// Fill/stroke attributes carry token hex values so the SVG renders standalone; components.css
// overrides them with the --bh-* variables when the stylesheet is loaded.
const FUR = colors.text
const INK = colors.midnight
const BLUSH = colors.violet

function Eyes({ state }: { state: MascotState }): JSX.Element {
  if (state === 'smile') {
    return (
      <g class="bh-mascot__eyes" fill="none" stroke={INK} stroke-width="3" stroke-linecap="round">
        <path d="M41 70 Q47 62 53 70" />
        <path d="M67 70 Q73 62 79 70" />
      </g>
    )
  }
  if (state === 'secret') {
    return (
      <g class="bh-mascot__eyes">
        <path
          d="M41 69 Q47 73 53 69"
          fill="none"
          stroke={INK}
          stroke-width="3"
          stroke-linecap="round"
        />
        <ellipse cx="73" cy="68" rx="4.5" ry="5.5" fill={INK} />
        <circle cx="74.6" cy="66" r="1.6" fill={FUR} />
      </g>
    )
  }
  // spinner looks up toward the orbiting ring; angry gets narrowed eyes under brows.
  const dx = state === 'spinner' ? 1.5 : 0
  const dy = state === 'spinner' ? -2 : 0
  const ry = state === 'angry' ? 4 : 5.5
  return (
    <g class="bh-mascot__eyes">
      <ellipse cx={47 + dx} cy={68 + dy} rx="4.5" ry={ry} fill={INK} />
      <ellipse cx={73 + dx} cy={68 + dy} rx="4.5" ry={ry} fill={INK} />
      <circle cx={48.6 + dx} cy={66 + dy} r="1.6" fill={FUR} />
      <circle cx={74.6 + dx} cy={66 + dy} r="1.6" fill={FUR} />
      {state === 'angry' && (
        <g stroke={INK} stroke-width="3.5" stroke-linecap="round">
          <path d="M39 57 L53 62" />
          <path d="M81 57 L67 62" />
        </g>
      )}
    </g>
  )
}

function Mouth({ state }: { state: MascotState }): JSX.Element {
  const stroke = {
    fill: 'none',
    stroke: INK,
    'stroke-width': 2.5,
    'stroke-linecap': 'round',
  } as const
  switch (state) {
    case 'smile':
      return <path class="bh-mascot__mouth" d="M50 85 Q60 98 70 85 Z" fill={INK} />
    case 'angry':
      return <path class="bh-mascot__mouth" d="M51 93 Q60 85 69 93" {...stroke} />
    case 'spinner':
      return <ellipse class="bh-mascot__mouth" cx="60" cy="89" rx="3" ry="3.5" fill={INK} />
    case 'secret':
      // the paw covers the mouth; a "shh" whisper line peeks out to the side
      return (
        <g class="bh-mascot__mouth" {...stroke}>
          <path d="M84 86 q4 -2 7 0" />
          <path d="M86 92 q4 -1 7 2" />
        </g>
      )
    default:
      return (
        <g class="bh-mascot__mouth" {...stroke}>
          <path d="M60 82 L60 86" />
          <path d="M60 86 Q55.5 91 51.5 87.5" />
          <path d="M60 86 Q64.5 91 68.5 87.5" />
        </g>
      )
  }
}

/** The Beamhop bunny. States cover loading (spinner), empty (idle), success (smile),
 * errors (angry) and private/encrypted content (secret). */
export function Mascot({ state = 'idle', size = 64, label, class: className }: MascotProps) {
  const innerEar = state === 'angry' ? colors.danger : BLUSH
  return (
    <svg
      class={cx('bh-mascot', `bh-mascot--${state}`, className)}
      data-state={state}
      width={size}
      height={size}
      viewBox="0 0 120 120"
      role="img"
      aria-label={label ?? LABELS[state]}
    >
      {state === 'spinner' && (
        <g class="bh-mascot__ring">
          <circle
            cx="60"
            cy="64"
            r="54"
            fill="none"
            stroke={colors.teal}
            stroke-width="4"
            stroke-dasharray="60 280"
            stroke-linecap="round"
          >
            <animateTransform
              attributeName="transform"
              type="rotate"
              from="0 60 64"
              to="360 60 64"
              dur="1.1s"
              repeatCount="indefinite"
            />
          </circle>
        </g>
      )}
      <g class="bh-mascot__ears">
        <g transform={state === 'angry' ? 'rotate(-22 46 52)' : 'rotate(-10 46 52)'}>
          <ellipse
            class="bh-mascot__fur"
            cx="46"
            cy="28"
            rx="11"
            ry="27"
            fill={FUR}
            stroke={INK}
            stroke-width="3"
          />
          <ellipse class="bh-mascot__inner-ear" cx="46" cy="30" rx="5" ry="18" fill={innerEar} />
        </g>
        <g
          transform={
            state === 'secret'
              ? 'rotate(30 74 52)'
              : state === 'angry'
                ? 'rotate(22 74 52)'
                : 'rotate(10 74 52)'
          }
        >
          <ellipse
            class="bh-mascot__fur"
            cx="74"
            cy="28"
            rx="11"
            ry="27"
            fill={FUR}
            stroke={INK}
            stroke-width="3"
          />
          <ellipse class="bh-mascot__inner-ear" cx="74" cy="30" rx="5" ry="18" fill={innerEar} />
        </g>
      </g>
      <ellipse
        class="bh-mascot__fur"
        cx="60"
        cy="74"
        rx="37"
        ry="32"
        fill={FUR}
        stroke={INK}
        stroke-width="3"
      />
      {(state === 'smile' || state === 'secret' || state === 'idle') && (
        <g class="bh-mascot__blush" fill={BLUSH} opacity="0.35">
          <ellipse cx="37" cy="82" rx="7" ry="4.5" />
          <ellipse cx="83" cy="82" rx="7" ry="4.5" />
        </g>
      )}
      <Eyes state={state} />
      <path class="bh-mascot__nose" d="M56 78 Q60 75 64 78 Q60 83 56 78 Z" fill={BLUSH} />
      <Mouth state={state} />
      {state === 'secret' && (
        <g class="bh-mascot__paw">
          <ellipse
            class="bh-mascot__fur"
            cx="60"
            cy="92"
            rx="12"
            ry="8"
            fill={FUR}
            stroke={INK}
            stroke-width="3"
          />
          <path
            d="M55 87 L55 91 M60 86 L60 90.5 M65 87 L65 91"
            stroke={INK}
            stroke-width="2"
            stroke-linecap="round"
          />
        </g>
      )}
      {state === 'angry' && (
        <path
          class="bh-mascot__steam"
          d="M95 40 l6 -4 M98 48 l8 -1 M92 33 l2 -7"
          stroke={colors.danger}
          stroke-width="3"
          stroke-linecap="round"
        />
      )}
    </svg>
  )
}
