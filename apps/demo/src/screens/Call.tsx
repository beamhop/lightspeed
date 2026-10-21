import {
  Mic,
  MicOff,
  MonitorUp,
  MonitorX,
  Phone,
  PhoneOff,
  SwitchCamera,
  Video as VideoIcon,
  VideoOff,
} from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useCallPeers, usePeers, useTelemetry } from '../hooks'
import { Bunny } from '../mascot'
import type { DemoRoom, Hex } from '../p2p'

function Video({ stream, muted, label }: { stream: MediaStream; muted?: boolean; label: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream
  }, [stream])
  return (
    <figure className="relative m-0 aspect-[4/3] overflow-hidden rounded-xl border bg-background shadow-sm">
      <video ref={ref} autoPlay playsInline muted={muted} className="size-full object-cover" />
      <figcaption className="absolute bottom-2 left-2 rounded-md bg-background/75 px-2 py-0.5 text-xs backdrop-blur">
        {label}
      </figcaption>
    </figure>
  )
}

export function Call({
  room,
  joinSignal = 0,
  onActiveChange,
}: {
  room: DemoRoom
  /** Starts the call when it changes (the app's "Join call" banner). */
  joinSignal?: number
  onActiveChange?: (active: boolean) => void
}) {
  const peers = usePeers(room)
  const callPeers = useCallPeers(room)
  const telemetry = useTelemetry(room)
  const [local, setLocal] = useState<MediaStream | null>(null)
  const [remote, setRemote] = useState<Record<Hex, MediaStream>>({})
  const [micOn, setMicOn] = useState(true)
  const [camOn, setCamOn] = useState(true)
  const [sharing, setSharing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const camIndex = useRef(0)
  const camStream = useRef<MediaStream | null>(null)

  useEffect(
    () =>
      room.onRemoteStream((peer, stream) =>
        setRemote((prev) => {
          const next = { ...prev }
          if (stream) next[peer] = stream
          else delete next[peer]
          return next
        }),
      ),
    [room],
  )
  useEffect(
    () => () => {
      // Leaving the screen ends the call.
      for (const t of camStream.current?.getTracks() ?? []) t.stop()
      room.stopCall()
    },
    [room],
  )

  // report only when media starts or stops
  useEffect(() => onActiveChange?.(!!local), [local])
  // fires on the banner's signal only
  useEffect(() => {
    if (joinSignal && !local) void start()
  }, [joinSignal])

  async function cameras(): Promise<MediaDeviceInfo[]> {
    const all = await navigator.mediaDevices.enumerateDevices()
    return all.filter((d) => d.kind === 'videoinput')
  }

  async function getCamera(deviceId?: string): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({
      audio: true,
      video: deviceId ? { deviceId: { exact: deviceId } } : true,
    })
  }

  async function start() {
    if (camStream.current) return
    setError(null)
    try {
      const s = await getCamera()
      camStream.current = s
      setLocal(s)
      setMicOn(true)
      setCamOn(true)
      await room.startCall(s)
    } catch (err) {
      setError(`Could not start media: ${err instanceof Error ? err.message : err}`)
    }
  }

  function stop() {
    for (const t of local?.getTracks() ?? []) t.stop()
    for (const t of camStream.current?.getTracks() ?? []) t.stop()
    camStream.current = null
    setLocal(null)
    setSharing(false)
    room.stopCall()
  }

  function toggleMic() {
    for (const t of local?.getAudioTracks() ?? []) t.enabled = !micOn
    setMicOn(!micOn)
  }

  function toggleCam() {
    for (const t of local?.getVideoTracks() ?? []) t.enabled = !camOn
    setCamOn(!camOn)
  }

  async function switchCamera() {
    const list = await cameras()
    if (list.length < 2) {
      setError('Only one camera found')
      return
    }
    camIndex.current = (camIndex.current + 1) % list.length
    const s = await getCamera(list[camIndex.current]?.deviceId)
    for (const t of camStream.current?.getTracks() ?? []) t.stop()
    camStream.current = s
    for (const t of s.getAudioTracks()) t.enabled = micOn
    setLocal(s)
    await room.replaceCallStream(s)
  }

  async function toggleShare() {
    if (sharing) {
      const s = camStream.current
      if (s) {
        setLocal(s)
        await room.replaceCallStream(s)
      }
      setSharing(false)
      return
    }
    try {
      const screen = await navigator.mediaDevices.getDisplayMedia({ video: true })
      const mixed = new MediaStream([
        ...(camStream.current?.getAudioTracks() ?? []),
        ...screen.getVideoTracks(),
      ])
      screen.getVideoTracks()[0]?.addEventListener('ended', () => void toggleShare())
      setLocal(mixed)
      setSharing(true)
      await room.replaceCallStream(mixed)
    } catch (err) {
      setError(`Screen share failed: ${err instanceof Error ? err.message : err}`)
    }
  }

  const nameOf = (id: Hex) => peers.find((p) => p.id === id)?.name ?? id.slice(0, 8)
  const pathOf = (id: Hex) => {
    const t = telemetry.peers[id]
    return t?.candidatePair ?? t?.path ?? 'connecting'
  }

  const connecting = callPeers.filter((id) => !remote[id])
  const status = connecting.length
    ? `${connecting.map(nameOf).join(', ')} ${local ? 'connecting…' : 'in the call'}`
    : local && Object.keys(remote).length === 0
      ? 'Waiting for others to join the call…'
      : null

  return (
    <Card className="call">
      <CardContent className="grid gap-4">
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {!local ? (
          <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-12 text-center">
            <Bunny size={64} state={callPeers.length ? 'smile' : 'idle'} />
            <div className="grid gap-1">
              <p className="font-medium">
                {callPeers.length ? 'A call is in progress' : 'Audio and video, peer to peer'}
              </p>
              <p className="max-w-md text-sm text-muted-foreground">
                Each peer gets its own media connection; remote media only plays once you join.
              </p>
            </div>
            <Button size="lg" onClick={start}>
              <Phone />
              {callPeers.length ? 'Join call' : 'Start call'}
            </Button>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Video stream={local} muted label={`you${sharing ? ' (screen)' : ''}`} />
            {/* Remote media only plays once we joined, so being in the room isn't eavesdropping. */}
            {Object.entries(remote)
              .filter(([id]) => callPeers.includes(id))
              .map(([id, s]) => (
                <Video key={id} stream={s} label={`${nameOf(id)} · ${pathOf(id)}`} />
              ))}
          </div>
        )}
        {status && <p className="text-center text-sm text-muted-foreground">{status}</p>}
        {local && (
          <div className="flex flex-wrap items-center justify-center gap-2 rounded-full border bg-muted/40 p-2 sm:mx-auto">
            <Control
              label={micOn ? 'Mute' : 'Unmute'}
              pressed={!micOn}
              onClick={toggleMic}
              icon={micOn ? <Mic /> : <MicOff />}
            />
            <Control
              label={camOn ? 'Camera off' : 'Camera on'}
              pressed={!camOn}
              onClick={toggleCam}
              icon={camOn ? <VideoIcon /> : <VideoOff />}
            />
            <Control
              label="Switch camera"
              onClick={switchCamera}
              disabled={sharing}
              icon={<SwitchCamera />}
            />
            <Control
              label={sharing ? 'Stop sharing' : 'Share screen'}
              pressed={sharing}
              onClick={toggleShare}
              icon={sharing ? <MonitorX /> : <MonitorUp />}
            />
            <Button variant="destructive" className="rounded-full" onClick={stop}>
              <PhoneOff />
              Hang up
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function Control(props: {
  label: string
  icon: ReactNode
  onClick: () => void
  pressed?: boolean
  disabled?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={props.pressed ? 'secondary' : 'ghost'}
          size="icon"
          className="rounded-full data-[pressed=true]:text-warning"
          aria-label={props.label}
          aria-pressed={props.pressed}
          data-pressed={props.pressed}
          disabled={props.disabled}
          onClick={props.onClick}
        >
          {props.icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{props.label}</TooltipContent>
    </Tooltip>
  )
}
