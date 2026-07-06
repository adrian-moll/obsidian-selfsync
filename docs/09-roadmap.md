# 09 — Roadmap

## Tech stack

- **Language/build:** TypeScript + esbuild, based on the Obsidian sample-plugin
  template.
- **Sync path (all platforms):** Obsidian `DataAdapter` for vault I/O; **WebCrypto**
  for SHA-256 hashing and AES-256-GCM encryption.
- **Backends:** a small WebDAV client (via Obsidian `requestUrl`) and a CouchDB
  HTTP client.
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
  - 48 tests green.
  - **Crash-safety (NFR1)** is already provided by the engine: atomic conditional
    manifest commit + reconcile-on-startup + "absence is never a deletion". A
    *persistent* journal (faster resume) is deferred — an optimization, not
    required for correctness.
  - **Deferred:** resumable/chunked transfers for very large binaries; the **L4**
    real-device acceptance pass on iPad + Android against kDrive (manual).
- **M3 — E2EE.** Configurable per-backend encryption, path encryption, key
  verifier (with L1/L3 coverage).
- **M4 — CouchDB backend.** Implement the backend + ship `docker-compose.yml` and
  setup docs; add **L2** CouchDB container tests.
- **M5 — Git backup.** Desktop-only versioning via `isomorphic-git`:
  commit-on-change + push; **File-history view** (log/diff/restore); Gitea
  container test.
- **M6 — Polish.** Setup wizard, Sync-view polish, **conflict list + side-by-side
  diff**, **BRAT release + GitHub Actions CI** (runs L1–L3), user docs, and the
  **L4 manual acceptance checklist**.

See `10-ui-integration.md`, `11-deployment.md`, and `12-testing.md` for the detail
behind the UI, release, and testing items woven through these milestones.

## Verification

- **Two-device simulation:** two vaults + two plugin instances against one
  backend; assert convergence for every reconciliation rule in `05-sync-engine.md`.
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
  lock-object fallback required for kDrive. See `06-backends.md`.
- **S3 — State DB storage on mobile.** Choose IndexedDB vs plugin-data JSON for the
  local snapshot, based on size/perf on large vaults.
