/**
 * Effective backend + blob layout for a sync — the one place that decides how
 * encryption and naming go together.
 *
 * With E2EE off this is the raw backend + the browsable mirror layout. With E2EE
 * on, unlock the vault key (minting the crypto header on first use) and wrap the
 * backend so every blob AND the manifest are encrypted, using the opaque layout.
 * Throws MissingPassphraseError / WrongPassphraseError so callers refuse to sync
 * BEFORE any writes rather than producing garbage (UC10).
 *
 * Shared by the Obsidian plugin (src/main.ts) and the headless client
 * (src/headless/daemon.ts): both MUST pick the wrapping and the layout
 * identically, or they'd read each other's blobs at the wrong keys. Pure — no
 * Obsidian import — so it is unit-testable in Node.
 */
import { type BlobNaming, MirrorNaming, OpaqueNaming } from "../engine/naming.js";
import { CryptoBackend } from "./crypto-backend.js";
import { CRYPTO_HEADER_KEY, unlock } from "./crypto-header.js";
import type { StorageBackend } from "./storage-backend.js";

export interface EncryptionConfig {
  encryptionEnabled: boolean;
  encryptionPassphrase: string;
}

export interface SyncContext {
  backend: StorageBackend;
  naming: BlobNaming;
  /** True if this call minted the crypto header (first device to enable E2EE). */
  initialized: boolean;
}

/**
 * The unlocked vault key, kept for a session. Unlocking costs a header download
 * plus a deliberately slow key derivation (210k PBKDF2 rounds — noticeable on a
 * phone, every sync). The cached key is reused only while the passphrase AND
 * the backend's crypto header (by etag) are unchanged, so a re-keyed backend is
 * never written with a stale key. Scope it to one backend (the caller resets it
 * when the connection settings change).
 */
export interface KeyCache {
  entry: { passphrase: string; headerEtag: string; key: CryptoKey; chunkSize: number } | null;
}

export async function encryptedContext(
  inner: StorageBackend,
  cfg: EncryptionConfig,
  keyCache?: KeyCache,
): Promise<SyncContext> {
  if (!cfg.encryptionEnabled) return { backend: inner, naming: new MirrorNaming(), initialized: false };
  const cached = keyCache?.entry;
  if (cached && cached.passphrase === cfg.encryptionPassphrase && inner.etag) {
    const headerEtag = await inner.etag(CRYPTO_HEADER_KEY);
    if (headerEtag && headerEtag === cached.headerEtag) {
      return { backend: new CryptoBackend(inner, cached.key, cached.chunkSize), naming: new OpaqueNaming(), initialized: false };
    }
  }
  const { key, chunkSize, initialized } = await unlock(inner, cfg.encryptionPassphrase);
  if (keyCache) {
    const headerEtag = inner.etag ? await inner.etag(CRYPTO_HEADER_KEY) : null;
    keyCache.entry = headerEtag ? { passphrase: cfg.encryptionPassphrase, headerEtag, key, chunkSize } : null;
  }
  return { backend: new CryptoBackend(inner, key, chunkSize), naming: new OpaqueNaming(), initialized };
}
