import { Network, RadioTower, Server } from 'lucide-react'
import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { type DemoConfig, needsOwnRelay, normalizeRelayUrl, type TransportMode } from '../config'

export const TRANSPORTS: {
  id: TransportMode
  label: string
  badge: string
  icon: typeof Network
  hint: string
}[] = [
  {
    id: 'p2p',
    label: 'WebRTC P2P',
    badge: 'webrtc p2p',
    icon: Network,
    hint: 'Direct data channels over public STUN. No server sees your data, but two symmetric NATs cannot connect.',
  },
  {
    id: 'turn',
    label: 'WebRTC TURN',
    badge: 'webrtc turn',
    icon: RadioTower,
    hint: 'WebRTC forced through the TURN server on your relay (iceTransportPolicy: relay). Still end-to-end encrypted.',
  },
  {
    id: 'relay',
    label: 'WebSocket relay',
    badge: 'ws relay',
    icon: Server,
    hint: 'Frames go over a WebSocket to your relay’s data path (/a/<appId>/data), encrypted per peer pair.',
  },
]

export interface TransportDraft {
  transport: TransportMode
  url: string
  appId: string
  apiKey: string
}

export function useTransportDraft(cfg: DemoConfig) {
  return useState<TransportDraft>(() => ({
    transport: cfg.transport,
    url: cfg.ownRelay?.url ?? '',
    appId: cfg.ownRelay?.appId ?? '',
    apiKey: cfg.ownRelay?.apiKey ?? '',
  }))
}

/** Validates the draft into config fields, or returns an error message. */
export function resolveTransport(
  d: TransportDraft,
): Pick<DemoConfig, 'transport' | 'ownRelay'> | string {
  const url = normalizeRelayUrl(d.url)
  const appId = d.appId.trim()
  const apiKey = d.apiKey.trim()
  const ownRelay = url && appId ? { url, appId, ...(apiKey ? { apiKey } : {}) } : undefined
  if (needsOwnRelay(d.transport) && !ownRelay) {
    return 'TURN and the WebSocket relay need your Beamhop relay URL (wss://relay.example) and an app id'
  }
  return { transport: d.transport, ownRelay }
}

export function TransportPicker(props: {
  value: TransportDraft
  onChange: (next: TransportDraft) => void
  idPrefix?: string
  /** Visually hide the legend when the surrounding section already says "Transport". */
  hideLegend?: boolean
}) {
  const { value: d, onChange } = props
  const p = props.idPrefix ?? 'tr'
  const set = (patch: Partial<TransportDraft>) => onChange({ ...d, ...patch })
  const current = TRANSPORTS.find((t) => t.id === d.transport) ?? TRANSPORTS[0]
  return (
    <fieldset className="grid gap-3" data-testid="transport">
      <legend className={props.hideLegend ? 'sr-only' : 'mb-3 text-sm font-medium'}>
        Transport
      </legend>
      <RadioGroup
        value={d.transport}
        onValueChange={(v) => set({ transport: v as TransportMode })}
        className="grid gap-2 sm:grid-cols-3"
      >
        {TRANSPORTS.map((t) => (
          <Label
            key={t.id}
            htmlFor={`${p}-${t.id}`}
            className="flex cursor-pointer items-center gap-3 rounded-lg border p-3 font-normal has-[[data-state=checked]]:border-primary/60 has-[[data-state=checked]]:bg-primary/5"
          >
            <RadioGroupItem id={`${p}-${t.id}`} value={t.id} />
            <t.icon className="size-4 text-muted-foreground" aria-hidden="true" />
            {t.label}
          </Label>
        ))}
      </RadioGroup>
      <p className="text-xs leading-relaxed text-muted-foreground">{current?.hint}</p>
      {needsOwnRelay(d.transport) && (
        <div className="grid gap-2.5 rounded-lg border border-dashed p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              placeholder="wss://relay.example"
              value={d.url}
              onChange={(e) => set({ url: e.currentTarget.value })}
              aria-label="Relay URL"
            />
            <Input
              placeholder="app id"
              value={d.appId}
              onChange={(e) => set({ appId: e.currentTarget.value })}
              aria-label="App id"
            />
          </div>
          <Input
            placeholder="API key for TURN credentials (optional, else NIP-98)"
            value={d.apiKey}
            type="password"
            autoComplete="off"
            onChange={(e) => set({ apiKey: e.currentTarget.value })}
            aria-label="API key"
          />
          <p className="text-xs leading-relaxed text-muted-foreground">
            Needs a Beamhop relay. Signaling also uses its{' '}
            <code className="font-mono">/a/&lt;appId&gt;</code> realm, TURN credentials come from{' '}
            <code className="font-mono">/a/&lt;appId&gt;/turn-credentials</code>. The room link
            carries the transport, relay and app id (never the API key) so peers match.
          </p>
        </div>
      )}
    </fieldset>
  )
}
