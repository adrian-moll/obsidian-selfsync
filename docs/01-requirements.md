# 01 — Requirements

## Functional requirements

- **FR1 — Full-vault two-way sync.** Sync the entire vault (markdown, attachments,
  arbitrary binaries) between each device and the selected backend, in both
  directions.
- **FR2 — Pluggable backend.** The user chooses one backend in settings:
  **WebDAV** (primary, Infomaniak kDrive) or **CouchDB** (self-hosted). Both are
  driven by the same sync engine.
- **FR3 — Full change set propagation.** Reliably propagate creates, edits,
  **deletes**, and **renames/moves** — not just content changes.
- **FR4 — Conflict handling (keep both).** When the same file is edited on two
  devices, write a conflict copy (e.g. `note (conflict <device> <timestamp>).md`)
  and preserve both versions. Never silently overwrite.
- **FR5 — Optional end-to-end encryption.** Per backend, the user may enable E2EE
  so that file **content and paths** are encrypted on-device before upload.
- **FR6 — Sync triggers.** Sync runs: on startup, on a configurable interval,
  debounced after file changes, and best-effort on app background/quit.
- **FR7 — Manual sync + status.** A "Sync now" command plus a status indicator
  (idle / syncing / error / conflicts present).
- **FR8 — Scope control.** Whole vault by default, minus built-in default excludes
  (SelfSync's own `.obsidian/plugins/selfsync/**`, Obsidian workspace files,
  `.trash`) that would otherwise cause per-device conflicts. Extra glob excludes
  are configurable in settings but not required to get started. *(Implemented in
  M2.)*
- **FR9 — Desktop-only Git backup.** Optionally auto-commit vault changes to a Git
  remote for versioning, independent of the sync backend.
- **FR10 — Setup wizard.** A first-run flow: pick backend → enter credentials →
  set/enter E2EE passphrase → test connection → run initial sync. As few steps as
  possible.
- **FR11 — Status surfaces.** A **ribbon icon** (desktop + mobile) and a
  **desktop status bar** item reflect state (idle / syncing / error / conflicts).
  A **Sync sidebar view** shows last-sync time, active backend, current ops,
  recent activity, and errors with retry. Notices for errors and new conflicts.
  (Status bar is unavailable on mobile, so the ribbon + Sync view carry state.)
- **FR12 — Conflict panel.** The Sync view lists conflict copies; selecting one
  opens a **side-by-side diff** of the two versions for manual merge, then
  dismiss. No automatic merge.
- **FR13 — File-history view (desktop-only).** For the active note: list Git
  commits → diff a chosen version against current → **restore** it (writes back
  into the vault, then syncs normally).
- **FR14 — Distribution & release.** Installable via **BRAT** from a GitHub repo
  (tagged releases carry `main.js` + `manifest.json` + `styles.css`; repo-root
  `manifest.json` + `versions.json` for compatibility). Manual-copy fallback.
- **FR15 — Automated test suite.** Unit tests for engine/crypto, containerized
  backend contract tests, and a headless two-device simulation, runnable in CI.

## Non-functional requirements

- **NFR1 — Mobile-first reliability.** A sync interrupted by a process kill must
  never corrupt the local vault or the remote. It resumes/reconciles on next
  start. This is the top priority (addresses the primary past failure).
- **NFR2 — Data safety over convenience.** Prefer conflict copies to data loss.
  All remote mutations are atomic or recoverable.
- **NFR3 — Performance on large vaults.** Content-hash change detection, transfer
  only what changed, chunked/resumable transfers for large binaries.
- **NFR4 — Cross-platform, single codebase.** Windows, iPadOS, Android. The sync
  path uses only WebCrypto and the Obsidian `DataAdapter` (both mobile-safe). Node
  APIs are confined to the desktop-only Git layer.
- **NFR5 — Data sovereignty.** No mandatory third-party service. All endpoints are
  user-controlled. With E2EE, the host sees only ciphertext.
- **NFR6 — Simple, low-config setup.** Sensible defaults; the happy path needs
  minimal configuration.

## Explicit non-goals (initial versions)

- Real-time collaborative editing (multiple cursors in one document).
- Server-side search or web access to the vault.
- Automatic three-way *text* merging (we keep both copies; user merges manually).
- Git backup on mobile (not feasible; desktop-only by design).
