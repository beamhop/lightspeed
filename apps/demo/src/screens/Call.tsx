import { useEffect, useRef, useState } from 'preact/hooks'
import { usePeers, useTelemetry } from '../hooks'
import type { DemoRoom, Hex } from '../p2p'

function Video({ stream, muted, label }: { stream: MediaStream; muted?: boolean; label: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream
  }, [stream])
  return (
    <figure class="tile">
      <video ref={ref} autoPlay playsInline muted={muted} />
      <figcaption>{label}</figcaption>
    </figure>
  )
}

export function Call({ room }: { room: DemoRoom }) {
  const peers = usePeers(room)
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

  return (
    <div class="card call">
      <div class="row">
        {!local ? (
          <button type="button" class="primary" onClick={start}>
            Start call
          </button>
        ) : (
          <>
            <button type="button" onClick={toggleMic} aria-pressed={!micOn}>
              {micOn ? 'Mute' : 'Unmute'}
            </button>
            <button type="button" onClick={toggleCam} aria-pressed={!camOn}>
              {camOn ? 'Camera off' : 'Camera on'}
            </button>
            <button type="button" onClick={switchCamera} disabled={sharing}>
              Switch camera
            </button>
            <button type="button" onClick={toggleShare} aria-pressed={sharing}>
              {sharing ? 'Stop sharing' : 'Share screen'}
            </button>
            <button type="button" class="danger" onClick={stop}>
              Hang up
            </button>
          </>
        )}
      </div>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      <div class="tiles">
        {local && <Video stream={local} muted label={`you${sharing ? ' (screen)' : ''}`} />}
        {Object.entries(remote).map(([id, s]) => (
          <Video key={id} stream={s} label={`${nameOf(id)} · ${pathOf(id)}`} />
        ))}
      </div>
      {local && Object.keys(remote).length === 0 && (
        <p class="muted small">Waiting for others to join the call…</p>
      )}
    </div>
  )
}
