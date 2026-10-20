// The Beamhop bunny. States follow @beamhop/ui's MascotState: idle, spinner, smile, angry, secret.
export type MascotState = 'idle' | 'spinner' | 'smile' | 'angry' | 'secret'

export function Bunny({ state = 'idle', size = 64 }: { state?: MascotState; size?: number }) {
  const mouth =
    state === 'smile'
      ? 'M27 44 Q32 49 37 44'
      : state === 'angry'
        ? 'M27 47 Q32 42 37 47'
        : 'M29 45 Q32 47 35 45'
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label={`Beamhop bunny (${state})`}
      class={state === 'spinner' ? 'bunny bunny-spin' : 'bunny'}
    >
      <ellipse cx="22" cy="16" rx="6" ry="15" fill="#5EEAD4" transform="rotate(-12 22 16)" />
      <ellipse cx="42" cy="16" rx="6" ry="15" fill="#5EEAD4" transform="rotate(12 42 16)" />
      <ellipse cx="22" cy="17" rx="2.6" ry="10" fill="#8B7BFF" transform="rotate(-12 22 17)" />
      <ellipse cx="42" cy="17" rx="2.6" ry="10" fill="#8B7BFF" transform="rotate(12 42 17)" />
      <circle cx="32" cy="38" r="20" fill="#5EEAD4" />
      {state === 'secret' ? (
        <rect x="18" y="30" width="28" height="7" rx="3.5" fill="#0B0E1A" />
      ) : (
        <>
          <circle cx="25" cy="35" r="3" fill="#0B0E1A" />
          <circle cx="39" cy="35" r="3" fill="#0B0E1A" />
          {state === 'angry' && (
            <path d="M21 29 L28 32 M43 29 L36 32" stroke="#0B0E1A" stroke-width="2" />
          )}
        </>
      )}
      <ellipse cx="32" cy="41" rx="2.6" ry="2" fill="#8B7BFF" />
      <path d={mouth} stroke="#0B0E1A" stroke-width="2" fill="none" stroke-linecap="round" />
    </svg>
  )
}
