// Sign-in flows (UI-agnostic so they can be unit-tested against the mock API).

import type { AdminApi } from './api'
import { authEventTemplate, type Signer } from './nostr'
import type { Me } from './types'

/** challenge -> kind 27235 signed by the signer -> POST /auth/nostr */
export async function signInWithSigner(api: AdminApi, signer: Signer, origin: string): Promise<Me> {
  const { challenge } = await api.auth.challenge()
  const event = await signer.signEvent(
    authEventTemplate(challenge, `${origin}/api/admin/auth/nostr`),
  )
  return api.auth.nostr(event)
}

export function validTotp(code: string): boolean {
  return /^\d{6}$/.test(code.trim())
}
