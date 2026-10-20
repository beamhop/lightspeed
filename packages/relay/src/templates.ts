// Files written by `beamhop relay init`; the same content ships in deploy/.
import { makeConfig, type RelayConfig, toToml } from './config'

/** Starter beamhop-relay.toml with a header explaining env overrides. */
export function exampleToml(
  overrides: Partial<Pick<RelayConfig, 'dataDir' | 'publicUrl'>> & { domain?: string } = {},
): string {
  const domain = overrides.domain ?? 'relay.example.com'
  const config = makeConfig({
    dataDir: overrides.dataDir ?? '/var/lib/beamhop-relay',
    publicUrl: overrides.publicUrl ?? `https://${domain}`,
    http: {
      tlsCert: `/etc/letsencrypt/live/${domain}/fullchain.pem`,
      tlsKey: `/etc/letsencrypt/live/${domain}/privkey.pem`,
    },
    turn: { realm: domain },
  })
  return `# Beamhop relay configuration.
# Every key can be overridden by an environment variable: BEAMHOP_<SECTION>_<KEY>, for example
# BEAMHOP_HTTP_PORT=8443 or BEAMHOP_TURN_EXTERNAL_IP=203.0.113.7 (top-level: BEAMHOP_DATA_DIR).
# Settings edited in the admin UI are stored in admin.db and override this file (env still wins).
# Leave http.tls_cert/tls_key empty when Caddy (or another proxy) terminates TLS on 443.

${toToml(config)}`
}

/** systemd unit with hardening; binds 443/3478 through CAP_NET_BIND_SERVICE as a non-root user. */
export function systemdUnit(
  opts: { binary?: string; config?: string; dataDir?: string; user?: string } = {},
): string {
  const binary = opts.binary ?? '/usr/local/bin/beamhop-relay'
  const config = opts.config ?? '/etc/beamhop/beamhop-relay.toml'
  const dataDir = opts.dataDir ?? '/var/lib/beamhop-relay'
  const user = opts.user ?? 'beamhop'
  return `[Unit]
Description=Beamhop relay (Nostr, TURN, data relay, Blossom, admin)
Documentation=https://github.com/beamhop/lightspeed/tree/main/packages/relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${user}
Group=${user}
ExecStart=${binary} --config ${config}
Restart=on-failure
RestartSec=2
LimitNOFILE=1048576
Environment=BEAMHOP_DATA_DIR=${dataDir}
StateDirectory=${dataDir.startsWith('/var/lib/') ? dataDir.slice('/var/lib/'.length) : 'beamhop-relay'}
ReadWritePaths=${dataDir}
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
MemoryDenyWriteExecute=false
SystemCallArchitectures=native
UMask=0077

[Install]
WantedBy=multi-user.target
`
}
