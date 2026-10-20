# beamhop

The Beamhop command line: run and set up the relay, open Studio, scaffold an app. MIT.

```sh
bunx beamhop --help
```

| Command | What |
| --- | --- |
| `beamhop relay [--config <file>]` | Run the relay (Nostr, TURN, data relay, Blossom, payments, admin) |
| `beamhop relay init [--dir .] [--data <dir>] [--domain <host>] [--force]` | Write `beamhop-relay.toml` and `beamhop-relay.service`, create the data directory and `admin.db`, print the one-time bootstrap token. `--domain localhost` (default) gives a plain-HTTP trial config on port 8080 |
| `beamhop relay bootstrap-token [--config <file>]` | Mint a new bootstrap token while no admin exists |
| `beamhop studio [args…]` | Start Beamhop Studio (`@beamhop/studio`'s `src/server.ts`; override with `BEAMHOP_STUDIO_ENTRY`) |
| `beamhop init <dir> [--app-id <id>] [--force]` | Scaffold a minimal browser chat on `@beamhop/p2p` + `@beamhop/signaling-nostr` (public relays, WebRTC) |

The relay itself is documented in `packages/relay/README.md`. Arguments are parsed with
`util.parseArgs`; the module exports `run(argv, io)` for embedding and tests.
