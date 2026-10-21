/** @jsxImportSource preact */
import { useState } from 'preact/hooks'
import { signInWithSigner, validTotp } from '../auth'
import { Mascot } from '../components/Mascot'
import { Button, Field, Input, Tabs } from '../components/ui'
import { api, isMock } from '../ctx'
import { hasNip07, localSigner, nip07Signer, nip46Signer, type Signer } from '../nostr'
import { errorMessage, revealOnce, session } from '../store'
import type { Me } from '../types'

type Method = 'nostr' | 'bunker' | 'password' | 'bootstrap'

function origin(): string {
  return typeof location !== 'undefined' ? location.origin : ''
}

/** NIP-07 if present; in mock mode fall back to a throwaway local key so demos work without an extension. */
function browserSigner(): Signer {
  if (hasNip07()) return nip07Signer()
  if (isMock) return localSigner()
  throw new Error('No NIP-07 extension found. Install Alby or nos2x, or use a bunker URI.')
}

export function Login() {
  const [method, setMethod] = useState<Method>('nostr')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const run = async (fn: () => Promise<Me>) => {
    setBusy(true)
    setError(null)
    try {
      const me = await fn()
      session.value = me
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
      setInfo(null)
    }
  }

  return (
    <div class="min-h-dvh flex items-center justify-center px-4 py-10">
      <div class="w-full max-w-md">
        <div class="flex flex-col items-center text-center mb-6">
          <Mascot state={error ? 'angry' : busy ? 'spinner' : 'idle'} size={88} />
          <h1 class="mt-3 text-2xl font-semibold">Beamhop Relay</h1>
          <p class="text-sm text-muted">
            Admin sign-in{isMock ? ' · mock mode (any credentials work)' : ''}
          </p>
        </div>
        <p class="text-sm text-muted mb-4 text-center leading-relaxed">
          This console manages the relay: apps, the Nostr relay, TURN, media, payments and other
          admins. Choose how you sign in below; first time here, use <strong>Claim</strong>.
        </p>
        <div class="rounded-lg bg-surface border border-line p-4">
          <Tabs<Method>
            value={method}
            onChange={(m) => {
              setMethod(m)
              setError(null)
            }}
            tabs={[
              { id: 'nostr', label: 'Nostr' },
              { id: 'bunker', label: 'Bunker' },
              { id: 'password', label: 'Password' },
              { id: 'bootstrap', label: 'Claim' },
            ]}
          />
          <div class="pt-4">
            {method === 'nostr' && <NostrForm busy={busy} run={run} />}
            {method === 'bunker' && <BunkerForm busy={busy} run={run} setInfo={setInfo} />}
            {method === 'password' && <PasswordForm busy={busy} run={run} />}
            {method === 'bootstrap' && <BootstrapForm busy={busy} run={run} />}
            {info && <p class="mt-3 text-sm text-muted">{info}</p>}
            {error && (
              <p class="mt-3 text-sm text-danger" role="alert">
                {error}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

type FormProps = { busy: boolean; run: (fn: () => Promise<Me>) => Promise<void> }

function NostrForm({ busy, run }: FormProps) {
  return (
    <div class="space-y-3">
      <p class="text-sm text-muted">
        Sign a one-time challenge with your browser extension (NIP-07). Your pubkey must be on the
        admin allowlist.
      </p>
      <Button
        variant="primary"
        class="w-full"
        loading={busy}
        onClick={() => run(() => signInWithSigner(api, browserSigner(), origin()))}
      >
        Sign in with extension
      </Button>
      {!hasNip07() && !isMock && (
        <p class="text-xs text-warn">No extension detected in this browser.</p>
      )}
    </div>
  )
}

function BunkerForm({ busy, run, setInfo }: FormProps & { setInfo: (s: string | null) => void }) {
  const [uri, setUri] = useState('')
  return (
    <form
      class="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        void run(async () => {
          setInfo('Connecting to your remote signer…')
          const signer = await nip46Signer(uri, {
            onAuthUrl: (url) => {
              setInfo('Approve the request in your signer, then come back here.')
              window.open(url, '_blank', 'noopener')
            },
          })
          try {
            setInfo('Waiting for the signature…')
            return await signInWithSigner(api, signer, origin())
          } finally {
            signer.close?.()
          }
        })
      }}
    >
      <p class="text-sm text-muted">
        Sign in with a key held by a remote signer app (NIP-46), for example on your phone. Your
        private key never touches this browser.
      </p>
      <Field label="Bunker URI (NIP-46)" hint="From nsec.app, Amber or another remote signer">
        <Input
          value={uri}
          onValue={setUri}
          placeholder="bunker://<pubkey>?relay=wss://…&secret=…"
          autoComplete="off"
          required
        />
      </Field>
      <Button
        type="submit"
        variant="primary"
        class="w-full"
        loading={busy}
        disabled={!uri.startsWith('bunker://')}
      >
        Connect bunker
      </Button>
    </form>
  )
}

