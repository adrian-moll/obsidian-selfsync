# Backends

A backend is a **dumb blob store**. All intelligence (diff, conflicts,
tombstones, encryption) lives in the engine above it (`sync-engine.md`).

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
(one per file) and the **manifest** (a single well-known key). Large downloads
read a blob in byte ranges via the optional `head`/`readRange` methods (streamed
to disk); the blob itself is still a single object. Conditional writes matter
mainly for the manifest, to detect concurrent writers (`sync-engine.md`).

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

## WebDAV backend (primary — hosted kDrive *or* self-hosted Apache)

The single WebDAV backend serves two deployments from the same code:

- **Hosted:** Infomaniak kDrive (or any WebDAV provider), for users who already
  have one.
- **Self-hosted:** Apache `mod_dav` in one Docker container — the recommended
  bring-your-own-backend for users **without** a kDrive subscription. `mod_dav` is
  the reference WebDAV implementation and is the one common self-hostable server
  with the **strong `If-Match` conditional-request** support the manifest commit
  relies on. Both pass the identical `StorageBackend` contract (see live tests
  `tests/webdav-backend.spec.ts` @ kDrive and `tests/webdav-apache.spec.ts` @
  Apache). This is why there's no separate self-host backend — one backend, no
  extra code, browsable files on the server, and no per-file size cap.

- Maps blob keys to files under a configured sync-root folder on the server.
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
- **Weak ETags (Apache `mod_dav`).** `mod_dav` marks a file's ETag **weak**
  (`W/"…"`) for ~1s after it changes (its mtime can't prove the bytes won't change
  again within the same second), and a strong `If-Match` never matches a weak tag
  → conditional writes would `412` forever. The weak and strong forms carry the
  same opaque value, so `parseEtag` **strips the `W/` prefix** (`normalizeEtag` in
  `webdav-backend.ts`); once a file settles (>1s old) its strong ETag matches the
  stored value. Real manifest commits are naturally spaced further apart than that
  window, and the engine's bounded 412-retry covers any sub-second collision.
  Harmless for kDrive, whose ETags are already strong. The gated contract test
  uses `settleMs: 1100` to model this spacing.
- **Fallback (other WebDAV servers):** for backends that lack usable ETags/
  `If-Match`, fall back to hash-compare before write + a small **lock object** in
  the sync root to serialize manifest updates. (Not needed for kDrive or Apache.)
- The probe lives at `scripts/s2-webdav-probe.mjs` and can be re-run against any
  WebDAV endpoint.
- Runs on **all platforms** (mobile-safe: uses Obsidian's `requestUrl` / fetch,
  no Node).
- Transport encryption is HTTPS. kDrive provides it; for self-hosted Apache, put
  it behind a TLS-terminating reverse proxy (Caddy/Traefik) — mobile Obsidian
  effectively requires HTTPS. At-rest confidentiality comes from E2EE when enabled
  (`encryption.md`).

### Self-hosted deployment (Apache `mod_dav`)

`docker/webdav/` builds a stock `httpd:2.4` image with `mod_dav` enabled and
basic-auth credentials generated from `WEBDAV_USER`/`WEBDAV_PASSWORD` at startup;
`docker/docker-compose.yml` wires it as the default `webdav` service (data on a
named volume). Bring it up with `docker compose up -d webdav`, then in SelfSync
set the backend to **WebDAV**, URL `http://<host>:8080`, and those credentials.
Put a TLS proxy in front for any non-localhost use.

## Adding future backends

Because everything above the interface is backend-agnostic, a new backend (e.g.
S3/MinIO) only needs to implement `StorageBackend`. It automatically inherits
conflict handling, tombstones, chunking, and E2EE.
