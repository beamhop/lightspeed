import { CircleAlert, CircleCheck, Info } from 'lucide-react'
import { useId, useState } from 'react'
import { useValue } from '@/lib/signals'
import { cn } from '@/lib/utils'
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
import { Button, CopyButton, Field, Input, Modal } from './ui'
import { Checkbox } from './ui/checkbox'
import { Label } from './ui/label'

export function ConfirmDialog() {
  const req = useValue(pendingConfirm)
  return req ? <ConfirmBody key={req.id} req={req} /> : null
}

function ConfirmBody({ req }: { req: NonNullable<typeof pendingConfirm.value> }) {
  const [typed, setTyped] = useState('')
  const me = useValue(session)
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
      <div className="space-y-4">
        <div className="space-y-2">
          <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Affected scope
          </div>
          <ul className="space-y-1 rounded-md border bg-muted/40 p-3" data-confirm-scope="">
            {req.scope.map((s) => (
              <li key={s} className="flex gap-2 break-all">
                <span className={req.danger ? 'text-destructive' : 'text-primary'}>•</span>
                <span>{s}</span>
              </li>
            ))}
          </ul>
        </div>
        {req.note && <p className="text-muted-foreground">{req.note}</p>}
        {req.typeToConfirm && (
          <Field label={`Type “${req.typeToConfirm}” to confirm`}>
            <Input
              value={typed}
              onValue={setTyped}
              autoComplete="off"
              aria-label="Confirmation text"
            />
          </Field>
        )}
        <p className="text-xs text-muted-foreground">
          This action is recorded in the audit log as {actor}.
        </p>
      </div>
    </Modal>
  )
}

export function RevealOnceModal() {
  const req = useValue(pendingReveal)
  return req ? <RevealBody key={req.id} req={req} /> : null
}

function RevealBody({ req }: { req: NonNullable<typeof pendingReveal.value> }) {
  const [ack, setAck] = useState(false)
  const ackId = useId()
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
      <div className="space-y-4">
        <div className="flex items-start gap-3">
          <Mascot state="secret" size={56} />
          <p className="text-muted-foreground">
            {req.note ??
              'This value is shown once. Store it somewhere safe now; you will not be able to see it again.'}
          </p>
        </div>
        {req.secrets.map((s) => (
          <div key={s.label} className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">{s.label}</span>
              <CopyButton value={s.value} />
            </div>
            <code
              className="block rounded-md border border-violet/40 bg-muted/40 p-2.5 font-mono text-xs break-all select-all"
              data-secret={s.label}
            >
              {s.value}
            </code>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <Checkbox id={ackId} checked={ack} onCheckedChange={(v) => setAck(v === true)} />
          <Label htmlFor={ackId} className="font-normal">
            I have copied this somewhere safe
          </Label>
        </div>
      </div>
    </Modal>
  )
}

const TOAST_ICON = { success: CircleCheck, error: CircleAlert, info: Info }

export function Toasts() {
  const list = useValue(toasts)
  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-16 z-[60] flex flex-col items-center gap-2 px-4 md:top-auto md:right-4 md:bottom-4 md:left-auto md:items-end md:px-0"
      aria-live="polite"
    >
      {list.map((t) => {
        const I = TOAST_ICON[t.kind]
        return (
          <button
            type="button"
            key={t.id}
            onClick={() => dismissToast(t.id)}
            className={cn(
              'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border bg-popover px-4 py-3 text-left text-sm text-popover-foreground shadow-lg md:w-[356px]',
              t.kind === 'error' && 'border-destructive/50 text-destructive',
            )}
          >
            <I
              className={cn(
                'mt-0.5 size-4 shrink-0',
                t.kind === 'success' && 'text-primary',
                t.kind === 'info' && 'text-muted-foreground',
              )}
            />
            <span className="min-w-0 break-words">{t.message}</span>
          </button>
        )
      })}
    </div>
  )
}
