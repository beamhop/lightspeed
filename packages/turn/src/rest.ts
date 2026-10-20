// TURN REST ephemeral credentials (draft-uberti-behave-turn-rest), compatible with
// `turnUsername`/`turnPassword` in @beamhop/p2p/wire:
//   username = <expiry unix seconds>:<appId>:<pubkey>
//   password = base64(HMAC-SHA1(secret, username))
import { createHmac } from 'node:crypto'

export interface RestCredentialOptions {
  /** Shared secret, or a lookup by appId (return null for unknown apps). */
  secret: string | ((appId: string) => string | null | undefined)
  /** Clock skew tolerance in seconds. Default 0. */
  leeway?: number
  now?: () => number
}

/** Build a `credentials()` callback for createTurnServer that validates TURN REST usernames. */
export function restCredentials(
  opts: RestCredentialOptions,
): (username: string) => { password: string } | null {
  return (username) => {
    const m = /^(\d+):([^:]+):(.+)$/.exec(username) ?? /^(\d+)(?::(.*))?$/.exec(username)
    if (!m) return null
    const expiry = Number(m[1])
    const now = (opts.now ?? Date.now)() / 1000
    if (!Number.isFinite(expiry) || expiry + (opts.leeway ?? 0) < now) return null
    const appId = m[2] ?? ''
    const secret = typeof opts.secret === 'string' ? opts.secret : opts.secret(appId)
    if (!secret) return null
    return { password: createHmac('sha1', secret).update(username).digest('base64') }
  }
}
