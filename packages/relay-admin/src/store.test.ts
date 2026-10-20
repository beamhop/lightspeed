import { describe, expect, test } from 'bun:test'
import { ApiError } from './api'
import {
  closeReveal,
  confirm,
  confirmTextMatches,
  dismissToast,
  errorMessage,
  pendingConfirm,
  pendingReveal,
  performWrite,
  resolveConfirm,
  revealOnce,
  toast,
  toasts,
} from './store'

describe('confirmation flow', () => {
  test('confirm resolves with the user decision and clears state', async () => {
    const p = confirm({ title: 'Kill', action: 'Kill', scope: ['allocation a1'] })
    expect(pendingConfirm.value?.scope).toEqual(['allocation a1'])
    resolveConfirm(true)
    expect(await p).toBe(true)
    expect(pendingConfirm.value).toBeNull()
  })

  test('scope is mandatory', () => {
    expect(() => confirm({ title: 'x', action: 'x', scope: [] })).toThrow(/scope/)
  })

  test('a new request cancels the previous one', async () => {
    const a = confirm({ title: 'A', action: 'A', scope: ['a'] })
    const b = confirm({ title: 'B', action: 'B', scope: ['b'] })
    expect(await a).toBe(false)
    expect(pendingConfirm.value?.title).toBe('B')
    resolveConfirm(false)
    expect(await b).toBe(false)
  })

  test('typed confirmation must match exactly', () => {
    expect(confirmTextMatches({ typeToConfirm: 'My App' }, 'My App ')).toBe(true)
    expect(confirmTextMatches({ typeToConfirm: 'My App' }, 'my app')).toBe(false)
    expect(confirmTextMatches({}, '')).toBe(true)
  })

  test('performWrite does not run when cancelled', async () => {
    let ran = false
    const p = performWrite({
      title: 't',
      action: 'Delete',
      scope: ['s'],
      run: async () => (ran = true),
    })
    resolveConfirm(false)
    expect(await p).toEqual({ ok: false, cancelled: true })
    expect(ran).toBe(false)
  })

  test('performWrite runs after confirmation and toasts', async () => {
    toasts.value = []
    const p = performWrite({
      title: 't',
      action: 'Rotate',
      scope: ['app x'],
      run: async () => 'new-secret',
      success: (v) => `got ${v}`,
    })
    expect(pendingConfirm.value?.action).toBe('Rotate')
    resolveConfirm(true)
    expect(await p).toEqual({ ok: true, value: 'new-secret' })
    expect(toasts.value.at(-1)).toMatchObject({ kind: 'success', message: 'got new-secret' })
  })

  test('performWrite reports failures', async () => {
    toasts.value = []
    const p = performWrite({
      title: 't',
      action: 'Ban IP',
      scope: ['1.2.3.4'],
      run: async () => {
        throw new ApiError(409, 'exists', 'Already banned')
      },
    })
    resolveConfirm(true)
    expect(await p).toEqual({ ok: false, cancelled: false })
    expect(toasts.value.at(-1)?.kind).toBe('error')
    expect(toasts.value.at(-1)?.message).toContain('Already banned (exists)')
  })
})

describe('toasts and reveal', () => {
  test('toast list is capped and dismissable', () => {
    toasts.value = []
    for (let i = 0; i < 8; i++) toast('info', `m${i}`, 0)
    expect(toasts.value).toHaveLength(5)
    dismissToast(toasts.value[0]?.id as number)
    expect(toasts.value).toHaveLength(4)
  })

  test('reveal-once holds secrets until closed', () => {
    revealOnce({ title: 'Secret', secrets: [{ label: 'API key', value: 'bh_x' }] })
    expect(pendingReveal.value?.secrets[0]?.value).toBe('bh_x')
    closeReveal()
    expect(pendingReveal.value).toBeNull()
  })

  test('errorMessage', () => {
    expect(errorMessage(new ApiError(0, 'network', 'offline'))).toBe('offline')
    expect(errorMessage(new Error('x'))).toBe('x')
    expect(errorMessage('y')).toBe('y')
  })
})
