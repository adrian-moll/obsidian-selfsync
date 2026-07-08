# Architecture

## Component layout

```
Obsidian Plugin (TypeScript, esbuild)
├─ UI: settings tab, setup wizard, status bar, "Sync now" command, conflict list
├─ Sync Engine (platform-agnostic core)
│   ├─ Change detector  (vault scan via DataAdapter: path, size, mtime, SHA-256)
│   ├─ Local State DB   (last-synced snapshot per file: base for 3-way merge)
│   ├─ Reconciler       (3-way diff → op list; conflict = keep-both)
│   └─ Transfer manager (streamed ranged download; per-op resilient; retries)
├─ Crypto layer (WebCrypto)   ← optional E2EE, wraps blobs + path map
├─ Remote Manifest/Index      ← the source of truth for "what exists remotely"
├─ Backend abstraction  interface StorageBackend
│   └─ WebDavBackend   (hosted kDrive or self-hosted Apache mod_dav)
└─ Git Backup module (DESKTOP ONLY, Node)  ← isomorphic-git, separate from sync
```

## Key idea: unified engine over dumb backends

Everything above the `StorageBackend` line — change detection, the manifest,
conflict handling, tombstones, and E2EE — is **backend-agnostic**. A backend only
has to store, fetch, list, and delete opaque blobs (see `backends.md`). This
means:

- Any backend behaves **identically** from the engine's perspective (only
  `WebDavBackend` ships today; hosted kDrive and self-hosted Apache `mod_dav` are
  the same code path).
- "Keep both" conflict handling and E2EE are implemented **once**.
- Adding a future backend (e.g. S3) is a matter of implementing one small
  interface.

We deliberately keep the backend a **dumb blob store** and do all merging in the
engine — with E2EE the content is opaque, so a server could not merge it anyway
(see `decisions.md`, D4).

## Platform boundaries

- **Sync path** (all platforms): uses only the Obsidian `DataAdapter` for vault
  I/O and **WebCrypto** for hashing/encryption. Both are available on mobile.
- **Git layer** (desktop only): the only place Node/`isomorphic-git` is used;
  gated by `Platform.isDesktopApp` and hidden on mobile.

## Data flow (one sync cycle)

1. **Trigger** fires (startup / interval / debounced change / manual / best-effort
   quit).
2. **Read remote manifest** (with its etag/rev) from the backend.
3. **Scan local vault** via `DataAdapter` → current paths, sizes, mtimes, and
   SHA-256 hashes (mtime used to skip re-hashing unchanged files).
4. **Reconcile** three inputs — current local state, the last-synced **State DB**
   snapshot (the merge base), and the **manifest** — into an ordered **op list**
   (upload / download / delete / move / conflict-copy).
5. **Journal** the op list before executing (crash safety).
6. **Execute** ops through the transfer manager (encrypting/decrypting blobs if
   E2EE is on), updating the manifest.
7. **Commit manifest** with a conditional write (etag/rev). On conflict (another
   device wrote first), re-read and re-reconcile.
8. **Update State DB** to the new synced snapshot; clear the journal.

See `sync-engine.md` for the reconciliation rules and crash-safety details.

## Persistent state

- **Local State DB** — per-file last-synced snapshot (merge base). Stored in
  **IndexedDB** (`IndexedDbStateStore`: in-memory mirror, only changed keys written
  per flush), with a **JSON fallback** (`JsonStateStore` → `data.json`) when
  IndexedDB is unavailable. Namespaced per vault; safe to lose (reconcile rebuilds).
- **Remote manifest** — authoritative map of logical path → blob; lives on the
  backend, encrypted when E2EE is on.
- **Plugin settings** — WebDAV endpoint + credentials, `secretStorage` mode, E2EE
  toggle, trigger config, exclude globs, Git settings. Persisted via Obsidian's
  `loadData`/`saveData` (`data.json`).

### Secret storage at rest

The WebDAV password and Git token are protected in `data.json` per the
`secretStorage` setting (`plaintext` / `obfuscated` / `keychain`, default
`keychain`). Values are stored **self-describing** so decode dispatches on a prefix
and always works regardless of mode or device: `obf:v1:…` (reversible XOR — casual
protection only), `kc:v1:…` (Electron `safeStorage`, desktop OS keychain), or
unprefixed (plaintext, incl. legacy). `src/util/secret-store.ts` is Obsidian/Electron-free
and unit-tested; the desktop keychain lives in `src/util/keychain-desktop.ts`,
lazily imported behind a `Platform.isDesktopApp` guard (mirroring `git-backup.ts`)
and injected as a `KeychainProvider`. Decode happens in `loadPersisted` (in-memory
settings hold plaintext for auth); encode happens on a copy in `savePersisted`.
Keychain unavailable → falls back to obfuscation; a `kc:` value that can't be
decrypted here decodes to `""` (user re-enters). A passphrase mode is deferred to
M3 (it would require an unlock prompt, breaking unattended sync).
