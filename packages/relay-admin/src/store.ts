// App-wide state: session, confirmation flow, toasts and reveal-once secrets. DOM-free so it tests in Bun.

import { signal } from '@preact/signals'
import { ApiError } from './api'
import type { Me } from './types'

// ---- session ----
/** undefined = still loading, null = signed out. */
export const session = signal<Me | null | undefined>(undefined)

// ---- confirmation ----
export interface ConfirmRequest {
  title: string
  /** Button label, e.g. "Delete event". */
  action: string
  /** Human-readable lines spelling out exactly what is affected. Required: no blind writes. */
  scope: string[]
  /** Danger styling + red button. */
  danger?: boolean
  /** When set, the user must type this text before the action button enables. */
  typeToConfirm?: string
  /** Extra note shown under the scope (e.g. "This is audited as <pubkey>"). */
  note?: string
}

interface PendingConfirm extends ConfirmRequest {
  id: number
  resolve: (ok: boolean) => void
}

export const pendingConfirm = signal<PendingConfirm | null>(null)
let dialogSeq = 0

export function confirm(req: ConfirmRequest): Promise<boolean> {
  if (!req.scope.length) throw new Error('confirm(): scope must spell out what is affected')
  // A new request supersedes (and cancels) any open one.
  pendingConfirm.value?.resolve(false)
  return new Promise<boolean>((resolve) => {
    const entry: PendingConfirm = {
      ...req,
      id: ++dialogSeq,
      resolve: (ok) => {
        if (pendingConfirm.value === entry) pendingConfirm.value = null
        resolve(ok)
      },
    }
    pendingConfirm.value = entry
  })
}

export function resolveConfirm(ok: boolean): void {
  pendingConfirm.value?.resolve(ok)
}

/** Text a typed-confirmation input must match (case-sensitive, trimmed). */
export function confirmTextMatches(
  req: Pick<ConfirmRequest, 'typeToConfirm'>,
  typed: string,
): boolean {
  return !req.typeToConfirm || typed.trim() === req.typeToConfirm
}

// ---- toasts ----
export interface Toast {
  id: number
  kind: 'success' | 'error' | 'info'
  message: string
}
export const toasts = signal<Toast[]>([])
let toastSeq = 0

export function toast(kind: Toast['kind'], message: string, ttlMs = 4000): number {
  const id = ++toastSeq
  toasts.value = [...toasts.value.slice(-4), { id, kind, message }]
  if (ttlMs > 0) setTimeout(() => dismissToast(id), ttlMs)
  return id
}

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id)
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.status ? `${e.message} (${e.code})` : e.message
  if (e instanceof Error) return e.message
  return String(e)
}

// ---- reveal-once secrets ----
export interface RevealSecret {
  label: string
  value: string
}
export interface RevealRequest {
  title: string
  secrets: RevealSecret[]
  note?: string
}
export const pendingReveal = signal<(RevealRequest & { id: number }) | null>(null)

export function revealOnce(req: RevealRequest): void {
  pendingReveal.value = { ...req, id: ++dialogSeq }
}

export function closeReveal(): void {
  // Drop the values from memory as soon as the modal closes.
  pendingReveal.value = null
}

// ---- write flow ----
export interface WriteOptions<T> extends ConfirmRequest {
  run: () => Promise<T>
  success?: string | ((r: T) => string)
}

/**
 * Every mutating action goes through here: confirm with scope -> run -> toast.
 * Resolves to { ok: true, value } on success, { ok: false } when cancelled or failed.
 */
export type WriteResult<T> = { ok: true; value: T } | { ok: false; cancelled: boolean }

export async function performWrite<T>(opts: WriteOptions<T>): Promise<WriteResult<T>> {
  const { run, success, ...req } = opts
  const ok = await confirm(req)
  if (!ok) return { ok: false, cancelled: true }
  try {
    const r = await run()
    const msg = typeof success === 'function' ? success(r) : (success ?? `${req.action}: done`)
    toast('success', msg)
    return { ok: true, value: r }
  } catch (e) {
    toast('error', `${req.action} failed: ${errorMessage(e)}`, 7000)
    return { ok: false, cancelled: false }
  }
}
