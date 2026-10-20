import { useMemo, useState } from 'preact/hooks'
import qrcode from 'qrcode-generator'

export function qrSvg(text: string): string {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
}

export function ShareBox({ link, roomId }: { link: string; roomId: string }) {
  const [showQr, setShowQr] = useState(false)
  const [copied, setCopied] = useState(false)
  const svg = useMemo(() => (showQr ? qrSvg(link) : ''), [link, showQr])
  return (
    <div class="share">
      <span class="muted">Room</span> <code data-testid="room-id">{roomId}</code>
      <input class="share-link" readOnly value={link} aria-label="Room link" />
      <button
        type="button"
        onClick={async () => {
          await navigator.clipboard?.writeText(link).catch(() => {})
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
      >
        {copied ? 'Copied' : 'Copy link'}
      </button>
      <button type="button" onClick={() => setShowQr((s) => !s)}>
        {showQr ? 'Hide QR' : 'QR'}
      </button>
      {showQr && <div class="qr" dangerouslySetInnerHTML={{ __html: svg }} />}
    </div>
  )
}
