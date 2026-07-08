import { describe, expect, it } from "vitest";
import {
  checkVerifier,
  decryptGcm,
  deriveKey,
  encryptGcm,
  IV_BYTES,
  makeVerifier,
  randomSalt,
  TAG_BYTES,
} from "../src/util/crypto.js";
import { utf8 } from "../src/backend/http.js";

const salt = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
// Low iteration count so the test suite stays fast; production uses 210k.
const ITER = 1000;

describe("crypto primitives", () => {
  it("derives the same key deterministically for the same passphrase+salt", async () => {
    const k1 = await deriveKey("correct horse", salt, ITER);
    const k2 = await deriveKey("correct horse", salt, ITER);
    const data = utf8.encode("hello world");
    const ct = await encryptGcm(k1, data);
    // A key derived independently with the same inputs must decrypt the blob.
    expect(utf8.decode(await decryptGcm(k2, ct))).toBe("hello world");
  });

  it("round-trips arbitrary binary content", async () => {
    const key = await deriveKey("pw", salt, ITER);
    const bytes = new Uint8Array(5000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37) % 256;
    const ct = await encryptGcm(key, bytes);
    const pt = new Uint8Array(await decryptGcm(key, ct));
    expect([...pt]).toEqual([...bytes]);
  });

  it("prepends a 12-byte IV and appends a 16-byte tag (overhead = 28)", async () => {
    const key = await deriveKey("pw", salt, ITER);
    const ct = await encryptGcm(key, utf8.encode("abc"));
    expect(ct.byteLength).toBe(IV_BYTES + 3 + TAG_BYTES);
  });

  it("uses a fresh IV each call (same plaintext → different ciphertext)", async () => {
    const key = await deriveKey("pw", salt, ITER);
    const a = new Uint8Array(await encryptGcm(key, utf8.encode("same")));
    const b = new Uint8Array(await encryptGcm(key, utf8.encode("same")));
    expect([...a]).not.toEqual([...b]);
  });

  it("fails to decrypt with the wrong passphrase", async () => {
    const good = await deriveKey("right", salt, ITER);
    const bad = await deriveKey("wrong", salt, ITER);
    const ct = await encryptGcm(good, utf8.encode("secret"));
    await expect(decryptGcm(bad, ct)).rejects.toThrow();
  });

  it("fails to decrypt tampered ciphertext (GCM tag check)", async () => {
    const key = await deriveKey("pw", salt, ITER);
    const ct = new Uint8Array(await encryptGcm(key, utf8.encode("secret")));
    ct[ct.length - 1] ^= 0xff; // flip a tag byte
    await expect(decryptGcm(key, ct)).rejects.toThrow();
  });

  it("rejects a too-short ciphertext instead of calling WebCrypto", async () => {
    const key = await deriveKey("pw", salt, ITER);
    await expect(decryptGcm(key, new Uint8Array(5))).rejects.toThrow(/too short/);
  });

  it("verifier accepts the right key and rejects the wrong one", async () => {
    const key = await deriveKey("passphrase", salt, ITER);
    const v = await makeVerifier(key);
    expect(await checkVerifier(key, v)).toBe(true);

    const wrong = await deriveKey("nope", salt, ITER);
    expect(await checkVerifier(wrong, v)).toBe(false);

    // Different salt → different key → verifier fails (per-vault isolation).
    const otherSalt = await deriveKey("passphrase", randomSalt(), ITER);
    expect(await checkVerifier(otherSalt, v)).toBe(false);
  });

  it("checkVerifier returns false (never throws) on a corrupt verifier blob", async () => {
    const key = await deriveKey("pw", salt, ITER);
    expect(await checkVerifier(key, { blob: "not-base64-ciphertext!!" })).toBe(false);
  });
});
