import { describe, expect, it } from "vitest";
import { MemoryBackend } from "../src/backend/storage-backend.js";
import {
  CRYPTO_HEADER_KEY,
  loadCryptoHeader,
  MissingPassphraseError,
  unlock,
  WrongPassphraseError,
} from "../src/backend/crypto-header.js";
import { CryptoBackend } from "../src/backend/crypto-backend.js";
import { utf8 } from "../src/backend/http.js";

describe("crypto header / unlock", () => {
  it("initializes the header on first unlock, then reuses it", async () => {
    const backend = new MemoryBackend();
    expect(await loadCryptoHeader(backend)).toBeNull();

    const first = await unlock(backend, "hunter2");
    expect(first.initialized).toBe(true);
    const header = await loadCryptoHeader(backend);
    expect(header?.kdf.algo).toBe("PBKDF2-SHA256");
    expect(header?.cipher).toBe("AES-256-GCM");
    expect(header?.verifier.blob).toBeTruthy();

    const second = await unlock(backend, "hunter2");
    expect(second.initialized).toBe(false);
  });

  it("derives the SAME working key on two devices from one passphrase", async () => {
    const backend = new MemoryBackend();
    const a = await unlock(backend, "shared-pass"); // device A initializes
    const b = await unlock(backend, "shared-pass"); // device B joins

    // Prove the keys are interchangeable: encrypt with A's, decrypt with B's.
    const ca = new CryptoBackend(new MemoryBackend(), a.key);
    // Write via A's key into a store, then read back via a CryptoBackend using B's
    // key over the SAME store.
    const store = new MemoryBackend();
    await new CryptoBackend(store, a.key).write("k", utf8.encode("payload"));
    const viaB = await new CryptoBackend(store, b.key).read("k");
    expect(utf8.decode(viaB)).toBe("payload");
    void ca;
  });

  it("throws WrongPassphraseError for a bad passphrase (before any writes)", async () => {
    const backend = new MemoryBackend();
    await unlock(backend, "correct");
    await expect(unlock(backend, "incorrect")).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it("throws MissingPassphraseError for an empty passphrase", async () => {
    const backend = new MemoryBackend();
    await expect(unlock(backend, "")).rejects.toBeInstanceOf(MissingPassphraseError);
  });

  it("stores the header under a key distinct from the manifest", async () => {
    const backend = new MemoryBackend();
    await unlock(backend, "pw");
    const keys = (await backend.list()).map((e) => e.key);
    expect(keys).toContain(CRYPTO_HEADER_KEY);
    expect(CRYPTO_HEADER_KEY).not.toBe("manifest.json");
  });
});
