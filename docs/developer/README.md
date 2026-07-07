# SelfSync — Developer guide

How SelfSync is built. For installing and using the plugin, see the
[User guide](../user/).

## What it is

A self-built **Obsidian plugin** that syncs and backs up a vault across
**Windows, iPad, and Android** against a **user-controlled WebDAV backend**. It
exists because existing community sync options were unreliable on mobile and/or
fiddly to set up, and because the author wants to control *where* the data lives
(data sovereignty), without a third-party managed service.

## Design pillars

- **Mobile-first reliability.** An interrupted sync (the mobile OS killing the app
  mid-operation) must never corrupt the vault or the remote. The engine is
  crash-safe and reconciles on startup.
- **Data safety over convenience.** Text notes 3-way auto-merge; anything that
  can't merge cleanly becomes a "keep both" copy. Nothing is silently overwritten.
- **One engine, dumb backends.** A single sync engine runs over a thin
  `StorageBackend` abstraction, so every backend behaves identically and there is
  one code path to test.
- **Simple setup.** Sensible defaults and whole-vault sync out of the box.

## Document map

| Doc | Contents |
|-----|----------|
| [requirements.md](requirements.md) | Functional & non-functional requirements. |
| [architecture.md](architecture.md) | Component layout and data flow. |
| [decisions.md](decisions.md) | ADR-style record of locked decisions. |
| [sync-engine.md](sync-engine.md) | State DB, manifest, journal, reconciliation rules. |
| [backends.md](backends.md) | `StorageBackend` contract, WebDAV + Apache mod_dav engineering. |
| [encryption.md](encryption.md) | Planned E2EE scheme, key handling, path privacy. |
| [git-backup.md](git-backup.md) | Desktop-only versioning layer. |
| [ui.md](ui.md) | Status surfaces, conflict UI, file-history view. |
| [testing.md](testing.md) | The L1–L4 test pyramid. |
| [releasing.md](releasing.md) | BRAT distribution, release artifacts, GitHub Actions. |
| [roadmap.md](roadmap.md) | Milestones, spikes, verification. |

## Build & test

Node is vendored under `.tools/` (or use your own). From the repo root:

```bash
npm install       # install dependencies
npm run dev       # esbuild watch → main.js
npm run build     # typecheck + production build
npm test          # run tests (Vitest)
```

Live backend tests are gated on environment variables and skip when unset (CI
stays green): `SELFSYNC_WEBDAV_*` (hosted kDrive) and `SELFSYNC_APACHEDAV_*` (a
local `docker compose up -d webdav` container). See [testing.md](testing.md) and
`.env.local.example`.
