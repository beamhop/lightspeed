import { SendHorizontal, Users } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { shortId, usePeers } from '../hooks'
import { Bunny } from '../mascot'
import type { ChatMessage, DemoRoom } from '../p2p'

export function Room({ room }: { room: DemoRoom }) {
  const peers = usePeers(room)
  const [messages, setMessages] = useState<ChatMessage[]>(() => room.messages())
  const [draft, setDraft] = useState('')
  const listRef = useRef<HTMLOListElement>(null)

  useEffect(() => {
    // The room keeps the (ordered, deduped) history, including what peers sync to us on join.
    setMessages(room.messages())
    return room.onChat(() => setMessages(room.messages()))
  }, [room])
  // scroll when a message arrives
  useEffect(() => {
    listRef.current?.lastElementChild?.scrollIntoView({ block: 'end' })
  }, [messages.length])

  const send = () => {
    const text = draft.trim()
    if (!text) return
    room.sendChat(text.slice(0, 2000))
    setDraft('')
  }

  return (
    <div className="grid items-start gap-4 md:grid-cols-[260px_1fr]">
      <Card className="gap-4 py-5">
        <CardHeader className="px-5">
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="size-4 text-muted-foreground" />
            In the room
            <Badge variant="secondary" className="ml-auto tabular-nums">
              {peers.length}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-5">
          <ul className="grid gap-1" data-testid="presence">
            {peers.map((p) => (
              <li
                key={p.id}
                data-peer={p.id}
                className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/60"
              >
                <span
                  className="size-6 shrink-0 rounded-full ring-2 ring-background"
                  style={{ background: p.color }}
                  aria-hidden="true"
                />
                <span className="peer-name min-w-0 flex-1 truncate text-sm font-medium">
                  {p.name}
                </span>
                {p.self ? (
                  <span className="text-xs text-muted-foreground">you</span>
                ) : (
                  <span className="text-xs text-muted-foreground tabular-nums" title={p.id}>
                    {p.path ?? '…'}
                    {p.rttMs !== undefined ? ` · ${p.rttMs} ms` : ''}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {peers.length === 1 && (
            <div className="mt-4 flex flex-col items-center gap-2 rounded-lg border border-dashed p-4 text-center">
              <Bunny state="secret" size={48} />
              <p className="text-xs text-muted-foreground">
                Waiting for peers. Share the link or QR code.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
      <Card className="gap-0 overflow-hidden py-0">
        <ol
          className="flex h-[min(60vh,520px)] flex-col gap-3 overflow-y-auto p-5"
          ref={listRef}
          data-testid="messages"
        >
          {messages.length === 0 && (
            <li className="m-auto text-sm text-muted-foreground">No messages yet. Say hi.</li>
          )}
          {messages.map((m) => {
            const mine = m.from === room.self.id
            return (
              <li
                key={m.id}
                className={cn(
                  'flex max-w-[80%] flex-col items-start gap-1',
                  mine && 'mine items-end self-end',
                )}
              >
                <span className="text-xs text-muted-foreground" title={m.from}>
                  {mine ? 'you' : m.name || shortId(m.from)}
                  <time className="ml-2 opacity-70">{new Date(m.at).toLocaleTimeString()}</time>
                </span>
                <span
                  className={cn(
                    'rounded-2xl px-3.5 py-2 text-sm break-words whitespace-pre-wrap',
                    mine
                      ? 'rounded-br-sm bg-primary text-primary-foreground'
                      : 'rounded-bl-sm bg-muted',
                  )}
                >
                  {m.text}
                </span>
              </li>
            )
          })}
        </ol>
        <form
          className="flex gap-2 border-t bg-muted/30 p-3"
          onSubmit={(e) => {
            e.preventDefault()
            send()
          }}
        >
          <Input
            name="message"
            placeholder="Say hi (reliable, ordered channel)"
            value={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
            aria-label="Message"
            autoComplete="off"
          />
          <Button type="submit">
            <SendHorizontal />
            Send
          </Button>
        </form>
      </Card>
    </div>
  )
}
