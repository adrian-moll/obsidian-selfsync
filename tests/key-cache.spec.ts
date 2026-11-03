import { describe, expect, it } from "vitest";
import { MemoryBackend } from "../src/backend/storage-backend.js";
import { encryptedContext, type KeyCache } from "../src/backend/context.js";
import { CRYPTO_HEADER_KEY } from "../src/backend/crypto-header.js";
import { dec, enc } from "./support/devices.js";

/** Counts content reads of the crypto header (each one = a full unlock). */
class CountingBackend extends MemoryBackend {
  headerReads = 0;
  async readWithMeta(key: string) {
    if (key === CRYPTO_HEADER_KEY) this.headerReads++;
    return super.readWithMeta(key);
  }
}

const cfg = { encryptionEnabled: true, encryptionPassphrase: "correct horse" };

describe("encryptedContext key cache", () => {
  it("reuses the unlocked key while passphrase and crypto header are unchanged", async () => {
    const backend = new CountingBackend();
    const cache: KeyCache = { entry: null };
    const first = await encryptedContext(backend, cfg, cache);
    await first.backend.write("blob", enc("secret"));
    const reads = backend.headerReads;

    const second = await encryptedContext(backend, cfg, cache);
    expect(backend.headerReads).toBe(reads); // no re-download, no re-derivation
    expect(dec(await second.backend.read("blob"))).toBe("secret");
  });

  it("unlocks again when the passphrase or the header changes", async () => {
    const backend = new CountingBackend();
    const cache: KeyCache = { entry: null };
    await encryptedContext(backend, cfg, cache);
    const reads = backend.headerReads;

    await expect(encryptedContext(backend, { ...cfg, encryptionPassphrase: "wrong" }, cache)).rejects.toThrow();
    expect(backend.headerReads).toBeGreaterThan(reads);

    // The header was rewritten (e.g. re-keyed elsewhere) → its etag changed.
    const header = await backend.read(CRYPTO_HEADER_KEY);
    await backend.write(CRYPTO_HEADER_KEY, header);
    const before = backend.headerReads;
    await encryptedContext(backend, cfg, cache);
    expect(backend.headerReads).toBeGreaterThan(before);
  });
});
