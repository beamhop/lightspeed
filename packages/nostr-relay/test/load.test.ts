// Load smoke: 1k live subscriptions, 500 events/s for 2 s, no errors and full delivery.
import { afterAll, expect, test } from 'bun:test'
import { Client, genKeys, sign, sleep, startRelay, type TestRelay } from './helpers'

const SUB_SOCKETS = 10
const SUBS_PER_SOCKET = 100
const TOPICS = 50
const RATE = 500
const SECONDS = 2
const TOTAL = RATE * SECONDS

let t: TestRelay
const clients: Client[] = []
afterAll(() => {
  for (const c of clients) c.close()
  t?.close()
})

test(
  'load smoke: 1000 subscriptions, 500 events/s for 2 s',
  async () => {
    t = startRelay({ verifyWorkers: 2 })
    const keys = Array.from({ length: 20 }, () => genKeys())
    const events = Array.from({ length: TOTAL }, (_, n) =>
      sign(keys[n % keys.length] as ReturnType<typeof genKeys>, {
        content: `load ${n}`,
        tags: [['t', `topic${n % TOPICS}`]],
      }),
    )

    const subs: Client[] = []
    for (let j = 0; j < SUB_SOCKETS; j++) {
      const c = await Client.connect(t.url)
      clients.push(c)
      subs.push(c)
      await Promise.all(
        Array.from({ length: SUBS_PER_SOCKET }, (_, i) =>
          c.req(`s${i}`, { kinds: [1], '#t': [`topic${(j * SUBS_PER_SOCKET + i) % TOPICS}`] }),
        ),
      )
    }
    expect(t.relay.stats().subscriptions).toBe(SUB_SOCKETS * SUBS_PER_SOCKET)

    const pubs: Client[] = []
    for (let i = 0; i < 5; i++) {
      const c = await Client.connect(t.url)
      clients.push(c)
      pubs.push(c)
    }

    const started = performance.now()
    const acks: Promise<{ ok: boolean; message: string }>[] = []
    const tickMs = 10
    const perTick = (RATE * tickMs) / 1000
    for (let sent = 0; sent < TOTAL; ) {
      const due = Math.min(
        TOTAL,
        Math.floor(((performance.now() - started) / 1000) * RATE) + perTick,
      )
      while (sent < due) {
        const ev = events[sent] as (typeof events)[number]
        acks.push((pubs[sent % pubs.length] as Client).publish(ev))
        sent++
      }
      await sleep(tickMs)
    }
    const results = await Promise.all(acks)
    const elapsed = (performance.now() - started) / 1000
    const failures = results.filter((r) => !r.ok)
    expect(failures).toEqual([])
    expect(elapsed).toBeLessThan(SECONDS + 3)

    // each socket holds 2 subscriptions per topic -> 2 deliveries per event
    const expectedPerSocket = TOTAL * (SUBS_PER_SOCKET / TOPICS)
    const countEvents = (c: Client) => c.all.filter((m) => m[0] === 'EVENT').length
    for (let i = 0; i < 300 && subs.some((c) => countEvents(c) < expectedPerSocket); i++)
      await sleep(20)
    for (const c of subs) expect(countEvents(c)).toBe(expectedPerSocket)
    for (const c of [...subs, ...pubs]) {
      expect(c.all.filter((m) => m[0] === 'NOTICE' || m[0] === 'CLOSED')).toEqual([])
    }
    const s = t.relay.stats()
    expect(s.eventsPerSec).toBeGreaterThan(0)
    expect(t.relay.count([{ kinds: [1] }])).toBe(TOTAL)
    console.log(
      `load: ${TOTAL} events in ${elapsed.toFixed(2)}s, ${TOTAL * 20} deliveries, eps=${s.eventsPerSec}`,
    )
  },
  { timeout: 30_000 },
)
