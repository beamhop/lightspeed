// Policy helpers shared by the policy editor and tests. DOM-free.

import { formatDuration, formatKinds, shortNpub } from './format'
import type { Policy, RetentionRule } from './types'
import { GLOBAL_REALM } from './types'

export function realmLabel(realm: string): string {
  return realm === GLOBAL_REALM ? 'the public relay (_global)' : `app realm ${realm}`
}

/** Describe what changed between two policies, for the confirmation scope. */
export function diffPolicy(a: Policy, b: Policy): string[] {
  const out: string[] = []
  const list = (
    name: string,
    x: (string | number)[],
    y: (string | number)[],
    fmt = (v: string | number) => String(v),
  ) => {
    const add = y.filter((v) => !x.includes(v))
    const rm = x.filter((v) => !y.includes(v))
    if (add.length) out.push(`${name}: add ${add.map(fmt).join(', ')}`)
    if (rm.length) out.push(`${name}: remove ${rm.map(fmt).join(', ')}`)
  }
  const pk = (v: string | number) => shortNpub(String(v))
  list('Allowed pubkeys', a.pubkeys.allow, b.pubkeys.allow, pk)
  list('Denied pubkeys', a.pubkeys.deny, b.pubkeys.deny, pk)
  list('Allowed kinds', a.kinds.allow, b.kinds.allow)
  list('Denied kinds', a.kinds.deny, b.kinds.deny)
  list('AUTH-required kinds', a.authRequiredKinds, b.authRequiredKinds)
  const rl = (r: Policy['rateLimits']['perIp']) =>
    r.events ? `${r.events}/${r.windowSec}s` : 'unlimited'
  if (rl(a.rateLimits.perIp) !== rl(b.rateLimits.perIp))
    out.push(`Per-IP rate limit: ${rl(a.rateLimits.perIp)} → ${rl(b.rateLimits.perIp)}`)
  if (rl(a.rateLimits.perPubkey) !== rl(b.rateLimits.perPubkey))
    out.push(`Per-pubkey rate limit: ${rl(a.rateLimits.perPubkey)} → ${rl(b.rateLimits.perPubkey)}`)
  if (a.maxEventSize !== b.maxEventSize)
    out.push(`Max event size: ${a.maxEventSize} → ${b.maxEventSize} bytes`)
  if (a.minPow !== b.minPow) out.push(`NIP-13 min PoW: ${a.minPow} → ${b.minPow} bits`)
  if (JSON.stringify(a.retention) !== JSON.stringify(b.retention))
    out.push(
      `Retention rules: ${a.retention.length} → ${b.retention.length} rules (${b.retention.map(retentionLabel).join('; ') || 'keep everything'})`,
    )
  return out
}

export function retentionLabel(r: RetentionRule): string {
  const parts = []
  if (r.maxAgeSec) parts.push(`max age ${formatDuration(r.maxAgeSec)}`)
  if (r.maxCount) parts.push(`keep ${r.maxCount}/pubkey`)
  return `kinds ${formatKinds(r.kinds)}: ${parts.join(', ') || 'forever'}`
}
