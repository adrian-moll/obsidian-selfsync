# Roadmap

## Tech stack

- **Language/build:** TypeScript + esbuild, based on the Obsidian sample-plugin
  template.
- **Sync path (all platforms):** Obsidian `DataAdapter` for vault I/O; **WebCrypto**
  for SHA-256 hashing and AES-256-GCM encryption.
- **Backend:** a small WebDAV client (via Obsidian `requestUrl`), targeting a
  hosted provider (kDrive) or a self-hosted Apache `mod_dav` server.
- **Git layer (desktop only):** `isomorphic-git`.
- **Distribution:** manual install / **BRAT** initially (personal use); community
  plugin submission optional later.

## Milestones

- **M0 — Scaffold. ✅ DONE.** Plugin skeleton, settings tab, `StorageBackend` +
  **`VaultAdapter`** interfaces, Local State DB, manifest format, journal;
  ribbon-icon + Sync-view skeleton; **L1 unit-test harness** (Vitest). No network
  yet.
- **M1 — WebDAV end-to-end (desktop, no encryption). ✅ DONE.** Full engine against
  kDrive WebDAV: create/edit/delete/rename, manifest with optimistic concurrency,
  keep-both conflicts. Proven by the **L3 two-device simulation** (in-memory) and a
  **live end-to-end sync against real kDrive**. Backend validated by the shared
  `StorageBackend` contract (in-memory + live kDrive). 27 tests green.
  *Remaining for CI parity:* the **L2 WebDAV container** test (needs Docker) so CI
  can run backend tests without kDrive credentials; currently CI relies on the
  in-memory contract + sim, with the live kDrive tests gated/skipped.
- **M1b — Human-readable (mirror) layout. ✅ DONE.** `BlobNaming` strategy
  (`src/engine/naming.ts`): mirror the vault at real paths when encryption is off
  (browsable on kDrive), opaque keys when on. `WebDavBackend` gained nested-key
  support (per-segment encoding, `ensureParents`/`MKCOL`, recursive `list`, `MOVE`);
  `StorageBackend.move`; manifest under `.selfsync/` in mirror mode. Default
  encryption OFF. `MOVE` confirmed against real kDrive. 35 tests green.
- **M2 — Mobile hardening. ◑ IN PROGRESS.**
  - **Done:** single-flight **`SyncScheduler`** (coalesces overlapping requests,
    debounces file changes) + all four triggers wired (startup reconcile via
    `onLayoutReady`, configurable interval, debounced vault-change, best-effort
    `quit`/`visibilitychange`/`blur`); **live status** via `SyncStore` → ribbon,
    status bar, and the Sync view (last sync, backend, layout, activity log,
    conflicts, Sync-now button). 4 scheduler unit tests.
  - **Exclusions (FR8):** default excludes keep device-specific/volatile files out
    of sync — most importantly SelfSync's **own** plugin folder
    (`.obsidian/plugins/selfsync/**`, whose `data.json` differs per device and was
    producing conflict copies), plus Obsidian workspace files and `.trash`. Extra
    globs configurable in settings. Glob matcher + engine filtering, unit-tested.
  - **Bounded conflict auto-retry:** a 412 (another device committed first)
    retries up to 3× with a short delay, so transient startup contention converges
    quietly instead of surfacing.
  - **Copyable activity log** in the Sync view (Copy button + selectable textarea).
  - **3-way auto-merge for text notes (D3 amended):** concurrent edits to
    different regions merge automatically (via a device-local `BaseStore` +
    node-diff3); only overlapping edits keep both. Validated on iPad + Android.
  - 55 tests green.
  - **Crash-safety (NFR1)** is already provided by the engine: atomic conditional
    manifest commit + reconcile-on-startup + "absence is never a deletion". A
    *persistent* journal (faster resume) is deferred — an optimization, not
    required for correctness.
  - **Deferred:** resumable/chunked transfers for very large binaries; the **L4**
    real-device acceptance pass on iPad + Android against kDrive (manual).
- **M3 — E2EE. ✗ NOT STARTED.** The `encryptionEnabled` setting and the opaque
  `BlobNaming` path exist, but no actual encryption is wired yet — enabling it
  today would obscure key names without protecting content. This is the main
  remaining feature. (See `encryption.md` for the intended scheme.)
- **M4 — CouchDB backend. ⌫ REMOVED.** A `CouchDbBackend` was built and validated
  (blob store: one base64 JSON doc per key, `_rev` as the etag) but **removed** once
  M4b landed: as a dumb blob store it only added a second code path, ~33% base64
  inflation, and an ~8 MB `max_document_size` cap that broke large attachments (a
  real 413). Self-hosted WebDAV supersedes it with none of those costs.
