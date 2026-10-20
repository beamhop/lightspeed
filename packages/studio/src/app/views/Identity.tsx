/** @jsxImportSource preact */
import { Badge, Button, Card, Input, Mascot, toast } from '@beamhop/ui'
import { useState } from 'preact/hooks'
import { anonymousIdentity, nostrIdentity, oidcIdentity } from '../../identity'
import type { AdmissionResult, StudioIdentity } from '../../room-adapter'
import { identity, refresh, room } from '../store'

interface Nip07 {
  getPublicKey(): Promise<string>
}

export function IdentityView() {
  const r = room.value
  const [nostrInput, setNostrInput] = useState('')
  const [jws, setJws] = useState('')
  const [result, setResult] = useState<AdmissionResult | null>(null)
  const current = identity.value
  const nip07 = (globalThis as { nostr?: Nip07 }).nostr

  const apply = async (make: () => StudioIdentity | Promise<StudioIdentity>) => {
    try {
      const id = await make()
      identity.value = id
      if (!r) return
      const res = await r.setIdentity(id)
      setResult(res)
      refresh()
      toast(res.admitted ? `Admitted as ${id.label}` : `Rejected: ${res.reason ?? 'policy'}`, {
        tone: res.admitted ? 'success' : 'danger',
      })
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { tone: 'danger' })
    }
  }

  return (
    <div class="identity">
      <Card title="Current identity">
        <div class="identity__current">
          <Mascot state={result ? (result.admitted ? 'smile' : 'angry') : 'secret'} size={64} />
          {current ? (
            <div class="kv">
              <span>Kind</span>
              <span>
                <Badge
                  tone={
                    current.kind === 'anonymous'
                      ? 'neutral'
                      : current.kind === 'nostr'
                        ? 'violet'
                        : 'teal'
                  }
                >
                  {current.kind}
                </Badge>
              </span>
              <span>Label</span>
              <span>{current.label}</span>
              <span>Session key</span>
              <span class="bh-mono small">{current.pubkey}</span>
              <span>Admission</span>
              <span>
                {result ? (
                  <Badge tone={result.admitted ? 'success' : 'danger'} dot>
                    {result.admitted ? 'admitted' : `rejected — ${result.reason ?? ''}`}
                  </Badge>
                ) : (
                  'not tried'
                )}
              </span>
            </div>
          ) : (
            <p class="bh-muted">
              Studio observes without an identity until you pick one. Swap identities to test the
              room's admission policy.
            </p>
          )}
        </div>
        {r && !r.capabilities.identity && (
          <p class="bh-muted small">This attach mode does not support identity switching.</p>
        )}
      </Card>
      <div class="identity__grid">
        <Card title="Anonymous">
          <p class="bh-muted small">A fresh random session key with no attestation.</p>
          <Button variant="primary" onClick={() => void apply(() => anonymousIdentity().identity)}>
            Use anonymous
          </Button>
        </Card>
        <Card title="Nostr">
          <Input
            label="nsec / secret hex, or npub / pubkey hex"
            type="password"
            mono
            autoComplete="off"
            value={nostrInput}
            onValue={setNostrInput}
            hint="A secret key signs the session attestation locally and is never stored. A pubkey alone gives an unsigned attestation."
          />
          <div class="form-row">
            <Button
              variant="primary"
              disabled={!nostrInput.trim()}
              onClick={() =>
                void apply(() => {
                  const v = nostrInput.trim()
                  const isPub = v.startsWith('npub')
                  return nostrIdentity(isPub ? { pubkey: v } : { secretKey: v }).identity
                })
              }
            >
              Use key
            </Button>
            {nip07 && (
              <Button
                onClick={() =>
                  void apply(
                    async () => nostrIdentity({ pubkey: await nip07.getPublicKey() }).identity,
                  )
                }
              >
                From extension (NIP-07)
              </Button>
            )}
          </div>
        </Card>
        <Card title="OIDC">
          <Input
            label="Attestation JWS"
            mono
            value={jws}
            onValue={setJws}
            hint="{ v: 1, iss, sub, pubkey, iat, exp } signed by your app backend"
          />
          <Button
            variant="primary"
            disabled={!jws.trim()}
            onClick={() => void apply(() => oidcIdentity(jws))}
          >
            Use OIDC attestation
          </Button>
        </Card>
      </div>
    </div>
  )
}
