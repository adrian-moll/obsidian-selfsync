/**
 * Content hashing via WebCrypto — available both in Obsidian (desktop + mobile)
 * and in Node ≥ 20 / Vitest, so it runs unmodified in tests.
 */

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/** SHA-256 hex digest of the given bytes. */
export async function sha256(data: ArrayBuffer | Uint8Array): Promise<string> {
  const view = data instanceof Uint8Array ? data : new Uint8Array(data);
  // Copy into a fresh, ArrayBuffer-backed array so the value is a plain
  // BufferSource (not possibly SharedArrayBuffer-backed) for crypto.subtle.
  const bytes = new Uint8Array(view.byteLength);
  bytes.set(view);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(digest);
}
