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
import { unlock } from "./crypto-header.js";
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

export async function encryptedContext(inner: StorageBackend, cfg: EncryptionConfig): Promise<SyncContext> {
  if (!cfg.encryptionEnabled) return { backend: inner, naming: new MirrorNaming(), initialized: false };
  const { key, chunkSize, initialized } = await unlock(inner, cfg.encryptionPassphrase);
  return { backend: new CryptoBackend(inner, key, chunkSize), naming: new OpaqueNaming(), initialized };
}
