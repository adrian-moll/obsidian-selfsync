/**
 * Two-device simulation WITH E2EE (M3): the same core reconciliation outcomes as
 * sync-sim.spec.ts, but both engines sync through a CryptoBackend (shared derived
 * key) over one MemoryBackend, using the opaque layout. Proves the engine is
 * oblivious to encryption AND that nothing readable leaks to the backend at rest.
 */
import { describe, expect, it } from "vitest";
import { MemoryBackend } from "../src/backend/storage-backend.js";
import { CryptoBackend } from "../src/backend/crypto-backend.js";
import { OpaqueNaming } from "../src/engine/naming.js";
import { deriveKey } from "../src/util/crypto.js";
import { dec, enc, makeDevice } from "./support/devices.js";

const salt = new Uint8Array(16).fill(3);
const sharedKey = () => deriveKey("shared-passphrase", salt, 1000);

/** Two devices sharing one encrypted backend (same key), opaque layout. */
async function bootstrap() {
  const raw = new MemoryBackend();
  const key = await sharedKey();
  // Each device gets its own CryptoBackend wrapper (own header cache) over the
  // same underlying store and the same key — exactly like two real devices.
  const A = makeDevice(new CryptoBackend(raw, key), "A", new OpaqueNaming());
  const B = makeDevice(new CryptoBackend(raw, key), "B", new OpaqueNaming());
  await A.vault.writeBinary("note.md", enc("hello"));
  await A.sync();
  await B.sync();
  return { raw, key, A, B };
}

describe("two-device simulation (encrypted)", () => {
  it("propagates a new file A → B through encryption", async () => {
    const { B } = await bootstrap();
    expect(dec(await B.vault.readBinary("note.md"))).toBe("hello");
  });

  it("propagates an edit A → B", async () => {
    const { A, B } = await bootstrap();
    await A.vault.writeBinary("note.md", enc("edited"));
    await A.sync();
    await B.sync();
    expect(dec(await B.vault.readBinary("note.md"))).toBe("edited");
  });

  it("propagates a deletion A → B (no resurrection)", async () => {
    const { A, B } = await bootstrap();
    await A.vault.remove("note.md");
    await A.sync();
    await B.sync();
    expect(await B.vault.exists("note.md")).toBe(false);
    await A.sync();
    expect(await A.vault.exists("note.md")).toBe(false);
  });

  it("propagates a rename A → B as a move (ciphertext relocates)", async () => {
    const { A, B } = await bootstrap();
    await A.vault.rename("note.md", "renamed.md");
    const r = await A.sync();
    expect(r.ops.some((o) => o.kind === "move")).toBe(true);
    await B.sync();
    expect(await B.vault.exists("note.md")).toBe(false);
    expect(dec(await B.vault.readBinary("renamed.md"))).toBe("hello");
  });

  it("keeps both on a concurrent edit conflict", async () => {
    const { A, B } = await bootstrap();
    await A.vault.writeBinary("note.md", enc("A-version"));
    await B.vault.writeBinary("note.md", enc("B-version"));
    await A.sync();
    const r = await B.sync();
    expect(r.ops.some((o) => o.kind === "conflict")).toBe(true);
    // Canonical holds A's version; B's kept as a conflict copy — both intact.
    expect(dec(await B.vault.readBinary("note.md"))).toBe("A-version");
    const copies = (await B.vault.list()).filter((p) => /\(conflict /.test(p));
    expect(copies).toHaveLength(1);
    expect(dec(await B.vault.readBinary(copies[0]))).toBe("B-version");
  });

  it("stores only ciphertext + opaque keys on the backend (path privacy)", async () => {
    const { raw } = await bootstrap();
    await raw
      .list()
      .then((entries) => entries.map((e) => e.key))
      .then((keys) => {
        // No real vault paths appear as keys — only opaque blob keys + manifest.
        expect(keys.some((k) => k.includes("note.md"))).toBe(false);
        expect(keys.some((k) => k === "manifest.json" || k.startsWith("b-"))).toBe(true);
      });

    // No blob's raw bytes contain the plaintext note content or the path.
    for (const { key } of await raw.list()) {
      const text = dec(await raw.read(key));
      expect(text.includes("hello")).toBe(false);
      expect(text.includes("note.md")).toBe(false);
    }
  });

  it("a device with the WRONG key cannot read the shared vault", async () => {
    const { raw } = await bootstrap();
    const wrong = await deriveKey("wrong-passphrase", salt, 1000);
    const C = makeDevice(new CryptoBackend(raw, wrong), "C", new OpaqueNaming());
    // Loading the (encrypted) manifest must fail rather than silently mis-sync.
    await expect(C.sync()).rejects.toThrow();
  });
});
