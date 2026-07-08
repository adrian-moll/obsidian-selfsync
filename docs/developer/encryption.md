# Encryption

End-to-end encryption is a **per-backend option**, default **OFF** (D2, amended in
round 3). When enabled, the storage host — your WebDAV server — only ever
sees ciphertext and opaque keys. All primitives come from **WebCrypto**, which is
available on both desktop and mobile (NFR4).

**Layout coupling (D12):** encryption also determines the remote layout. OFF →
files mirror the vault at their real paths (browsable). ON → opaque blob keys hide
names. The `BlobNaming` split (mirror vs opaque) ships in M1b; the content
encryption below (key derivation, AES-GCM, verifier, framed streaming) is
**implemented in M3** (`src/util/crypto.ts`, `src/backend/crypto-backend.ts`,
`src/backend/crypto-header.ts`).

## Implementation (M3)

Encryption is a **`StorageBackend` decorator**, `CryptoBackend`, that wraps the
WebDAV backend when E2EE is on. The engine above it is oblivious to encryption —
it still deals in logical paths and *plaintext* sizes/hashes:

- **Content + manifest.** Every blob is written encrypted; because the manifest is
  just another blob written through the same backend, it is encrypted too — so the
  path → blob-key map (and thus all file names and folder structure) is confidential
  (path privacy, below). `contentHash` and `entry.size` in the manifest stay
  *plaintext* values, so change-detection, merge, and the size/skip logic are
  unaffected.
- **Framed blob format ("SSE1").** A blob is a 17-byte header (magic, version,
  chunk size `C`, plaintext length `P`) followed by frames of `min(C, …)` plaintext
  bytes each, individually AES-GCM-sealed (own 12-byte IV + 16-byte tag). Every
  frame but the last is exactly `C` bytes, so frame `k` always begins at
  `header + k·(C+28)` — that fixed stride lets a plaintext byte offset map to a
  frame in O(1).
- **Streaming decrypt.** `CryptoBackend.head` reports the plaintext size and
  `readRange` accepts a **plaintext** byte range, works out which frames cover it,
  fetches just those frames in one ranged GET, decrypts, and returns the requested
  slice. So the engine's streamed-download loop (ranged reads → `appendBinary`,
  with resume) works unchanged and large encrypted files still stream without
  being held whole in memory — the mobile OOM constraint noted below is satisfied.
- **Uploads** are already read whole (bounded by **Max file size**), so they are
  frame-encrypted in memory and written in one PUT.

**Switching modes on an existing backend.** Enabling encryption changes both the
layout (mirror → opaque) and the manifest key, so the engine sees a fresh remote
and re-uploads the vault encrypted; the old plaintext blobs are orphaned (safe, but
not auto-removed). Recommend a fresh sync folder when turning E2EE on. Passphrase
*rotation* (re-encrypting under a new key) remains a later, explicit action.

## Threat model

- **Protected against:** a curious or compromised storage host reading note
  content, file names, or folder structure.
- **Not protected against:** a compromised device (the vault is plaintext locally,
  by necessity — Obsidian must read it), or a lost passphrase (there is no
  recovery backdoor).

## Key derivation

- The user provides a **passphrase** during setup.
- A per-vault random **salt** is generated once and stored (unencrypted, it's not
  secret) in a small **`crypto.json`** header blob on the backend, alongside the
  KDF parameters and the verifier.
- The passphrase + salt are run through **PBKDF2-SHA256** (WebCrypto, 210k
  iterations by default) to derive the AES-256-GCM master key. The iteration count
  is recorded in `crypto.json` so all devices derive the same key and it can be
  raised later without breaking existing vaults.
- The passphrase is set per device in settings and stored at rest like the other
  secrets (device keychain by default). It is **not** re-prompted per launch —
  background/interval/startup syncs run with no UI, so the key must be derivable
  without interaction. The derived key itself is never written to the backend.

## Content encryption

- Each blob is encrypted with **AES-256-GCM**.
- A **fresh random IV** per encryption operation, prepended to the ciphertext.
- GCM's authentication tag guarantees integrity (tampered blobs fail to decrypt).
- Large downloads are streamed in ranged chunks (`sync-engine.md`). The framed
  "SSE1" format (above) stream-decrypts per frame, so a large encrypted blob is
  never held whole in memory — the design constraint this section called for is
  satisfied by `CryptoBackend`.

## Path privacy

- Real vault paths are **never** sent in the clear. Blob keys are opaque (a hash
  or random identifier).
- The mapping from logical path → blob key lives **inside the manifest**, and the
  **entire manifest is encrypted** when E2EE is on. So folder structure and file
  names are confidential too (FR5).

## Key verifier (wrong-passphrase detection — UC10)

- A small, known plaintext (a "verifier") is encrypted with the derived key and
  stored alongside the salt in `crypto.json`.
- On unlock, the device tries to decrypt the verifier. Success ⇒ correct
  passphrase; failure ⇒ a clear, immediate error **before** any sync writes occur.
- This prevents a wrong passphrase from producing partial or garbage writes
  (NFR2).

## When E2EE is off (the default)

- Blobs and the manifest are stored as plaintext, and files mirror the vault at
  their real paths so the server folder is **browsable** (D12). Confidentiality
  relies on transport TLS and trust in the host.
- This is the default: data sovereignty comes from controlling *where* data lives,
  and the user gets a browsable copy of their vault on kDrive. E2EE is opt-in per
  backend for less-trusted hosts.

## Open considerations

- **Passphrase rotation:** re-encrypting all blobs under a new key is an expensive
  operation; provide it as an explicit, deliberate action rather than an automatic
  one. (Scoped for a later milestone.)
- **Key strength UX:** the setup wizard should encourage a strong passphrase and
  warn that it cannot be recovered.
