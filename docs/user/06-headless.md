# Headless sync (Docker)

Run SelfSync on a server **without Obsidian**, so other software — a script, a
CI job, an AI agent — can read and edit your vault as normal files and always
have the latest version.

The container is a full peer device: it uses the same sync engine, the same
WebDAV backend, the same manifest and the same conflict handling as the plugin.
It just has a directory instead of an app.

```
  Obsidian (desktop/mobile) ─┐
                             ├─→  WebDAV backend  ←─→  selfsync-cli  →  /vault volume
  Obsidian (other device)  ──┘                                              ↑
                                                                      your agent
```

## Requirements

- A WebDAV backend already in use by at least one Obsidian device. Let the plugin
  sync once first: creating the very first manifest is not protected against
  concurrent writes, so two clients bootstrapping an empty folder at the same
  moment can lose an update.
- Docker with Compose.

## Quick start

```sh
git clone https://github.com/adrian-moll/obsidian-selfsync
cd obsidian-selfsync/docker
cp .env.agent.example .env
$EDITOR .env                       # backend URL, credentials, passphrase
docker compose -f docker-compose.agent.yml up -d
docker compose -f docker-compose.agent.yml logs -f selfsync
```

The vault lands in the `vault` volume, mounted at `/vault` in both containers.
Point your own tool at it by replacing the `agent` service's image and command.

Check it before running it for real:

```sh
docker compose -f docker-compose.agent.yml run --rm selfsync doctor
```

## Commands

| Command | What it does |
| --- | --- |
| `daemon` | Sync continuously — file watching plus an interval. The default. |
| `sync-once` | Run one cycle and exit. `0` = converged, `1` = failed. For cron, or for an agent forcing a sync before and after a work session. |
| `doctor` | Check the configuration and reach the backend. Writes nothing. |

## Configuration

All configuration is environment variables.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SELFSYNC_WEBDAV_URL` | *required* | Backend URL, exactly as in the plugin. |
| `SELFSYNC_WEBDAV_USER` | *required* | Username (`SELFSYNC_WEBDAV_USERNAME` also accepted). |
| `SELFSYNC_WEBDAV_PASS` | *required* | Password (`SELFSYNC_WEBDAV_PASSWORD` also accepted). |
| `SELFSYNC_WEBDAV_ROOT_DIR` | `selfsync` | Sync folder on the backend. Must match the plugin. |
| `SELFSYNC_ENCRYPTION_PASSPHRASE` | *(unset)* | Set **only** for an encrypted vault, and it must match the plugin's exactly. |
| `SELFSYNC_VAULT_DIR` | `/vault` | Where the vault lives in the container. |
| `SELFSYNC_STATE_DIR` | `/state` | Device-local state. Must **not** be inside the vault. |
| `SELFSYNC_SYNC_INTERVAL_MINUTES` | `5` | Backstop interval; also what pulls remote changes. |
| `SELFSYNC_CHANGE_DEBOUNCE_SECONDS` | `10` | Quiet period after a local edit before syncing. |
| `SELFSYNC_WATCH` | `true` | Watch the vault for local changes. |
| `SELFSYNC_MAX_FILE_MB` | `50` | Files above this are left untouched on both sides. `0` = no limit. |
| `SELFSYNC_SYNC_OBSIDIAN_CONFIG` | `false` | Sync `.obsidian/`. Normally taken from the shared config instead. |
| `SELFSYNC_EXCLUDE_GLOBS` | *(empty)* | Extra exclude patterns, comma- or newline-separated. |
| `SELFSYNC_IMPORT_REMOTE_CONFIG` | `true` | Adopt the plugin's exclude settings from the backend on startup. |
| `SELFSYNC_DEVICE_ID` | *(generated)* | Override the device id. Must be unique across devices. |
| `SELFSYNC_DEBUG` | `false` | Verbose logging. |

Any secret can be supplied from a file instead, for Docker secrets:
`SELFSYNC_WEBDAV_PASS_FILE`, `SELFSYNC_ENCRYPTION_PASSPHRASE_FILE`.

### Exclusions must match the plugin

An excluded path is invisible to reconciliation, but the *full* file index is
still published. If the container and the plugin disagree about what's excluded,
each keeps re-uploading what the other ignores. By default the container reads
the shared config the plugin publishes to the backend and adopts its exclude
settings, which keeps the two in step automatically. Turn that off with
`SELFSYNC_IMPORT_REMOTE_CONFIG=false` only if you set the same values by hand.

### The state directory

`/state` holds this device's file index, its merge bases, its generated device
id, and `health.json`. Keep it on its own volume:

- Inside the vault, it would sync to all your other devices.
- Losing it is safe — the next sync re-indexes from the backend — but keeping it
  makes restarts fast and preserves automatic merging of concurrent edits.

**Never copy the plugin's `data.json` into the container.** The device id
identifies who made a change and names conflict copies; two devices sharing one
produce indistinguishable, colliding copies.

## How changes travel

- **You edit in Obsidian** → the plugin syncs → the container picks it up on its
  next interval (default 5 minutes).
- **Your agent edits `/vault`** → the watcher fires → after the debounce (10 s)
  and the 30 s cooldown between automatic syncs, roughly 40 seconds. Use
  `sync-once` for an immediate push.
- **Both edit the same note** → non-overlapping changes are merged
  automatically; genuinely colliding ones keep both copies, with the container's
  copy named `note (conflict headless-xxxxxxxx …).md`.

## Monitoring

`docker logs` is the interface — one line per event. `<state>/health.json` also
carries the current status, last sync time, last error and conflict list; the
image's healthcheck reads it, so `docker ps` shows unhealthy on a persistent
error.

## Limits

- **Uploads are read whole into memory** and capped by `SELFSYNC_MAX_FILE_MB`
  (downloads stream in chunks and are not capped). Files over the cap are left
  alone on both sides, never deleted.
- **Avoid editing the same file from Obsidian and the container in the same few
  seconds.** File content is written without a conditional check — only the index
  is — so a true simultaneous write to one path can record one version's checksum
  against the other's bytes. Normal use, where the two edit at different times,
  is unaffected.
- **Git backup is not available** in the container. It's a desktop-only,
  push-only backup of the plugin's own machine.
