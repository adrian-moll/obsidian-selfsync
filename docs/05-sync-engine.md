# 05 — Sync engine

The sync engine is backend-agnostic. It orchestrates change detection,
reconciliation, crash-safe execution, and manifest updates. It talks to storage
only through the `StorageBackend` interface (`06-backends.md`) and to crypto only
through the crypto layer (`07-encryption.md`).

## The three inputs to a sync

A sync is a three-way comparison:

1. **Local (current)** — the vault right now, scanned via `DataAdapter`
   (`list` + `stat` + content hash).
2. **Base (last synced)** — the **Local State DB** snapshot: what this device
   believed was in sync last time. This is the merge base.
3. **Remote** — the **manifest** fetched from the backend.

Comparing *current vs base* tells us what changed **locally**; comparing
*manifest vs base* tells us what changed **remotely**. Combining both yields the
correct action for each file.

## Local State DB

Per-file record forming the merge base:

```ts
interface StateEntry {
  path: string;          // logical vault-relative path
  contentHash: string;   // SHA-256 of file content at last sync
  size: number;
  mtime: number;         // used to skip re-hashing unchanged files
  version: number;       // manifest version last seen for this file
  blobKey: string;       // opaque backend key at last sync
  deleted?: boolean;     // tombstone known-synced
}
```

Storage backend for this DB is spike **S3** (IndexedDB vs plugin-data JSON).

## Remote manifest

A single object on the backend, the **source of truth for "what exists
remotely."** Encrypted as a whole when E2EE is on.

```ts
interface Manifest {
  formatVersion: number;
  updatedBy: string;              // device id of last writer
  entries: Record<string, {       // key = logical vault path
    contentHash: string;
    version: number;              // monotonically bumped per change
    blobKey: string;             // opaque; where the content blob lives
    size: number;
    mtime: number;
    deleted?: boolean;           // tombstone (delete propagation)
  }>;
}
```

Why a manifest at all: a blob store cannot answer "what changed?", and a
*missing* remote file is ambiguous (never uploaded vs deleted elsewhere). The
manifest makes existence, deletions (tombstones), and renames **explicit and
propagatable** (UC4/UC5). Content blobs are stored separately from the manifest so
large files aren't rewritten when only metadata changes.

## Reconciliation rules

For each logical path, compare **local (L)**, **base (B)**, **remote/manifest (R)**:

| Condition | Action |
|-----------|--------|
| L changed vs B, R == B | **Upload** L (new blob, bump version) |
| R changed vs B, L == B | **Download** R |
| L changed **and** R changed, `hash(L) != hash(R)` | **Conflict → keep both** |
| L changed **and** R changed, `hash(L) == hash(R)` | Converged → update base only |
| L deleted, R == B | **Tombstone in manifest + remove blob** |
| R tombstoned, L == B | **Delete locally** |
| L deleted **and** R deleted | Reconcile base to deleted; no-op |
| L deleted, R changed | **Conflict → restore R as conflict copy** (safety) |
| new path, hash matches an existing tombstoned/removed path | **Rename/move** (rewrite manifest key, no re-upload) |
| L == B == R | No-op |

**Keep-both (conflict) procedure:** keep the incoming remote version at the
canonical path and write the local version to a conflict copy, e.g.
`note (conflict <device> <ISO-timestamp>).md`. Both are then tracked normally so
the conflict copy also syncs out. Nothing is overwritten (FR4, NFR2).

**Rename detection:** a file whose content hash equals a recently
removed/tombstoned entry's hash is treated as a move rather than delete+create,
preserving continuity (UC5). Renames are best-effort; if undetected, the fallback
is a correct (if less efficient) delete+create.

## Crash safety and mobile reliability (NFR1)

The engine assumes it can be killed at any instant (mobile OS suspends/terminates
the app). Guarantees:

1. **Journal-before-execute.** The full op list is written to a **journal** before
   any transfer runs. On startup, an incomplete journal is replayed/reconciled
   *before* normal sync begins (UC6).
2. **Atomic, conditional manifest writes.** The manifest is committed with an
   `If-Match`/rev precondition (or a lock object where conditional writes aren't
   supported — spike S2). A killed upload can leave an **orphan blob** but never a
   half-updated manifest. Orphans are garbage-collected on a later pass.
3. **Content-addressed blobs.** Blobs are keyed by content hash (or random key
   recorded in the manifest), so a re-run of an interrupted upload is idempotent.
4. **Reconcile-on-startup is the backbone.** Interval, debounce, and best-effort
   quit/visibility hooks only make convergence faster; none are required for
   correctness.

## Transfer manager

- Transfers only changed blobs (hash-based change detection, NFR3).
- **Chunked, resumable** uploads/downloads for large binaries (UC7): a blob is
  split into fixed-size chunks recorded in the manifest entry; partially
  transferred chunks resume rather than restart.
- Retries with backoff on transient network errors; surfaces persistent errors to
  the status indicator (FR7).

## Triggers (D5 / FR6)

- **On startup** — full reconcile (backbone).
- **Periodic interval** — configurable, while the app is open.
- **Debounced on file change** — near-live upload after edits settle.
- **Best-effort on background/quit** — via `workspace.on('quit')`,
  `visibilitychange`, and `blur`; treated as accelerators only (spike S1).
- **Manual** — the "Sync now" command.
