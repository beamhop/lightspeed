/** @jsxImportSource preact */
import { useState } from 'preact/hooks'
import { shortNpub } from '../format'
import {
  closeReveal,
  confirmTextMatches,
  dismissToast,
  pendingConfirm,
  pendingReveal,
  resolveConfirm,
  session,
  toasts,
} from '../store'
import { Mascot } from './Mascot'
import { Button, CopyButton, Input, Modal } from './ui'

export function ConfirmDialog() {
  const req = pendingConfirm.value
  return req ? <ConfirmBody key={req.id} req={req} /> : null
}

function ConfirmBody({ req }: { req: NonNullable<typeof pendingConfirm.value> }) {
  const [typed, setTyped] = useState('')
  const me = session.value
  const actor = me?.pubkey ? shortNpub(me.pubkey) : (me?.username ?? 'you')
  const canGo = confirmTextMatches(req, typed)
  return (
    <Modal
      open
      title={req.title}
      tone={req.danger ? 'danger' : undefined}
      onClose={() => resolveConfirm(false)}
      footer={
        <>
          <Button onClick={() => resolveConfirm(false)} data-confirm="cancel">
            Cancel
          </Button>
          <Button
            variant={req.danger ? 'danger' : 'primary'}
            disabled={!canGo}
            onClick={() => resolveConfirm(true)}
            data-confirm="ok"
          >
            {req.action}
          </Button>
        </>
      }
    >
      <div class="text-xs uppercase tracking-wide text-muted mb-1.5">Affected scope</div>
      <ul
        class="rounded-md bg-midnight border border-line p-3 space-y-1 mb-3"
        data-confirm-scope=""
      >
        {req.scope.map((s) => (
          <li key={s} class="flex gap-2 text-sm break-all">
            <span class={req.danger ? 'text-danger' : 'text-teal'}>•</span>
            <span>{s}</span>
          </li>
        ))}
      </ul>
      {req.note && <p class="text-sm text-muted mb-3">{req.note}</p>}
      {req.typeToConfirm && (
        <label class="block mb-3">
          <span class="block text-xs text-muted mb-1">
            Type <code class="font-mono text-ink">{req.typeToConfirm}</code> to confirm
          </span>
          <Input
            value={typed}
            onValue={setTyped}
            autoComplete="off"
            aria-label="Confirmation text"
          />
        </label>
      )}
      <p class="text-[11px] text-muted">This action is recorded in the audit log as {actor}.</p>
    </Modal>
  )
}

export function RevealOnceModal() {
  const req = pendingReveal.value
  return req ? <RevealBody key={req.id} req={req} /> : null
}

function RevealBody({ req }: { req: NonNullable<typeof pendingReveal.value> }) {
  const [ack, setAck] = useState(false)
  return (
    <Modal
      open
      tone="secret"
      title={req.title}
      onClose={() => {
        if (ack) closeReveal()
      }}
      footer={
        <Button variant="primary" disabled={!ack} onClick={closeReveal} data-reveal="done">
          I saved it, close
        </Button>
      }
    >
      <div class="flex gap-3 items-start mb-3">
        <Mascot state="secret" size={56} />
        <p class="text-sm text-muted">
          {req.note ??
            'This value is shown once. Store it somewhere safe now; you will not be able to see it again.'}
        </p>
      </div>
      <div class="space-y-3">
        {req.secrets.map((s) => (
          <div key={s.label}>
            <div class="flex items-center justify-between">
              <span class="text-xs text-muted">{s.label}</span>
              <CopyButton value={s.value} />
            </div>
            <code
              class="block mt-1 rounded-md bg-midnight border border-violet/40 p-2.5 font-mono text-xs text-ink break-all select-all"
              data-secret={s.label}
            >
              {s.value}
            </code>
          </div>
        ))}
      </div>
      <label class="flex items-center gap-2 mt-4 text-sm">
        <input
          type="checkbox"
          checked={ack}
          onChange={(e) => setAck((e.currentTarget as HTMLInputElement).checked)}
          class="accent-teal size-4"
        />
        I have copied this somewhere safe
      </label>
    </Modal>
  )
}

export function Toasts() {
  const list = toasts.value
  return (
    <div
      class="fixed z-[60] left-0 right-0 bottom-20 md:bottom-4 md:left-auto md:right-4 flex flex-col items-center md:items-end gap-2 px-3 pointer-events-none"
      aria-live="polite"
    >
      {list.map((t) => (
        <button
          type="button"
          key={t.id}
          onClick={() => dismissToast(t.id)}
          class={`pointer-events-auto max-w-sm w-full md:w-auto text-left rounded-md px-3 py-2 text-sm shadow-lg border bg-surface ${
            t.kind === 'error'
              ? 'border-danger/50 text-danger'
              : t.kind === 'success'
                ? 'border-teal/50 text-ink'
                : 'border-line text-ink'
          }`}
        >
          {t.message}
        </button>
      ))}
    </div>
  )
}
