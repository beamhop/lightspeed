import { Check, Copy, QrCode } from 'lucide-react'
import qrcode from 'qrcode-generator'
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

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
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border bg-card p-3">
      <span className="text-sm text-muted-foreground">Room</span>
      <code
        className="rounded-md bg-muted px-2 py-1 font-mono text-sm text-primary"
        data-testid="room-id"
      >
        {roomId}
      </code>
      <Input
        className="h-8 min-w-48 flex-1 font-mono text-xs"
        readOnly
        value={link}
        aria-label="Room link"
        onFocus={(e) => e.currentTarget.select()}
      />
      <Button
        variant="outline"
        size="sm"
        onClick={async () => {
          await navigator.clipboard?.writeText(link).catch(() => {})
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
      >
        {copied ? <Check /> : <Copy />}
        {copied ? 'Copied' : 'Copy link'}
      </Button>
      <Button
        variant={showQr ? 'secondary' : 'outline'}
        size="sm"
        aria-pressed={showQr}
        onClick={() => setShowQr((s) => !s)}
      >
        <QrCode />
        {showQr ? 'Hide QR' : 'QR'}
      </Button>
      {showQr && (
        <div
          className="qr basis-full sm:basis-auto w-full max-w-[220px] rounded-lg bg-white p-1.5"
          // SVG generated locally from the room link
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
    </div>
  )
}
