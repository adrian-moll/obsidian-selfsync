import { describe, expect, it } from "vitest";
import { MemoryBackend } from "../src/backend/storage-backend.js";
import { CryptoBackend, frameCount, HEADER_BYTES, parseHeader } from "../src/backend/crypto-backend.js";
import { deriveKey } from "../src/util/crypto.js";
import { utf8 } from "../src/backend/http.js";

const salt = new Uint8Array(16).fill(7);
const key = async () => deriveKey("passphrase", salt, 1000);

/** Random-ish but deterministic bytes so a failure is reproducible. */
function bytes(n: number): ArrayBuffer {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 131 + 17) % 256;
  return b.buffer;
}

const eq = (a: ArrayBuffer, b: ArrayBuffer): boolean => {
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
};

describe("CryptoBackend", () => {
  it("round-trips a blob through write/read", async () => {
    const crypt = new CryptoBackend(new MemoryBackend(), await key());
    const data = utf8.encode("hello, encrypted world");
    await crypt.write("k", data);
    expect(eq(await crypt.read("k"), data)).toBe(true);
  });

  it("stores ciphertext at rest — no plaintext leaks to the inner backend", async () => {
    const inner = new MemoryBackend();
    const crypt = new CryptoBackend(inner, await key());
    await crypt.write("secret.md", utf8.encode("TOP SECRET NOTE"));

    const stored = new Uint8Array(await inner.read("secret.md"));
    const asText = utf8.decode(stored.buffer);
    expect(asText.includes("TOP SECRET NOTE")).toBe(false);
    // The stored blob is a framed SSE1 container, larger than the plaintext.
    expect(stored.byteLength).toBeGreaterThan("TOP SECRET NOTE".length);
    expect(parseHeader(stored).plainSize).toBe("TOP SECRET NOTE".length);
  });

  it("readWithMeta returns decrypted data + the inner etag, null for a missing key", async () => {
    const crypt = new CryptoBackend(new MemoryBackend(), await key());
    expect(await crypt.readWithMeta("nope")).toBeNull();
    const etag = await crypt.write("k", utf8.encode("v"));
    const r = await crypt.readWithMeta("k");
    expect(r?.etag).toBe(etag);
    expect(utf8.decode(r!.data)).toBe("v");
  });

  it("head reports the PLAINTEXT size (not the ciphertext size)", async () => {
    const inner = new MemoryBackend();
    const crypt = new CryptoBackend(inner, await key());
    const data = bytes(3000);
    await crypt.write("k", data);
    const h = await crypt.head("k");
    expect(h?.size).toBe(3000);
    // Inner stored size is larger (header + per-frame IV/tag overhead).
    expect((await inner.head("k"))!.size).toBeGreaterThan(3000);
  });

  it("head returns null for a missing key", async () => {
    const crypt = new CryptoBackend(new MemoryBackend(), await key());
    expect(await crypt.head("gone")).toBeNull();
  });

  it("readRange over a multi-frame blob returns the exact plaintext slice", async () => {
    const C = 1024; // small chunk so a modest blob spans many frames
    const inner = new MemoryBackend();
    const crypt = new CryptoBackend(inner, await key(), C);
    const P = 10_000; // ~10 frames
    const data = bytes(P);
    await crypt.write("k", data);
    expect(frameCount(P, C)).toBe(Math.ceil(P / C));

    const full = new Uint8Array(data);
    const ranges: [number, number][] = [
      [0, 0], // single byte
      [0, C - 1], // exactly frame 0
      [0, C], // frame boundary crossing
      [C - 1, C + 1], // straddles frames 0/1
      [500, 5000], // spans several frames, unaligned
      [P - 1, P - 1], // last byte
      [0, P - 1], // whole file via range
    ];
    for (const [s, e] of ranges) {
      const got = new Uint8Array(await crypt.readRange("k", s, e));
      expect([...got], `range ${s}..${e}`).toEqual([...full.subarray(s, e + 1)]);
    }
  });

  it("streamed range reads reassemble to the original (simulating the engine's loop)", async () => {
    const C = 4096;
    const inner = new MemoryBackend();
    const crypt = new CryptoBackend(inner, await key(), C);
    const P = 40_000;
    const data = bytes(P);
    await crypt.write("big", data);

    const meta = await crypt.head("big");
    expect(meta?.acceptRanges).toBe(true);
    const total = meta!.size;
    const STREAM_CHUNK = 8192; // engine reads in larger chunks than the crypto frame
    const out = new Uint8Array(total);
    let offset = 0;
    while (offset < total) {
      const end = Math.min(offset + STREAM_CHUNK, total) - 1;
      const part = new Uint8Array(await crypt.readRange("big", offset, end));
      out.set(part, offset);
      offset = end + 1;
    }
    expect([...out]).toEqual([...new Uint8Array(data)]);
  });

  it("handles empty and single-byte blobs", async () => {
    const crypt = new CryptoBackend(new MemoryBackend(), await key());
    await crypt.write("empty", new ArrayBuffer(0));
    expect((await crypt.read("empty")).byteLength).toBe(0);
    expect((await crypt.head("empty"))?.size).toBe(0);

    await crypt.write("one", utf8.encode("x"));
    expect(utf8.decode(await crypt.read("one"))).toBe("x");
  });

  it("write header records the chunk size and plaintext length", async () => {
    const inner = new MemoryBackend();
    const crypt = new CryptoBackend(inner, await key(), 2048);
    await crypt.write("k", bytes(5000));
    const stored = await inner.read("k");
    const h = parseHeader(stored);
    expect(h.version).toBe(1);
    expect(h.chunkSize).toBe(2048);
    expect(h.plainSize).toBe(5000);
    expect(stored.byteLength).toBeGreaterThanOrEqual(HEADER_BYTES);
  });

  it("propagates conditional-write failures from the inner backend", async () => {
    const inner = new MemoryBackend();
    const crypt = new CryptoBackend(inner, await key());
    const etag = await crypt.write("k", utf8.encode("v1"));
    await expect(crypt.write("k", utf8.encode("v2"), "stale-etag")).rejects.toThrow();
    // Correct etag succeeds.
    await expect(crypt.write("k", utf8.encode("v2"), etag)).resolves.toBeTruthy();
  });

  it("decrypting a tampered stored blob fails (integrity)", async () => {
    const inner = new MemoryBackend();
    const crypt = new CryptoBackend(inner, await key());
    await crypt.write("k", utf8.encode("important"));
    const stored = new Uint8Array(await inner.read("k"));
    stored[stored.length - 1] ^= 0xff; // corrupt the last frame's tag
    await inner.write("k", stored.buffer);
    await expect(crypt.read("k")).rejects.toThrow();
  });
});
