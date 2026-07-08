# Encryption

End-to-end encryption is a **per-backend option**, default **OFF** (D2, amended in
round 3). When enabled, the storage host — your WebDAV server — only ever
sees ciphertext and opaque keys. All primitives come from **WebCrypto**, which is
available on both desktop and mobile (NFR4).

**Layout coupling (D12):** encryption also determines the remote layout. OFF →
files mirror the vault at their real paths (browsable). ON → opaque blob keys hide
names. The `BlobNaming` split (mirror vs opaque) ships in M1b; the content
encryption below (key derivation, AES-GCM, verifier) is implemented in M3. Until
then, enabling the toggle only switches to the opaque layout — it does not yet
encrypt content.

## Threat model

- **Protected against:** a curious or compromised storage host reading note
  content, file names, or folder structure.
- **Not protected against:** a compromised device (the vault is plaintext locally,
  by necessity — Obsidian must read it), or a lost passphrase (there is no
  recovery backdoor).

## Key derivation

- The user provides a **passphrase** during setup.
- A per-vault random **salt** is generated once and stored (unencrypted, it's not
  secret) alongside the manifest.
- The passphrase + salt are run through a slow KDF (**PBKDF2** or **scrypt** via
  WebCrypto) to derive the master key. The KDF cost parameters are recorded so all
  devices derive the same key.
- The passphrase is entered per device at setup; the derived key is cached in
  memory for the session (never written to the backend).

## Content encryption

- Each blob is encrypted with **AES-256-GCM**.
- A **fresh random IV** per encryption operation, prepended to the ciphertext.
- GCM's authentication tag guarantees integrity (tampered blobs fail to decrypt).
- Large downloads are streamed in ranged chunks (`sync-engine.md`). When content
  encryption lands, the format must stream-decrypt (e.g. per-chunk framing) so a
  large blob still never needs to be held whole in memory; this is a design
  constraint for the future E2EE work, not yet implemented.

## Path privacy

- Real vault paths are **never** sent in the clear. Blob keys are opaque (a hash
  or random identifier).
- The mapping from logical path → blob key lives **inside the manifest**, and the
  **entire manifest is encrypted** when E2EE is on. So folder structure and file
  names are confidential too (FR5).

## Key verifier (wrong-passphrase detection — UC10)

- A small, known plaintext (a "verifier") is encrypted with the derived key and
  stored alongside the salt.
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
