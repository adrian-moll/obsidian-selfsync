# 06 — Backends

A backend is a **dumb blob store**. All intelligence (diff, conflicts,
tombstones, encryption) lives in the engine above it (`05-sync-engine.md`).

## The `StorageBackend` contract

```ts
interface RemoteEntry {
  key: string;        // opaque storage key
  size: number;
  etag?: string;      // version token for optimistic concurrency, if supported
  mtime?: number;
}

interface StorageBackend {
  /** Validate credentials/endpoint; throw with a clear message on failure. */
  testConnection(): Promise<void>;

  /** List all keys under the sync root (for GC and manifest recovery). */
  list(): Promise<RemoteEntry[]>;

  /** Fetch a blob by key. */
  read(key: string): Promise<ArrayBuffer>;

  /** Fetch a blob together with its etag, or null if absent (used for the manifest). */
  readWithMeta(key: string): Promise<{ data: ArrayBuffer; etag?: string } | null>;

  /**
   * Store a blob. If `prevEtag` is given and the backend supports conditional
   * writes, the write must fail if the current etag differs (optimistic
   * concurrency). Returns the new etag/rev.
   */
  write(key: string, data: ArrayBuffer, prevEtag?: string): Promise<string>;

  /** Delete a blob (idempotent). */
  remove(key: string, prevEtag?: string): Promise<void>;

  /** Relocate a blob (server-side rename). Used for moves in both layouts. */
  move(from: string, to: string): Promise<void>;

  /** Feature flags the engine adapts to. */
  capabilities(): { conditionalWrites: boolean };
}
```

The engine stores two kinds of objects through this interface: **content blobs**
(one per file, or per chunk for large files) and the **manifest** (a single
well-known key). Conditional writes matter mainly for the manifest, to detect
concurrent writers (`05-sync-engine.md`).

## Remote layout: mirror vs opaque (D12)

The mapping from vault path to blob key is chosen by a **`BlobNaming`** strategy
(`src/engine/naming.ts`), based on the encryption setting:

- **Mirror (encryption OFF, default):** `blobKey(path) = path` — files are stored
  at their real vault-relative paths under the sync root, so the server folder is
  **browsable and mirrors the vault**. The manifest lives in a hidden
  `.selfsync/manifest.json`.
- **Opaque (encryption ON):** `blobKey(path) = b-<sha256(path)>` — names/paths are
  hidden from the host. The manifest is at `manifest.json`.

The manifest is authoritative in both modes (tombstones, versions, ETags). In
mirror mode it is a metadata index beside browsable content; in opaque mode it also
hides paths. Moves relocate the blob via `StorageBackend.move` whenever the key
changes (mirror: real rename; opaque: cheap server-side rename).

## WebDAV backend (primary — Infomaniak kDrive)

- Maps blob keys to files under a configured sync-root folder on kDrive.
- Uses `PROPFIND` for `list`, `GET` for `read`, `PUT` for `write`, `DELETE` for
  `remove`, `MKCOL` to create folders, and `MOVE` (with `Destination`) for `move`.
- **Nested keys** (mirror layout): keys may contain `/`. The backend URL-encodes
  each segment, creates ancestor folders on demand (`ensureParents` → cached
  `MKCOL`s), and `list()` walks the tree recursively (Depth-1 per folder).
  `MOVE` was confirmed working against real kDrive (backend contract + live e2e).
- **Conditional writes: confirmed usable on kDrive (spike S2, 2026-07-06).** A
  live probe against a real kDrive endpoint verified:
  - Basic auth works with an **app-specific password** (the normal login password
    is rejected); `PROPFIND` returns `207`.
  - `PROPFIND` yields **strong** ETags via `<getetag>` — but XML-entity-encoded
    (`&quot;…&quot;`), so the value **must be decoded** before use as `If-Match`.
  - `If-Match` with the correct ETag succeeds (`204`); with a stale ETag it is
    rejected (`412`). `If-None-Match: *` gives create-only semantics (`412` on
    overwrite).
  - **`PUT` does NOT return an ETag header** → after every upload the backend must
    issue a lightweight follow-up `PROPFIND` to learn the new ETag before
    recording it in the manifest (one extra round-trip per write).
  ⇒ `capabilities().conditionalWrites = true` for kDrive WebDAV; the manifest
  optimistic-concurrency path is used directly (no lock-object fallback needed).
- **Fallback (other WebDAV servers):** for backends that lack usable ETags/
  `If-Match`, fall back to hash-compare before write + a small **lock object** in
  the sync root to serialize manifest updates.
- The probe lives at `scripts/s2-webdav-probe.mjs` and can be re-run against any
  WebDAV endpoint.
- Runs on **all platforms** (mobile-safe: uses Obsidian's `requestUrl` / fetch,
  no Node).
- Transport encryption is HTTPS (kDrive). At-rest confidentiality comes from E2EE
  when enabled (`07-encryption.md`).

## CouchDB backend (self-hosted alternative)

- Used as a **blob store**, not for native replication (see D4).
- Each blob is a CouchDB document (with the content as an attachment, or chunked
  across documents for large files). The document `_rev` serves as the `etag` for
  conditional writes — CouchDB has **first-class conditional writes**
  (`capabilities().conditionalWrites = true`).
- `list` via an `_all_docs` query; `read`/`write`/`remove` via the document API.
- One database per vault.
- Runs on **all platforms** over HTTP(S).

### Docker deployment

Ship a documented `docker-compose.yml` in the repo:

- A single `couchdb` service (persistent volume for data).
- A TLS-terminating reverse proxy (Caddy or Traefik) in front for **encrypted
  transport** — CouchDB itself should not be exposed as plain HTTP over the
  internet.
- HTTP basic auth (optionally a per-device user).
- Notes on backups of the CouchDB volume, and on setting `single_node=true` for a
  simple single-instance setup.

The goal is a copy-paste setup that satisfies the "simple setup" requirement
(NFR6) for self-hosters.

## Adding future backends

Because everything above the interface is backend-agnostic, a new backend (e.g.
S3/MinIO) only needs to implement `StorageBackend`. It automatically inherits
conflict handling, tombstones, chunking, and E2EE.
