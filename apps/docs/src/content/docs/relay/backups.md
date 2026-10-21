---
title: Backups and monitoring
description: Nightly SQLite snapshots, restores, Prometheus metrics and built-in alerts.
sidebar:
  order: 7
---

:::caution[0.x, subject to change]
:::

## What to back up

Everything lives under the data directory (`/data` in Docker):

| Path | Contents |
|---|---|
| `nostr.db` | Events, tags, FTS5 search index, negentropy index |
| `admin.db` | Apps, secrets, admins, sessions, policies, usage, invoices |
| `blobs/` | Blossom media, content-addressed by SHA-256 |
| `backups/` | Snapshots made by the relay |

## Automatic snapshots

With `[backups] enabled = true` the relay runs `VACUUM INTO` for both databases every night at
`hour` (UTC, default 3), producing consistent snapshots without stopping writes, and keeps them for
`retention_days` (default 14). Snapshots are written to `backups.dir` (default `<data_dir>/backups`)
as `nostr-<timestamp>.db` and `admin-<timestamp>.db`. They stay on the host, so copy that directory
somewhere else (rsync, restic, volume snapshots). Trigger one now from **Nostr relay → Backup** in
the admin UI or `POST /api/admin/backups`; the schedule is edited under **Settings → Backups**.

Blobs are immutable and named by hash, so `rsync` or `rclone sync` of `blobs/` is a complete,
incremental backup.

## Restore

```sh
sudo systemctl stop beamhop-relay
cp /var/lib/beamhop/backups/nostr-20261020T030000Z.db /var/lib/beamhop/nostr.db
cp /var/lib/beamhop/backups/admin-20261020T030000Z.db /var/lib/beamhop/admin.db
rm -f /var/lib/beamhop/*.db-wal /var/lib/beamhop/*.db-shm
sudo systemctl start beamhop-relay
```

Migrations run on boot. A snapshot from an older version is migrated forward; a snapshot from a
newer version is refused.

## Monitoring

- `GET /healthz` returns `200` when listeners and databases are healthy.
- `GET /metrics` (unless `[metrics] enabled = false`; bearer-protected when `token` is set) exposes
  Prometheus metrics: events/s, subscriptions, clients, TURN allocations and
  bytes, data-relay bytes per app, Blossom usage, HTTP status counts.
- A Grafana dashboard JSON ships in the repository and can be downloaded from **Settings**.
- Logs are JSON lines on stdout (journald or `docker logs`).

Built-in alerts (shown on the admin overview and as `beamhop_alerts_active`; email is not
implemented, so alert from Prometheus): disk above 80%, TURN quota
exhaustion, relay error rate, certificate expiry within 14 days.
