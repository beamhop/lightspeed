# Changesets

Every PR that changes a published package adds a changeset:

```sh
bunx @changesets/cli          # pick packages, bump type and write a summary
```

Packages are **0.x**: use `minor` for breaking changes and `patch` for everything else until 1.0.

Release groups (`linked` in `config.json`, versions move together when released together):

- MIT library: `@beamhop/p2p`, `@beamhop/signaling-nostr`, `@beamhop/react`
- AGPL-3.0 relay: `@beamhop/relay`, `@beamhop/nostr-relay`, `@beamhop/turn`, `@beamhop/relay-admin`

`@beamhop/studio`, `@beamhop/ui` and `beamhop` (CLI) version independently. The apps
(`@beamhop/demo`, `@beamhop/docs`) are private and ignored.

On merge to `main`, `.github/workflows/release.yml` opens a "release packages" PR; merging that PR
publishes to npm with provenance. Relay binaries and the Docker image are released by pushing a
`relay-vX.Y.Z` tag.
