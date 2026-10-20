// `beamhop init <dir>`: a minimal browser app on @beamhop/p2p (chat + presence over public Nostr relays).

export interface ScaffoldOptions {
  name: string
  appId: string
  relays: string[]
}

export function scaffoldFiles(o: ScaffoldOptions): Record<string, string> {
  const pkg = {
    name: o.name,
    private: true,
    type: 'module',
    scripts: {
      dev: 'bun ./index.html',
      build: 'bun build ./index.html --outdir dist --minify',
      typecheck: 'tsc --noEmit',
    },
    dependencies: {
      '@beamhop/p2p': 'latest',
      '@beamhop/signaling-nostr': 'latest',
    },
    devDependencies: {
      '@types/bun': 'latest',
      typescript: '^5.6.0',
    },
  }
  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    },
    include: ['src'],
  }
  return {
    'package.json': `${JSON.stringify(pkg, null, 2)}\n`,
    'tsconfig.json': `${JSON.stringify(tsconfig, null, 2)}\n`,
    '.gitignore': 'node_modules\ndist\n',
    'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${o.name}</title>
    <style>
      body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: #0b0e1a; color: #e6e8f2; }
      main { max-width: 640px; margin: 0 auto; padding: 16px; }
      #log { min-height: 240px; border: 1px solid #262b45; border-radius: 12px; padding: 12px; }
      form { display: flex; gap: 8px; margin-top: 12px; }
      input { flex: 1; padding: 10px; border-radius: 8px; border: 1px solid #2f3555; background: #0f1222; color: inherit; }
      button { padding: 10px 14px; border: 0; border-radius: 8px; background: #5eead4; color: #0b0e1a; }
      small { color: #8a90a8; }
    </style>
  </head>
  <body>
    <main>
      <h1>${o.name}</h1>
      <p><small id="me">connecting…</small> · <small id="peers">0 peers</small></p>
      <div id="log"></div>
      <form id="f"><input id="msg" placeholder="Say hi" autocomplete="off" /><button>Send</button></form>
    </main>
    <script type="module" src="./src/main.ts"></script>
  </body>
</html>
`,
    'src/main.ts': `import { action, any, anonymous, createRoom, defineProtocol } from '@beamhop/p2p'
import { webrtcTransport } from '@beamhop/p2p/webrtc'
import { nostrSignaling } from '@beamhop/signaling-nostr'

// Typed protocol: every message name, payload and channel reliability lives here.
const protocol = defineProtocol({
  chat: action(any<string>()),
})

const roomId = location.hash.slice(1) || 'lobby'

const room = await createRoom({
  appId: ${JSON.stringify(o.appId)},
  roomId,
  identity: anonymous(),
  signaling: nostrSignaling({ relays: ${JSON.stringify(o.relays)} }),
  transports: [webrtcTransport()],
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }],
  protocol,
})

const $ = (id: string) => document.getElementById(id) as HTMLElement
const log = (line: string) => {
  const p = document.createElement('p')
  p.textContent = line
  $('log').append(p)
}
const short = (pubkey: string) => pubkey.slice(0, 8)

$('me').textContent = \`you are \${short(room.self.pubkey)} in #\${roomId}\`
const updatePeers = () => {
  $('peers').textContent = \`\${room.peers.length} peers\`
}
room.onPeerJoin((p) => {
  log(\`→ \${short(p.pubkey)} joined\`)
  updatePeers()
})
room.onPeerLeave((p) => {
  log(\`← \${short(p.pubkey)} left\`)
  updatePeers()
})

const chat = room.action('chat')
chat.onMessage((text, from) => log(\`\${short(from)}: \${text}\`))

$('f').addEventListener('submit', (e) => {
  e.preventDefault()
  const input = $('msg') as HTMLInputElement
  if (!input.value) return
  void chat.send(input.value)
  log(\`me: \${input.value}\`)
  input.value = ''
})
`,
    'README.md': `# ${o.name}

A minimal peer-to-peer chat built with [@beamhop/p2p](https://github.com/beamhop/lightspeed).

\`\`\`sh
bun install
bun run dev
\`\`\`

Open the printed URL in two browser windows. Peers find each other through public Nostr relays
(${o.relays.join(', ')}) and connect directly over WebRTC. Use \`#room-name\` in the URL to pick a room.

To get TURN, a data-relay fallback and your own signaling, run a Beamhop relay
(\`bunx beamhop relay init\`), create an app in its admin UI and point \`relays\` at
\`wss://your-relay/a/<appId>\`.
`,
  }
}
