import { useState } from 'react'
import { useValue } from '@/lib/signals'
import { Async, useResource } from '../components/Async'
import {
  Badge,
  Button,
  Card,
  DataTable,
  Field,
  Input,
  Modal,
  Mono,
  PageHeader,
  Select,
  Tabs,
} from '../components/ui'
import { api } from '../ctx'
import { formatAgo, formatDate, parsePubkey, shortNpub } from '../format'
import { PAGE_HELP } from '../help'
import { currentQuery, navigate } from '../router'
import { performWrite, revealOnce, session } from '../store'
import type { Admin, AdminRole } from '../types'

type Tab = 'admins' | 'sessions' | 'audit'

export function adminName(a: Pick<Admin, 'pubkey' | 'username' | 'id'>): string {
  return a.username ?? (a.pubkey ? shortNpub(a.pubkey) : a.id)
}

export function Admins() {
  const tab = (useValue(currentQuery).get('tab') as Tab) || 'admins'
  return (
    <>
      <PageHeader
        title="Admins"
        subtitle="Who can run this relay, their sessions and every action they took"
        intro={PAGE_HELP.admins}
      />
      <Tabs<Tab>
        value={tab}
        onChange={(t) => navigate(`/admins?tab=${t}`, { replace: true })}
        tabs={[
          {
            id: 'admins',
            label: 'Admins',
            description:
              'Everyone who can sign in here. Owners can also add and remove admins; admins manage everything else.',
          },
          {
            id: 'sessions',
            label: 'Sessions',
            description:
              'Browsers and devices that are signed in right now. Revoke any you do not recognise, or a device that was lost.',
          },
          {
            id: 'audit',
            label: 'Audit log',
            description:
              'An append-only record of every change made through the admin UI or API: what was done, to what, by whom and when. It cannot be edited from here.',
          },
        ]}
      />
      <div className="flex flex-col gap-6">
        {tab === 'admins' && <AdminList />}
        {tab === 'sessions' && <Sessions />}
        {tab === 'audit' && <Audit />}
      </div>
    </>
  )
}