- **M4b — Self-hosted WebDAV (Apache `mod_dav`). ✅ DONE.** Rather than maintain a
  separate self-host backend, the single `WebDavBackend` serves both hosted kDrive
  **and** a one-container **Apache `mod_dav`** server — the recommended BYO backend
  for users without a kDrive subscription. Investigation ruled out Caddy-webdav
  (needs a custom build; `golang.org/x/net/webdav` ignores `If-Match` on PUT).
  Apache is the reference impl with strong conditional requests; its only quirk — a
  **weak ETag for ~1s after a write** — is handled by stripping the `W/` prefix
  (`normalizeEtag`), transparent for kDrive. Ships `docker/webdav/` (httpd +
  mod_dav, env-configured auth) as the default `docker-compose` service; Gitea is
  behind an opt-in profile. Gated contract test `tests/webdav-apache.spec.ts`
  (`SELFSYNC_APACHEDAV_*`, `settleMs: 1100`) — 6/6 against a real container.
- **M5 — Git backup. ✅ DONE.** Desktop-only (`Platform.isDesktopApp`) versioning
  via `isomorphic-git` on Node `fs`, dynamically imported so mobile never loads it
  (verified: `require("fs")` sits in a lazy `__esm` closure). `GitBackup`:
  init + seed `.gitignore` (excludes SelfSync's own data), commit-all (skips
  no-ops), push (token auth), log, read-at-commit, restore. Auto-commits after
  each sync (opt-in) + "Git backup: commit now" command. **File-history view**
  lists an active note's commits with View (modal) + Restore. Settings section
  (desktop only). Headless test against a real temp repo (commit/log/restore/
  gitignore); a live Gitea container test is deferred. 58 tests green.
- **M5b — File-history enhancements. ✅ DONE.** Synthetic **Current** entry (live
  working file) atop the commit list; **rendered preview ↔ source toggle**
  (`MarkdownRenderer.render`, so plugin post-processors render); **any-two
  side-by-side diff** (select two entries) + per-row "diff vs current" (reuses the
  tested `lineDiff` via a shared `renderLineDiff`); **follows the active note**;
  richer metadata (relative time, short hash, author); **restore confirmation**.
  67 tests green.
- **M6 — Polish. ◑ IN PROGRESS.**
  - **Done:** live Sync-view; **BRAT release + GitHub Actions CI**; **conflict list
    + side-by-side resolver** — clicking a conflict copy opens a diff (LCS line
    diff) of current vs copy with an editable merged result; saving writes the
    canonical file and deletes the copy, which then syncs. 63 tests green.
  - **Remaining:** first-run setup wizard; user setup guide/docs; the **L4**
    manual acceptance checklist.

See `ui.md`, `releasing.md`, and `testing.md` for the detail
behind the UI, release, and testing items woven through these milestones.

## Verification

- **Two-device simulation:** two vaults + two plugin instances against one
  backend; assert convergence for every reconciliation rule in `sync-engine.md`.
- **Conflict test (UC3):** offline-edit the same file on both → exactly one
  conflict copy, both contents intact.
- **Delete/rename propagation (UC4/UC5):** tombstones honored, no resurrection;
  moves preserve continuity.
- **Kill-mid-sync (UC6/NFR1):** abort during upload → next start reconciles clean,
  no corruption, no half-written manifest.
- **Large binary (UC7):** chunked/resumable transfer completes; hashes match.
- **E2EE (UC10):** backend contents are ciphertext + opaque keys; wrong passphrase
  fails fast via the verifier.
- **Git backup (UC9, desktop):** edits produce commits; an old version can be
  restored.
- **Real devices (acceptance):** clean multi-day sync across Windows + iPad +
  Android against Infomaniak kDrive WebDAV — the original failing scenario.

## Spikes (do early, before locking the design in code)

- **S1 — Mobile lifecycle.** Empirically confirm which of `workspace.on('quit')`,
  `visibilitychange`, and `blur` fire on iOS/Android, and how much flush time is
  available. The design survives none firing (reconcile-on-startup); this only
  tunes the accelerators.
- **S2 — kDrive WebDAV concurrency. ✅ RESOLVED (2026-07-06).** A live probe
  (`scripts/s2-webdav-probe.mjs`) confirmed Infomaniak kDrive returns strong ETags
  (via `PROPFIND`, XML-entity-encoded → must decode) and honors `If-Match` /
  `If-None-Match: *`. Caveat: `PUT` returns no ETag header, so a follow-up
  `PROPFIND` is needed after each write. ⇒ `conditionalWrites = true`; no
  lock-object fallback required for kDrive. See `backends.md`.
- **S3 — State DB storage on mobile.** Choose IndexedDB vs plugin-data JSON for the
  local snapshot, based on size/perf on large vaults.
