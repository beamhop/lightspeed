---
title: OIDC authentication
description: Admit only users your backend has signed in, by binding their OIDC subject to a session key.
sidebar:
  order: 3
---

:::caution[0.x, subject to change]
:::

If your app already signs users in with an OIDC provider (Auth0, Keycloak, Google, Entra ID,
Zitadel…), you can make room membership depend on it. The browser never sends the OIDC token to
other peers; your backend issues a short **attestation certificate** that binds the user to the
peer's session key, and peers verify the certificate against your JWKS.

```
browser                         your backend                        other peers
  │ session pubkey + id token  →  verify token, sign cert (JWS)
  │ ← { jws }                                                     
  │ announce + handshake with { type: 'oidc', jws }  ──────────→  verify JWS with your JWKS,
  │                                                               check pubkey == session key
```

## 1. Publish a signing key

Generate an ES256 (or EdDSA) key pair for certificates and publish the public key as a JWKS at
`https://app.example/.well-known/jwks.json` (or reference it from your OpenID configuration's
`jwks_uri`). Use a dedicated key, not your OIDC provider's.

## 2. Issue certificates

The certificate is a compact JWS (ES256, EdDSA or RS256) with the payload
`{ v: 1, iss, sub, pubkey, iat, exp }`. `@beamhop/p2p` can sign it for you:

```ts title="backend: POST /api/beamhop-cert"
import { signAttestationCert } from '@beamhop/p2p'

const privateKey = Buffer.from(Bun.env.BEAMHOP_CERT_KEY!, 'hex')   // 32-byte P-256 or Ed25519 key

export async function issueCert(req: Request) {
  const user = await verifyOidcSession(req)              // your existing auth
  const { pubkey } = await req.json()
  if (!/^[0-9a-f]{64}$/.test(pubkey)) return new Response('bad pubkey', { status: 400 })
  const jws = signAttestationCert({
    alg: 'ES256',
    privateKey,
    kid: 'beamhop-1',
    iss: 'https://app.example',
    sub: user.id,
    pubkey,
    ttlS: 3600,
  })
  return Response.json({ jws })
}
```

`publicJwk('ES256', privateKey, 'beamhop-1')` gives the matching JWK for your JWKS. Any JOSE
library works too, for example `jose`:

```ts title="backend, with jose"
import { SignJWT, importJWK } from 'jose'

const key = await importJWK(JSON.parse(Bun.env.BEAMHOP_CERT_JWK!), 'ES256')

export async function issueCert(req: Request) {
  const user = await verifyOidcSession(req)              // your existing auth
  const { pubkey } = await req.json()
  if (!/^[0-9a-f]{64}$/.test(pubkey)) return new Response('bad pubkey', { status: 400 })
  const jws = await new SignJWT({ v: 1, pubkey })
    .setProtectedHeader({ alg: 'ES256', kid: 'beamhop-1' })
    .setIssuer('https://app.example')
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key)
  return Response.json({ jws })
}
```

## 3. Use the oidc identity in the client

```ts
import { createRoom, oidc } from '@beamhop/p2p'

const room = await createRoom({
  // …
  identity: oidc({
    getCert: async (pubkey) => {
      const res = await fetch('/api/beamhop-cert', {
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ pubkey }),
      })
      return (await res.json()).jws
    },
  }),
  policy: {
    attest: { oidc: { iss: 'https://app.example' } },   // optionally { iss, sub: ['alice', …] }
    // jwks: staticJwks({ 'https://app.example': { keys: [jwk] } }),  // skip discovery
  },
})

room.onPeerJoin((peer) => {
  const oidc = peer.verified.find((v) => v.ok && v.type === 'oidc')
  console.log(oidc?.ok && oidc.subject)   // verified subject (and oidc.issuer)
})
```

The certificate is fetched once, when the identity loads. Make its lifetime cover the session, or
create a new room with a fresh identity when it nears expiry.

## Notes

- Peers find your JWKS through OIDC discovery (`<iss>/.well-known/openid-configuration` →
  `jwks_uri`) and cache it; serve both with CORS (`Access-Control-Allow-Origin: *`), or pass
  `policy.jwks: staticJwks(...)`.
- Keep certificates short-lived. Revocation is "stop issuing": a removed user drops out when the
  cert expires (and you can rotate the signing key for immediate effect).
- Combine with a Beamhop relay realm that requires NIP-42 AUTH so unauthenticated clients cannot
  even signal on your realm.
