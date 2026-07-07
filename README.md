# SelfSync

Self-hosted, **bring-your-own-backend** sync and backup for [Obsidian](https://obsidian.md).

- **Two-way vault sync** against a **WebDAV** backend you control: either a hosted
  provider (e.g. Infomaniak kDrive) or a self-hosted server in one Docker container
  (Apache `mod_dav`).
- **Smart conflict handling** — concurrent edits to different parts of a note
  auto-merge (3-way); only overlapping edits keep both. Nothing is silently lost.
- **Crash-safe, mobile-first engine** — reconciles on startup; an interrupted sync
  never corrupts the vault or the remote.
- **Optional desktop-only Git backup** — auto-versions your vault to a Git remote,
  with an in-app history/restore view.
- **Optional end-to-end encryption** *(planned, not yet available)* — with E2EE on,
  the host would see only ciphertext and file names/paths stay private.

> Status: **working (desktop).** WebDAV sync against real kDrive **and** a
> self-hosted Apache `mod_dav` container — create / edit / delete / rename /
> auto-merge + keep-both conflicts — plus the trigger model (startup / interval /
> on-change / background), a live status panel, and desktop Git backup.
> **Encryption (M3)** and the mobile acceptance pass remain in progress.

## Install

SelfSync isn't in the community plugin store; install it with **BRAT**
([Beta Reviewer's Auto-update Tool](https://github.com/TfTHacker/obsidian42-brat)),
which works on desktop **and** mobile and auto-updates:

1. Install and enable **BRAT** from Community Plugins.
2. BRAT → **Add beta plugin** → enter `adrian-moll/obsidian-selfsync`.
3. Enable **SelfSync** in Community Plugins.
4. Repeat on each device (Windows, iPad, Android).

Then open **Settings → SelfSync**: set your WebDAV URL, username, and password
(for kDrive, an **app-specific password**), and a sync folder. Open the **SelfSync**
panel from the ribbon and hit **Sync now**. Full walkthrough in the
[**User guide**](docs/user/).

<details><summary>Manual install (fallback)</summary>

Copy `main.js`, `manifest.json`, and `styles.css` from the
[latest release](https://github.com/adrian-moll/obsidian-selfsync/releases) into
`<vault>/.obsidian/plugins/selfsync/`, then enable the plugin.
</details>

> Note: `.obsidian` config sync is **off by default** (it churns across devices).
> Notes and attachments sync; enable config sync in settings if you want it.

## Documentation

- 📘 [**User guide**](docs/user/) — install, set up a backend (including a
  self-hosted WebDAV server), and use the plugin day to day.
- 🛠️ [**Developer guide**](docs/developer/) — architecture, sync engine, the
  `StorageBackend` contract, technical decisions, testing, and roadmap.

## Development

```bash
npm install       # install dependencies
npm run dev       # esbuild watch → main.js
npm run build     # typecheck + production build
npm test          # run unit tests (Vitest)
```

## License

MIT © Adrian Moll
