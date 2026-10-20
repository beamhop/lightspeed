import { type BrowserContext, expect, type Page, test } from '@playwright/test'

// Local mode (`?local=1`) uses BroadcastChannel, which is scoped to one browser storage partition:
// two tabs of the same context see each other, two separate contexts do not. The local tests below
// therefore open two pages per context, and run one context per simulated "user" in each test so the
// contexts stay isolated from parallel tests. The network test at the bottom uses two contexts over
// the public Nostr relays and is opt-in (DEMO_E2E_NETWORK=1) because CI must not depend on them.

async function joinAs(page: Page, name: string, roomId: string, extra = '&local=1') {
  await page.goto(`?room=${roomId}&name=${name}${extra}`)
  await expect(page.getByTestId('room-id')).toHaveText(roomId)
}

function presence(page: Page) {
  return page.getByTestId('presence').locator('.peer-name')
}

async function sendChat(page: Page, text: string) {
  await page.getByLabel('Message').fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
}

test.describe('local mode: two tabs', () => {
  let context: BrowserContext

  test.beforeEach(async ({ browser }) => {
    context = await browser.newContext()
  })
  test.afterEach(async () => {
    await context.close()
  })

  test('presence and chat', async () => {
    const roomId = `e2e-${Date.now().toString(36)}`
    const alice = await context.newPage()
    const bob = await context.newPage()
    await joinAs(alice, 'alice', roomId)
    await joinAs(bob, 'bob', roomId)

    await expect(alice.getByTestId('mode')).toHaveText('local tabs')
    await expect(presence(alice)).toHaveText(['alice', 'bob'])
    await expect(presence(bob)).toHaveText(['bob', 'alice'])

    await sendChat(alice, 'hello from alice')
    await expect(bob.getByTestId('messages')).toContainText('hello from alice')
    await sendChat(bob, 'hi alice')
    await expect(alice.getByTestId('messages')).toContainText('hi alice')

    await bob.getByRole('button', { name: 'Leave' }).click()
    await expect(presence(alice)).toHaveText(['alice'])
  })

  test('create room from the lobby and join by link', async () => {
    const alice = await context.newPage()
    await alice.goto('?local=1')
    await alice.getByLabel('Your name').fill('alice')
    await alice.getByTestId('create').click()
    const share = alice.getByLabel('Room link', { exact: true })
    await expect(share).toHaveValue(/[?&]room=[\w-]+.*local=1/)
    const link = await share.inputValue()

    const bob = await context.newPage()
    await bob.goto('?local=1')
    await bob.getByLabel('Your name').fill('bob')
    await bob.getByLabel('Room link or id').fill(link)
    await bob.getByTestId('join').click()
    await expect(presence(bob)).toHaveText(['bob', 'alice'])
  })

  test('debug drawer shows peers and signaling', async () => {
    const roomId = `e2e-dbg-${Date.now().toString(36)}`
    const alice = await context.newPage()
    const bob = await context.newPage()
    await joinAs(alice, 'alice', roomId)
    await joinAs(bob, 'bob', roomId)
    await expect(presence(alice)).toHaveText(['alice', 'bob'])
    await alice.getByRole('button', { name: 'Debug' }).click()
    const drawer = alice.getByTestId('debug')
    await expect(drawer).toContainText('bob')
    await expect(drawer).toContainText('hello')
  })
})

test('network: two browser contexts over public relays', async ({ browser }) => {
  test.skip(!process.env.DEMO_E2E_NETWORK, 'set DEMO_E2E_NETWORK=1 to use public Nostr relays')
  const roomId = `e2e-net-${Date.now().toString(36)}`
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  try {
    const alice = await ctxA.newPage()
    const bob = await ctxB.newPage()
    await joinAs(alice, 'alice', roomId, '')
    await joinAs(bob, 'bob', roomId, '')
    await expect(alice.getByTestId('mode')).toHaveText('nostr + webrtc')
    await expect(presence(alice)).toHaveText(['alice', 'bob'], { timeout: 30_000 })
    await sendChat(alice, 'over the internet')
    await expect(bob.getByTestId('messages')).toContainText('over the internet')
  } finally {
    await ctxA.close()
    await ctxB.close()
  }
})
