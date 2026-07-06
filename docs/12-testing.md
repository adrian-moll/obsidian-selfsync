# 12 — Testing strategy

Goal: automate everything that *can* be automated with confidence, and be honest
about what must stay manual (D11 / FR15). The plan is a **test pyramid backed by
containers**.

## Testability hinge: the `VaultAdapter` abstraction

The sync engine must never call Obsidian APIs directly. Instead it talks to a
small interface we own:

```ts
interface VaultAdapter {
  list(): Promise<string[]>;                 // vault-relative paths
  stat(path: string): Promise<{ size: number; mtime: number } | null>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}
```

- **In the app:** an implementation delegating to Obsidian's `DataAdapter`.
- **In tests:** a **Node-fs** or **in-memory** implementation.

Because crypto uses **WebCrypto** (available in Node ≥ 20 and Vitest), the E2EE
code runs unmodified in tests. This one abstraction is what makes L1–L3 possible
without Obsidian.

## L1 — Unit tests (fast, no containers)

Pure logic, run with **Vitest**:

- **Reconciliation rules** — feed synthetic `(local, base, remote)` triples and
  assert the produced op list for every row of the rule table (`05-sync-engine.md`).
- **Manifest merge & optimistic-concurrency** logic.
- **Rename detection** (hash-match → move vs delete+create fallback).
- **Journal** — replay of an incomplete journal produces a clean converged state.
- **Crypto** — AES-GCM encrypt→decrypt round-trip; key derivation determinism;
  **key verifier** accepts the right passphrase and rejects wrong ones.

## L2 — Backend contract tests (Testcontainers)

One shared **`StorageBackend` conformance suite** (list/read/write/remove,
conditional-write semantics, large blobs) run against each real backend spun up
via **Testcontainers**:

- **CouchDB** — official `couchdb` image; verifies `_rev`-based conditional writes.
- **WebDAV** — a WebDAV server container (e.g. `rclone serve webdav` or a
  sabre-dav image); verifies generic WebDAV semantics.
- **Gitea** — `gitea/gitea` container as a push target for the Git-backup layer
  (`08-git-backup.md`): commit → push → clone-and-verify.

**Caveat (honest):** Infomaniak kDrive's specific ETag / `If-Match` behavior
(spike **S2** in `09-roadmap.md`) cannot be reproduced in a container. Generic
WebDAV conformance is automated; the kDrive-specific concurrency check is part of
**L4 manual**.

## L3 — Two-device simulation (headless engine E2E)

The core integration test. Two engine instances, each with its own in-memory/tmp
`VaultAdapter`, pointed at **one real containerized backend**. Scripted scenarios
assert **convergence** and data safety:

- Every reconciliation rule (create/edit/download/no-op).
- **Conflict keep-both** (UC3): offline edits on both → exactly one conflict copy,
  both contents intact.
- **Delete & rename propagation** (UC4/UC5): tombstones honored, no resurrection;
  moves preserve continuity.
- **Kill-mid-sync** (UC6/NFR1): abort a transfer partway, restart the engine →
  journal replay yields a clean, uncorrupted, fully converged state; no
  half-written manifest.
- **Resumable large binary** (UC7): interrupted chunked transfer resumes; final
  hash matches.
- **E2EE round-trip** (UC10): with encryption on, backend blobs are ciphertext
  with opaque keys; a second device with the right passphrase decrypts correctly;
  a wrong passphrase fails fast with no writes.

## L4 — Manual acceptance (cannot be automated reliably)

Documented checklist, run on real hardware:

- **Obsidian UI** on desktop: ribbon/status-bar/Notices states, Sync view,
  conflict diff, file-history restore.
- **Mobile lifecycle** (spike S1): behavior on iPad and Android across app
  suspend/kill/relaunch; confirm reconcile-on-startup recovers cleanly.
- **Real kDrive WebDAV** (spike S2): ETag/concurrency behavior and a multi-day
  three-device soak — the original failing scenario.

## Continuous integration

- **GitHub Actions** runs **L1–L3** on every push/PR (the runner supports
  Testcontainers/Docker). A green pipeline gates releases (`11-deployment.md`).
- **L4** is a manual checklist executed before tagging significant releases.

## Coverage summary

| Layer | Automated? | Where |
|-------|-----------|-------|
| Engine logic, crypto | ✅ | L1 (CI) |
| Backend semantics (CouchDB, WebDAV, Gitea) | ✅ | L2 (CI, containers) |
| Multi-device convergence, crash safety, E2EE | ✅ | L3 (CI, containers) |
| Obsidian UI behavior | ❌ manual | L4 |
| Mobile lifecycle, real kDrive quirks | ❌ manual | L4 |