function AdminList() {
  const res = useResource(() => api.admins.list(), [])
  const [open, setOpen] = useState(false)
  const me = useValue(session)

  const remove = async (a: Admin) => {
    const r = await performWrite({
      title: 'Remove admin',
      action: 'Remove admin',
      danger: true,
      scope: [
        `${adminName(a)} (${a.role})`,
        'All of their sessions are revoked immediately',
        'Their past actions stay in the audit log',
      ],
      run: () => api.admins.remove(a.id),
      success: `Removed ${adminName(a)}`,
    })
    if (r.ok) res.mutate((l) => l.filter((x) => x.id !== a.id))
  }
  const resetTotp = async (a: Admin) => {
    const r = await performWrite({
      title: 'Reset TOTP',
      action: 'Reset TOTP',
      danger: true,
      scope: [
        `${adminName(a)}`,
        'Their authenticator stops working; a new secret is issued',
        'Password sign-in requires enrolling the new secret',
      ],
      run: () => api.admins.resetTotp(a.id),
      success: 'TOTP reset',
    })
    if (r.ok) {
      if (r.value?.totpUri)
        revealOnce({
          title: `New TOTP for ${adminName(a)}`,
          secrets: [{ label: 'otpauth URI', value: r.value.totpUri }],
          note: 'Hand this to the admin over a secure channel. It is shown once.',
        })
      res.mutate((l) => l.map((x) => (x.id === a.id ? { ...x, totpEnabled: false } : x)))
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card
        title="Admins"
        actions={
          <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
            Invite admin
          </Button>
        }
      >
        <Async res={res}>
          {(list) => (
            <DataTable
              rows={list}
              rowKey={(a) => a.id}
              columns={[
                {
                  key: 'who',
                  label: 'Admin',
                  render: (a) => (
                    <span className="inline-flex items-center gap-1.5">
                      <Mono>{adminName(a)}</Mono>
                      {me?.id === a.id && <Badge tone="teal">you</Badge>}
                    </span>
                  ),
                },
                {
                  key: 'role',
                  label: 'Role',
                  help: 'owner: full control including managing admins. admin: everything except adding or removing admins.',
                  render: (a) => (
                    <Badge tone={a.role === 'owner' ? 'violet' : 'muted'}>{a.role}</Badge>
                  ),
                },
                {
                  key: 'method',
                  label: 'Sign-in',
                  help: 'Nostr admins sign a challenge with their key (no password stored here). Password admins also need a 6-digit authenticator code.',
                  render: (a) => (a.pubkey ? 'Nostr' : `Password${a.totpEnabled ? ' + TOTP' : ''}`),
                },
                {
                  key: 'last',
                  label: 'Last login',
                  render: (a) => (a.lastLoginAt ? formatAgo(a.lastLoginAt) : 'never'),
                },
              ]}
              actions={(a) => (
                <>
                  {a.username && (
                    <Button size="sm" onClick={() => resetTotp(a)}>
                      Reset TOTP
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => remove(a)}
                    disabled={me?.id === a.id}
                  >
                    Remove
                  </Button>
                </>
              )}
            />
          )}
        </Async>
      </Card>
      <Card
        title="Bootstrap and recovery"
        description="How the first owner is created and how to get back in if every admin loses access."
      >
        <ul className="text-sm text-muted-foreground space-y-1.5 list-disc pl-5">
          <li>
            The bootstrap token is printed once on first start and is void after the first admin
            claims it.
          </li>
          <li>
            Lost every admin key? Stop the relay and run{' '}
            <Mono>beamhop relay admin reset --bootstrap</Mono> to print a fresh token.
          </li>
          <li>Owners can invite and remove admins; at least one owner must remain.</li>
        </ul>
      </Card>
      <InviteModal open={open} onClose={() => setOpen(false)} onDone={() => void res.reload()} />
    </div>
  )
}

function InviteModal({
  open,
  onClose,
  onDone,
}: {
  open: boolean
  onClose: () => void
  onDone: () => void
}) {
  const [mode, setMode] = useState<'nostr' | 'password'>('nostr')
  const [pubkey, setPubkey] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<AdminRole>('admin')
  let pkErr: string | null = null
  let pkHex = ''
  if (mode === 'nostr' && pubkey) {
    try {
      pkHex = parsePubkey(pubkey)
    } catch (e) {
      pkErr = (e as Error).message
    }
  }
  const valid = mode === 'nostr' ? !!pkHex : username.trim().length >= 2 && password.length >= 12
  const submit = async () => {
    onClose()
    const who = mode === 'nostr' ? shortNpub(pkHex) : username.trim()
    const r = await performWrite({
      title: 'Invite admin',
      action: 'Invite',
      scope: [
        `${who} as ${role}`,
        role === 'owner'
          ? 'Owners can manage other admins and every setting'
          : 'Admins can manage apps, policies, TURN, media and payments',
        mode === 'password'
          ? 'They must enroll TOTP (secret shown once)'
          : 'They sign in with NIP-07 or NIP-46',
      ],
      run: () =>
        api.admins.add(
          mode === 'nostr'
            ? { pubkey: pkHex, role }
            : { username: username.trim(), password, role },
        ),
      success: `Invited ${who}`,
    })
    if (r.ok) {
      if (r.value.totpUri)
        revealOnce({
          title: `TOTP for ${who}`,
          secrets: [{ label: 'otpauth URI', value: r.value.totpUri }],
        })
      setPubkey('')
      setUsername('')
      setPassword('')
      onDone()
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Invite admin"
      description="Gives someone access to this admin UI. Prefer a Nostr pubkey: they sign in with their own key and no shared password exists."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} onClick={submit}>
            Continue
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={mode === 'nostr' ? 'primary' : 'secondary'}
            onClick={() => setMode('nostr')}
          >
            Nostr pubkey
          </Button>
          <Button
            size="sm"
            variant={mode === 'password' ? 'primary' : 'secondary'}
            onClick={() => setMode('password')}
          >
            Password + TOTP
          </Button>
        </div>
        {mode === 'nostr' ? (
          <Field
            label="Pubkey"
            error={pkErr}
            hint="They sign in with a browser extension (NIP-07) or a remote signer (NIP-46)."
          >
            <Input value={pubkey} onValue={setPubkey} placeholder="npub1… or hex" />
          </Field>
        ) : (
          <>
            <Field label="Username" hint="At least 2 characters.">
              <Input value={username} onValue={setUsername} autoComplete="off" />
            </Field>
            <Field label="Temporary password" hint="12+ characters; share it securely">
              <Input
                type="password"
                value={password}
                onValue={setPassword}
                autoComplete="new-password"
              />
            </Field>
          </>
        )}
        <Field
          label="Role"
          help="Admin can manage apps, policies, TURN, media and payments. Owner can additionally invite and remove admins. Give owner to as few people as possible."
        >
          <Select<AdminRole>
            value={role}
            onValue={setRole}
            options={[
              { value: 'admin', label: 'Admin' },
              { value: 'owner', label: 'Owner' },
            ]}
          />
        </Field>
      </div>
    </Modal>
  )
}

function Sessions() {
  const res = useResource(() => api.admins.sessions(), [])
  const admins = useResource(() => api.admins.list(), [])
  const nameOf = (id: string) => {
    const a = admins.data?.find((x) => x.id === id)
    return a ? adminName(a) : id
  }
  return (
    <Card title="Sessions">
      <Async res={res} emptyTitle="No active sessions">
        {(list) => (
          <DataTable
            rows={list}
            rowKey={(s) => s.id}
            columns={[
              {
                key: 'admin',
                label: 'Admin',
                render: (s) => (
                  <span className="inline-flex items-center gap-1.5">
                    <Mono>{nameOf(s.adminId)}</Mono>
                    {s.current && <Badge tone="teal">this device</Badge>}
                  </span>
                ),
              },
              {
                key: 'label',
                label: 'Device',
                help: 'Browser and operating system reported when the session started.',
                render: (s) => s.label,
              },
              {
                key: 'ip',
                label: 'IP',
                help: 'Address the session was last used from. An unfamiliar location is a reason to revoke.',
                render: (s) => <Mono>{s.ip}</Mono>,
              },
              {
                key: 'seen',
                label: 'Last seen',
                render: (s) => formatAgo(s.lastSeenAt),
              },
              {
                key: 'created',
                label: 'Started',
                render: (s) => formatDate(s.createdAt),
                hideOnMobile: true,
              },
            ]}
            actions={(s) => (
              <Button
                size="sm"
                variant="danger"
                onClick={async () => {
                  const r = await performWrite({
                    title: 'Revoke session',
                    action: 'Revoke',
                    danger: true,
                    scope: [
                      `${nameOf(s.adminId)} on ${s.label} (${s.ip})`,
                      s.current
                        ? 'This is your current session: you will be signed out'
                        : 'That device is signed out on its next request',
                    ],
                    run: () => api.admins.revokeSession(s.id),
                    success: 'Session revoked',
                  })
                  if (r.ok) {
                    if (s.current) session.value = null
                    else res.mutate((l) => l.filter((x) => x.id !== s.id))
                  }
                }}
              >
                Revoke
              </Button>
            )}
          />
        )}
      </Async>
    </Card>
  )
}

function Audit() {
  const [actor, setActor] = useState('')
  const [applied, setApplied] = useState('')
  const [limit, setLimit] = useState(50)
  const res = useResource(
    () => api.admins.audit({ limit, actor: applied || undefined }),
    [limit, applied],
  )
  return (
    <Card
      title="Audit log"
      actions={
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            setApplied(actor.trim())
          }}
        >
          <Input
            value={actor}
            onValue={setActor}
            placeholder="Filter by actor"
            className="h-8 w-44"
            type="search"
          />
        </form>
      }
    >
      <Async res={res} emptyTitle="No audit entries">
        {(list) => {
          const rows = applied ? list.filter((e) => e.actor.includes(applied)) : list
          return (
            <>
              <ol className="divide-y divide-border/60">
                {rows.map((e) => (
                  <li
                    key={e.id}
                    className="py-2 flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3 text-sm"
                  >
                    <span className="text-xs text-muted-foreground w-36 shrink-0">
                      {formatDate(e.ts)}
                    </span>
                    <Badge tone="violet">{e.action}</Badge>
                    <Mono className="text-muted-foreground truncate">{e.scope}</Mono>
                    <span className="sm:ml-auto text-xs font-mono truncate">
                      {/^[0-9a-f]{64}$/.test(e.actor) ? shortNpub(e.actor) : e.actor}
                    </span>
                  </li>
                ))}
              </ol>
              {list.length >= limit && (
                <div className="flex justify-center pt-3">
                  <Button onClick={() => setLimit(limit + 50)}>Load more</Button>
                </div>
              )}
            </>
          )
        }}
      </Async>
    </Card>
  )
}
