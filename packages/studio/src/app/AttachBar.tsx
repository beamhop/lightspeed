/** @jsxImportSource preact */
import { Button, Dialog, Input, Select, Toggle } from '@beamhop/ui'
import { useState } from 'preact/hooks'
import { ObserverRoom } from '../adapters/observer'
import type { AttachMode } from '../room-adapter'
import { type AttachSettings, attach, settings } from './store'

const MODES = [
  { value: 'simulated', label: 'Simulated room' },
  { value: 'bridge', label: 'In-page bridge' },
  { value: 'observer', label: `Observer peer${ObserverRoom.available ? '' : ' (soon)'}` },
]

export function AttachBar() {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<AttachSettings>(settings.value)
  const s = settings.value

  const edit = () => {
    setDraft(settings.value)
    setOpen(true)
  }
  const apply = () => {
    setOpen(false)
    void attach(draft)
  }
  const sim = draft.sim
  const setSim = (patch: Partial<AttachSettings['sim']>) =>
    setDraft({ ...draft, sim: { ...sim, ...patch } })

  return (
    <div class="studio__attach">
      <Select
        value={s.mode}
        options={MODES}
        onValue={(mode) => void attach({ ...settings.value, mode: mode as AttachMode })}
        class="studio__mode"
      />
      <Button size="sm" onClick={edit}>
        Settings
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => void attach(settings.value)}
        title="Re-attach / restart"
      >
        ↻ Restart
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Attach settings"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={apply}>
              Attach
            </Button>
          </>
        }
      >
        <div class="form-grid">
          <Select
            label="Mode"
            value={draft.mode}
            options={MODES}
            onValue={(mode) => setDraft({ ...draft, mode: mode as AttachMode })}
          />
          {draft.mode === 'simulated' && (
            <>
              <Input
                label="Seed"
                type="number"
                value={sim.seed}
                onValue={(v) => setSim({ seed: Number(v) || 1 })}
                hint="Same seed, same room"
              />
              <Input
                label="Peers"
                type="number"
                min={1}
                max={24}
                value={sim.peers}
                onValue={(v) => setSim({ peers: Math.max(1, Math.min(24, Number(v) || 1)) })}
              />
              <Select
                label="Topology"
                value={sim.topology}
                options={[
                  { value: 'mesh', label: 'Mesh' },
                  { value: 'star', label: 'Star (host)' },
                ]}
                onValue={(v) => setSim({ topology: v as 'mesh' | 'star' })}
              />
              <Select
                label="Speed"
                value={String(sim.speed)}
                options={['0.25', '0.5', '1', '2', '4'].map((v) => ({ value: v, label: `${v}×` }))}
                onValue={(v) => setSim({ speed: Number(v) })}
              />
              <Select
                label="Admission policy"
                value={sim.admission}
                options={[
                  { value: 'open', label: 'Open' },
                  { value: 'nostr', label: 'Requires Nostr' },
                  { value: 'oidc', label: 'Requires OIDC' },
                  { value: 'anonymous', label: 'Anonymous only' },
                ]}
                onValue={(v) => setSim({ admission: v as AttachSettings['sim']['admission'] })}
              />
              <Toggle
                checked={sim.relayFirst}
                label="relayFirst"
                onChange={(relayFirst) => setSim({ relayFirst })}
              />
            </>
          )}
          {draft.mode === 'bridge' && (
            <Input
              label="Room id"
              value={draft.bridgeRoom}
              onValue={(bridgeRoom) => setDraft({ ...draft, bridgeRoom })}
              hint={`Listens on BroadcastChannel "beamhop-devtools:${draft.bridgeRoom}" (call room.devtools() in your app)`}
            />
          )}
          {draft.mode === 'observer' && (
            <>
              <Input
                label="Relay"
                value={draft.observer.relay}
                onValue={(relay) => setDraft({ ...draft, observer: { ...draft.observer, relay } })}
              />
              <Input
                label="App id"
                value={draft.observer.appId}
                onValue={(appId) => setDraft({ ...draft, observer: { ...draft.observer, appId } })}
              />
              <Input
                label="Room id"
                value={draft.observer.roomId}
                onValue={(roomId) =>
                  setDraft({ ...draft, observer: { ...draft.observer, roomId } })
                }
                hint="Joins through <relay>/a/<app> as a peer with a self-signed debug token, which rooms with policy.dev: true accept. For other rooms use ObserverRoom with appSecretKey or debugToken + secretKey."
              />
            </>
          )}
        </div>
      </Dialog>
    </div>
  )
}
