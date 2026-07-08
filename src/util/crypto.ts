/**
 * E2EE primitives (M3) — all via WebCrypto, which is available in Obsidian
 * (desktop + mobile) and in Node ≥ 20 / Vitest, so this runs unmodified in tests
 * (NFR4). No Obsidian/Electron imports, so the crypto stays pure and unit-testable.
 *
 * Scheme (see docs/developer/encryption.md):
 *   - Passphrase + per-vault random salt → PBKDF2-SHA256 → AES-256-GCM key.
 *   - Each encryption uses a fresh random 12-byte IV, prepended to the ciphertext
 *     (which carries GCM's 16-byte auth tag). Tampered blobs fail to decrypt.
 *   - A small "verifier" (a known plaintext encrypted under the key) detects a
 *     wrong passphrase BEFORE any sync writes occur.
 *
 * The framed on-disk blob format (header + per-chunk frames, for streaming
 * decrypt of large files) lives in src/backend/crypto-backend.ts and builds on
 * these primitives.
 */
import { arrayBufferToBase64, base64ToArrayBuffer, utf8 } from "../backend/http.js";

/** AES-GCM IV length in bytes (96 bits — the WebCrypto/GCM default). */
export const IV_BYTES = 12;
/** AES-GCM authentication tag length in bytes (128 bits). */
export const TAG_BYTES = 16;
/** Salt length for PBKDF2, in bytes. */
export const SALT_BYTES = 16;

/**
 * PBKDF2 iteration count. OWASP's 2023 floor for PBKDF2-HMAC-SHA256 is 210k; we
 * record the value used in the crypto header so it can be raised later without
 * breaking existing vaults (older blobs keep deriving with their stored count).
 */
export const DEFAULT_PBKDF2_ITERATIONS = 210_000;

/** The known plaintext encrypted under the key to detect a wrong passphrase. */
const VERIFIER_PLAINTEXT = "selfsync-e2ee-verifier-v1";

/** Cryptographically-random bytes (WebCrypto; present in browser and Node ≥ 20). */
export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** A fresh random PBKDF2 salt. */
export function randomSalt(): Uint8Array {
  return randomBytes(SALT_BYTES);
}

/**
 * Derive the AES-256-GCM master key from a passphrase + salt via PBKDF2-SHA256.
 * Deterministic: the same (passphrase, salt, iterations) yields the same key on
 * every device, which is what lets all devices decrypt a shared vault.
 */
export async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    bufferOf(utf8.encode(passphrase)),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: bufferOf(salt), iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false, // non-extractable — the key never leaves WebCrypto
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt `plaintext` under `key`. Output layout: `IV(12) || ciphertext+tag`.
 * A fresh IV is generated per call (never reuse an IV under the same key).
 */
export async function encryptGcm(key: CryptoKey, plaintext: ArrayBuffer | Uint8Array): Promise<ArrayBuffer> {
  const iv = randomBytes(IV_BYTES);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: bufferOf(iv) }, key, bufferOf(plaintext));
  const out = new Uint8Array(IV_BYTES + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), IV_BYTES);
  return out.buffer;
}

/**
 * Decrypt a blob produced by {@link encryptGcm} (`IV(12) || ciphertext+tag`).
 * Throws if the key is wrong or the data was tampered with (GCM tag mismatch).
 */
export async function decryptGcm(key: CryptoKey, data: ArrayBuffer | Uint8Array): Promise<ArrayBuffer> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < IV_BYTES + TAG_BYTES) throw new Error("ciphertext too short");
  const iv = bytes.subarray(0, IV_BYTES);
  const ct = bytes.subarray(IV_BYTES);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: bufferOf(iv) }, key, bufferOf(ct));
}

/** A stored key verifier: the known plaintext encrypted under the derived key. */
export interface KeyVerifier {
  /** Base64 of `IV || ciphertext+tag`. */
  blob: string;
}

/** Encrypt the known verifier plaintext under `key` (stored in the crypto header). */
export async function makeVerifier(key: CryptoKey): Promise<KeyVerifier> {
  const blob = await encryptGcm(key, utf8.encode(VERIFIER_PLAINTEXT));
  return { blob: arrayBufferToBase64(blob) };
}

/**
 * True iff `key` decrypts `verifier` back to the known plaintext — i.e. the
 * passphrase was correct. Never throws; a wrong key / corrupt verifier is `false`.
 */
export async function checkVerifier(key: CryptoKey, verifier: KeyVerifier): Promise<boolean> {
  try {
    const pt = await decryptGcm(key, base64ToArrayBuffer(verifier.blob));
    return utf8.decode(pt) === VERIFIER_PLAINTEXT;
  } catch {
    return false;
  }
}

/**
 * Narrow a Uint8Array/ArrayBuffer to a plain ArrayBuffer-backed BufferSource for
 * crypto.subtle (which rejects SharedArrayBuffer-backed views). Copies only when
 * the view doesn't already span its whole backing ArrayBuffer.
 */
function bufferOf(data: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength && data.buffer instanceof ArrayBuffer) {
    return data.buffer;
  }
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}
