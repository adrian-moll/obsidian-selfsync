/**
 * The E2EE crypto header (`crypto.json`) and the unlock flow (M3).
 *
 * The header is stored UNENCRYPTED on the backend — it carries the per-vault salt
 * and KDF parameters every device needs to derive the shared key, plus a verifier
 * (a known plaintext encrypted under that key). It reveals nothing sensitive: no
 * content, no paths. Everything else on the backend is ciphertext.
 *
 * `unlock` is the single entry point:
 *   - header present → derive the key from the entered passphrase + stored salt,
 *     then check the verifier. A wrong passphrase throws WrongPassphraseError
 *     BEFORE any sync writes (UC10) rather than producing garbage.
 *   - header absent → this device initializes E2EE: generate a salt, derive, write
 *     the header, then RE-READ it and adopt whatever actually landed (so two
 *     devices enabling at once converge on one salt instead of silently diverging).
 */
import type { StorageBackend } from "./storage-backend.js";
import { arrayBufferToBase64, base64ToArrayBuffer, utf8 } from "./http.js";
import {
  checkVerifier,
  DEFAULT_PBKDF2_ITERATIONS,
  deriveKey,
  type KeyVerifier,
  makeVerifier,
  randomSalt,
} from "../util/crypto.js";
import { DEFAULT_CHUNK_BYTES } from "./crypto-backend.js";

/** Backend key of the unencrypted crypto header. Distinct from the manifest key. */
export const CRYPTO_HEADER_KEY = "crypto.json";

export interface CryptoHeader {
  formatVersion: number;
  kdf: { algo: "PBKDF2-SHA256"; iterations: number; salt: string /* base64 */ };
  cipher: "AES-256-GCM";
  /** Plaintext bytes per frame in the blob format (see crypto-backend.ts). */
  chunkSize: number;
  verifier: KeyVerifier;
}

/** Thrown when the entered passphrase doesn't match the vault's stored verifier. */
export class WrongPassphraseError extends Error {
  constructor() {
    super("Wrong encryption passphrase for this backend.");
    this.name = "WrongPassphraseError";
  }
}

/** Thrown when E2EE is enabled but no passphrase has been entered. */
export class MissingPassphraseError extends Error {
  constructor() {
    super("Encryption is enabled but no passphrase is set.");
    this.name = "MissingPassphraseError";
  }
}

export interface Unlocked {
  key: CryptoKey;
  chunkSize: number;
  /** True if this call created the header (first device to enable E2EE). */
  initialized: boolean;
}

/** Read the crypto header, or null if E2EE hasn't been initialized on this backend. */
export async function loadCryptoHeader(backend: StorageBackend): Promise<CryptoHeader | null> {
  const res = await backend.readWithMeta(CRYPTO_HEADER_KEY);
  if (!res) return null;
  return JSON.parse(utf8.decode(res.data)) as CryptoHeader;
}

/**
 * Derive and verify the vault key from `passphrase`, initializing the header on
 * first use. Throws {@link MissingPassphraseError} / {@link WrongPassphraseError}
 * so the caller can refuse to sync before any writes occur.
 */
export async function unlock(backend: StorageBackend, passphrase: string): Promise<Unlocked> {
  if (!passphrase) throw new MissingPassphraseError();

  let header = await loadCryptoHeader(backend);
  let initialized = false;

  if (!header) {
    // First device to enable E2EE: mint a header. Write unconditionally, then
    // re-read so that if another device won a simultaneous init we adopt its
    // salt rather than keeping our orphaned one.
    header = await mint(passphrase);
    await backend.write(CRYPTO_HEADER_KEY, utf8.encode(JSON.stringify(header)));
    const landed = await loadCryptoHeader(backend);
    if (landed) header = landed;
    initialized = true;
  }

  const salt = new Uint8Array(base64ToArrayBuffer(header.kdf.salt));
  const key = await deriveKey(passphrase, salt, header.kdf.iterations);
  if (!(await checkVerifier(key, header.verifier))) throw new WrongPassphraseError();

  return { key, chunkSize: header.chunkSize, initialized };
}

async function mint(passphrase: string): Promise<CryptoHeader> {
  const salt = randomSalt();
  const iterations = DEFAULT_PBKDF2_ITERATIONS;
  const key = await deriveKey(passphrase, salt, iterations);
  return {
    formatVersion: 1,
    kdf: { algo: "PBKDF2-SHA256", iterations, salt: arrayBufferToBase64(bufferOf(salt)) },
    cipher: "AES-256-GCM",
    chunkSize: DEFAULT_CHUNK_BYTES,
    verifier: await makeVerifier(key),
  };
}

function bufferOf(u: Uint8Array): ArrayBuffer {
  const b = new ArrayBuffer(u.byteLength);
  new Uint8Array(b).set(u);
  return b;
}