function PasswordForm({ busy, run }: FormProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [totp, setTotp] = useState('')
  return (
    <form
      class="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        void run(() => api.auth.password(username.trim(), password, totp.trim()))
      }}
    >
      <p class="text-sm text-muted">
        For admins invited with a username. You need your password and the current code from the
        authenticator app you enrolled (Google Authenticator, 1Password, Aegis…).
      </p>
      <Field label="Username">
        <Input
          name="username"
          value={username}
          onValue={setUsername}
          autoComplete="username"
          required
        />
      </Field>
      <Field label="Password">
        <Input
          name="password"
          type="password"
          value={password}
          onValue={setPassword}
          autoComplete="current-password"
          required
        />
      </Field>
      <Field label="Authenticator code" hint="6 digits from your TOTP app">
        <Input
          name="totp"
          inputMode="numeric"
          pattern="[0-9]{6}"
          maxLength={6}
          value={totp}
          onValue={(v) => setTotp(v.replace(/\D/g, ''))}
          autoComplete="one-time-code"
          required
        />
      </Field>
      <Button
        type="submit"
        variant="primary"
        class="w-full"
        loading={busy}
        disabled={!username || !password || !validTotp(totp)}
      >
        Sign in
      </Button>
    </form>
  )
}

function BootstrapForm({ busy, run }: FormProps) {
  const [token, setToken] = useState('')
  const [mode, setMode] = useState<'nostr' | 'password'>('nostr')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  return (
    <form
      class="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        void run(async () => {
          if (mode === 'nostr') {
            const pubkey = await browserSigner().getPublicKey()
            return api.auth.bootstrap({ token: token.trim(), pubkey })
          }
          const res = await api.auth.bootstrap({
            token: token.trim(),
            username: username.trim(),
            password,
          })
          if (res.totpUri || res.totpSecret) {
            revealOnce({
              title: 'Set up your authenticator',
              note: 'Add this to your TOTP app now. You need it for every password sign-in.',
              secrets: [
                ...(res.totpUri ? [{ label: 'otpauth URI', value: res.totpUri }] : []),
                ...(res.totpSecret ? [{ label: 'Secret', value: res.totpSecret }] : []),
              ],
            })
          }
          return res
        })
      }}
    >
      <p class="text-sm text-muted">
        First run only: paste the bootstrap token printed in the relay logs to claim the owner
        account.
      </p>
      <Field label="Bootstrap token">
        <Input value={token} onValue={setToken} autoComplete="off" required class="font-mono" />
      </Field>
      <div class="flex gap-2">
        <Button
          size="sm"
          variant={mode === 'nostr' ? 'primary' : 'secondary'}
          onClick={() => setMode('nostr')}
        >
          Owner = my Nostr key
        </Button>
        <Button
          size="sm"
          variant={mode === 'password' ? 'primary' : 'secondary'}
          onClick={() => setMode('password')}
        >
          Username + password
        </Button>
      </div>
      {mode === 'password' && (
        <>
          <Field label="Username">
            <Input value={username} onValue={setUsername} autoComplete="username" required />
          </Field>
          <Field label="Password" hint="12+ characters">
            <Input
              type="password"
              value={password}
              onValue={setPassword}
              autoComplete="new-password"
              minLength={12}
              required
            />
          </Field>
        </>
      )}
      <Button
        type="submit"
        variant="primary"
        class="w-full"
        loading={busy}
        disabled={!token || (mode === 'password' && (!username || password.length < 12))}
      >
        Claim relay
      </Button>
    </form>
  )
}
