# 04 — Technical decisions (ADR-style)

Decisions locked with the user during specification. Each entry: the choice, the
context, and the rationale.

## D1 — Self-hostable backend: CouchDB

**Choice:** The self-hostable alternative to WebDAV is **CouchDB**, run as a
single Docker container.

**Rationale:** One container, reliable HTTP semantics, and good behavior over
mobile networks. It is a proven target for Obsidian sync (Self-hosted LiveSync
uses it). We use it as a **blob store** (see D4), not for its native replication.

## D2 — Encryption: configurable per backend (E2EE optional, default OFF)

**Choice:** End-to-end encryption is a per-backend option; the default is **OFF**
(amended in round 3 — was ON).

**Rationale:** Data sovereignty is fundamentally about *where* data lives, which
the user controls regardless of encryption. The user prefers the WebDAV folder to
be human-browsable by default (see D12), and opts into E2EE when they want the
host to see only ciphertext. Optional E2EE still serves less-trusted backends.
See `07-encryption.md`.

## D12 — Remote layout: mirror when unencrypted, opaque when encrypted

**Choice:** The on-backend layout depends on the encryption setting:
- **E2EE off → mirror:** files stored at their real vault paths (browsable on the
  server); manifest in a hidden `.selfsync/` folder.
- **E2EE on → opaque:** blob keys are opaque hashes; real paths live only in the
  (encrypted) manifest.

**Rationale:** Browsable-on-host and encrypted-at-rest are mutually exclusive — the
host cannot hide names it must store. A `BlobNaming` strategy selects the layout
from the encryption setting; the manifest remains the source of truth for
tombstones/versions/ETags in both modes. See `06-backends.md`.

## D3 — Conflict resolution: auto-merge text, else keep both

**Choice:** For text notes, concurrent edits are **3-way auto-merged** when they
touch different regions; only genuinely overlapping edits (or non-text files) fall
back to a **conflict copy** ("keep both"). *(Auto-merge added in M2.x; keep-both
was the original decision.)*

**Rationale:** Never lose data — auto-merge and keep-both are both non-destructive.
Auto-merge removes the friction of conflict copies for the common case (editing
different parts of a note on two devices), which was painful in real multi-device
use. Merging needs the common ancestor, so the last-synced content of text files
is kept device-locally in a `BaseStore` (see `05-sync-engine.md`). Overlaps still
keep both, so nothing is silently resolved incorrectly.

## D4 — Architecture: one unified engine over a thin backend abstraction

**Choice:** A single sync engine runs over a **dumb blob-store** interface;
backends implement only list/read/write/remove.

**Rationale:** Because E2EE (D2) makes content opaque, the backend can't merge it —
so CouchDB's document-level conflict resolution provides little value. With
"keep both" (D3) wanted **everywhere**, a single engine gives consistent behavior
across backends and makes E2EE trivial to implement once. CouchDB still earns its
place as a robust, self-hostable, mobile-friendly blob target — we just don't
depend on its merge semantics.

## D5 — Sync triggers: startup + background/close + interval + debounced-on-change

**Choice:** Sync is driven by all four triggers.

**Rationale:** Directly targets the "mobile unreliable" pain. Because
`Workspace.on('quit')` is documented as **not guaranteed to run** and there is no
documented mobile background event, correctness cannot depend on flush-on-close.
**Reconcile-on-startup** is the backbone; interval, debounce, and best-effort
quit/visibility hooks are accelerators only (see D-note below and NFR1).

## D6 — Sync scope: entire vault

**Choice:** Sync the whole vault (notes + attachments + binaries) by default;
`.obsidian` optionally included; advanced glob excludes available.

**Rationale:** "Just works" with the least configuration (NFR6). Advanced users
can still exclude workspace-local or transient files.

## D7 — Git backup: desktop-only, separate layer

**Choice:** The Git backup is a **desktop-only** feature, independent of the sync
transport, built on **isomorphic-git**.

**Rationale:** Mobile Obsidian cannot run git or shell commands. Git backup is a
**versioning/backup** concern, not part of the sync path, so it is cleanly
separated and gated by `Platform.isDesktopApp`. `isomorphic-git` is pure JS and
bundled, so the user does not need a system git binary. See `08-git-backup.md`.

## Verified API constraints that drove the design

- **`Workspace.on('quit')` exists but is "not guaranteed to run"**, and there is
  **no documented mobile background/suspend event.** ⇒ Reliability is achieved via
  a crash-safe, resumable, reconcile-on-startup engine; close/background hooks are
  best-effort accelerators (D5, NFR1).
- **`DataAdapter`** provides `read`/`write`, `readBinary`/`writeBinary`, `stat`,
  `list`, `exists`, `remove`, `rename`, and atomic `process` — sufficient for
  vault-wide, binary-safe sync on **mobile**. Node `fs`/`child_process` are
  desktop-only and reserved for the Git layer (D7).

## Deferred / to be resolved by spikes

- **S1** — Which mobile lifecycle events actually fire (tunes D5 accelerators).
- **S2** — Whether Infomaniak kDrive WebDAV supports usable etags / `If-Match`
  conditional writes (affects manifest concurrency strategy; see `06-backends.md`).
- **S3** — Local State DB storage: IndexedDB vs plugin-data JSON on large vaults.
