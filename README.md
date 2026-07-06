# SelfSync

Self-hosted, **bring-your-own-backend** sync and backup for [Obsidian](https://obsidian.md).

- **Two-way vault sync** against a backend you control: **WebDAV** (e.g. Infomaniak
  kDrive) or a self-hosted **CouchDB** (single Docker container).
- **Optional end-to-end encryption** — with E2EE on, the host only ever sees
  ciphertext, and file names/paths stay private.
- **Keep-both conflict handling** — nothing is ever silently overwritten.
- **Crash-safe, mobile-first engine** — reconciles on startup; an interrupted sync
  never corrupts the vault or the remote.
- **Optional desktop-only Git backup** — auto-versions your vault to a Git remote,
  with an in-app history/restore view.

> Status: **early development (M0 scaffold).** Not yet functional for real syncing.

## Documentation

The full specification lives in [`docs/`](./docs):

| Doc | Contents |
|-----|----------|
| [00 — Overview](docs/00-overview.md) | What/why, design pillars |
| [01 — Requirements](docs/01-requirements.md) | Functional & non-functional |
| [02 — Use cases](docs/02-use-cases.md) | Concrete scenarios |
| [03 — Architecture](docs/03-architecture.md) | Components & data flow |
| [04 — Technical decisions](docs/04-technical-decisions.md) | ADR-style decisions |
| [05 — Sync engine](docs/05-sync-engine.md) | State DB, manifest, journal, rules |
| [06 — Backends](docs/06-backends.md) | `StorageBackend`, WebDAV, CouchDB |
| [07 — Encryption](docs/07-encryption.md) | E2EE scheme & key handling |
| [08 — Git backup](docs/08-git-backup.md) | Desktop-only versioning |
| [09 — Roadmap](docs/09-roadmap.md) | Milestones, spikes, verification |
| [10 — UI integration](docs/10-ui-integration.md) | Status surfaces, conflict UI |
| [11 — Deployment](docs/11-deployment.md) | BRAT install & releases |
| [12 — Testing](docs/12-testing.md) | Test pyramid |

## Development

```bash
npm install       # install dependencies
npm run dev       # esbuild watch → main.js
npm run build     # typecheck + production build
npm test          # run unit tests (Vitest)
```

## License

MIT © Adrian Moll
