import { useEffect, useRef, useState } from 'preact/hooks'
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
    <div class="room">
      <aside class="card presence">
        <h2>
          In the room <span class="count">{peers.length}</span>
        </h2>
        <ul data-testid="presence">
          {peers.map((p) => (
            <li key={p.id} data-peer={p.id}>
              <span class="avatar" style={{ background: p.color }} aria-hidden="true" />
              <span class="peer-name">{p.name}</span>
              {p.self ? (
                <span class="muted small">you</span>
              ) : (
                <span class="muted small" title={p.id}>
                  {p.path ?? '…'}
                  {p.rttMs !== undefined ? ` · ${p.rttMs} ms` : ''}
                </span>
              )}
            </li>
          ))}
        </ul>
        {peers.length === 1 && (
          <div class="empty">
            <Bunny state="secret" size={48} />
            <p class="muted small">Waiting for peers. Share the link or QR code.</p>
          </div>
        )}
      </aside>
      <div class="card chat">
        <ol class="messages" ref={listRef} data-testid="messages">
          {messages.map((m) => (
            <li key={m.id} class={m.from === room.self.id ? 'mine' : ''}>
              <span class="who" title={m.from}>
                {m.from === room.self.id ? 'you' : m.name || shortId(m.from)}
              </span>
              <span class="text">{m.text}</span>
              <time class="muted small">{new Date(m.at).toLocaleTimeString()}</time>
            </li>
          ))}
        </ol>
        <form
          class="composer"
          onSubmit={(e) => {
            e.preventDefault()
            send()
          }}
        >
          <input
            name="message"
            placeholder="Say hi (reliable, ordered channel)"
            value={draft}
            onInput={(e) => setDraft(e.currentTarget.value)}
            aria-label="Message"
          />
          <button type="submit" class="primary">
            Send
          </button>
        </form>
      </div>
    </div>
  )
}
