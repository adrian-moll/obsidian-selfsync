/**
 * Resumable downloads: a large download interrupted mid-stream (network drop or
 * app kill) must RESUME from where it left off on the next sync, not restart from
 * byte 0. A remote blob that changed since the partial was staged must be detected
 * (etag guard) and re-downloaded cleanly. A clean download leaves no staging residue.
 */
import { describe, expect, it } from "vitest";
import {
  MemoryBackend,
  type BackendCapabilities,
  type ReadResult,
  type RemoteEntry,
  type StorageBackend,
} from "../src/backend/storage-backend.js";
import { makeDevice } from "./support/devices.js";

function bigBuffer(seed = 7): ArrayBuffer {
  const n = 20 * 1024 * 1024 + 321; // > 2 chunks (8 MiB each) + a tail
  const u = new Uint8Array(n);
  for (let i = 0; i < n; i++) u[i] = (i * seed + (i >> 9)) & 0xff;
  return u.buffer;
}
function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** Delegating backend that can fail readRange after N calls and records offsets. */
class FlakyRangeBackend implements StorageBackend {
  failAfter = Infinity; // throw once the (N+1)th readRange is reached
  private calls = 0;
  rangeStarts: number[] = [];
  constructor(private readonly inner: MemoryBackend) {}
  testConnection() {
    return this.inner.testConnection();
  }
  list(): Promise<RemoteEntry[]> {
    return this.inner.list();
  }
  read(key: string): Promise<ArrayBuffer> {
    return this.inner.read(key);
  }
  readWithMeta(key: string): Promise<ReadResult | null> {
    return this.inner.readWithMeta(key);
  }
  head(key: string) {
    return this.inner.head(key);
  }
  async readRange(key: string, start: number, end: number): Promise<ArrayBuffer> {
    if (this.calls >= this.failAfter) throw new Error("simulated network drop");
    this.calls++;
    this.rangeStarts.push(start);
    return this.inner.readRange(key, start, end);
  }
  write(key: string, data: ArrayBuffer, prevEtag?: string): Promise<string> {
    return this.inner.write(key, data, prevEtag);
  }
  remove(key: string, prevEtag?: string): Promise<void> {
    return this.inner.remove(key, prevEtag);
  }
  move(from: string, to: string): Promise<void> {
    return this.inner.move(from, to);
  }
  capabilities(): BackendCapabilities {
    return this.inner.capabilities();
  }
  reset() {
    this.calls = 0;
    this.rangeStarts = [];
    this.failAfter = Infinity;
  }
}

const CHUNK = 8 * 1024 * 1024;
const stagingCount = async (vault: { list(): Promise<string[]> }): Promise<number> =>
  (await vault.list()).filter((p) => p.startsWith(".obsidian/plugins/selfsync/incoming/")).length;

describe("resumable downloads", () => {
  it("resumes from the staged offset instead of restarting after an interruption", async () => {
    const inner = new MemoryBackend();
    const content = bigBuffer();
    const A = makeDevice(inner, "A");
    await A.vault.writeBinary("big.bin", content);
    await A.sync();

    const flaky = new FlakyRangeBackend(inner);
    const B = makeDevice(flaky, "B");

    // First attempt: allow 2 chunks (16 MiB staged) then drop the connection.
    flaky.failAfter = 2;
    const r1 = await B.sync();
    expect(r1.failed).toContain("big.bin");
    expect(await B.vault.exists("big.bin")).toBe(false);
    expect(await stagingCount(B.vault)).toBeGreaterThan(0); // partial kept

    // Second attempt: healthy backend → must resume from 16 MiB, not 0.
    flaky.reset();
    const r2 = await B.sync();
    expect(r2.failed).toEqual([]);
    expect(await B.vault.exists("big.bin")).toBe(true);
    expect(sameBytes(await B.vault.readBinary("big.bin"), content)).toBe(true);
    expect(flaky.rangeStarts[0]).toBe(2 * CHUNK); // resumed, didn't refetch [0,16MiB)
    expect(Math.min(...flaky.rangeStarts)).toBe(2 * CHUNK);
    expect(await stagingCount(B.vault)).toBe(0); // staging cleaned up on finalize
  });

  it("discards the partial and restarts when the remote blob changed (etag guard)", async () => {
    const inner = new MemoryBackend();
    const A = makeDevice(inner, "A");
    await A.vault.writeBinary("big.bin", bigBuffer(7));
    await A.sync();

    const flaky = new FlakyRangeBackend(inner);
    const B = makeDevice(flaky, "B");
    flaky.failAfter = 2;
    await B.sync(); // partial staged for v1
    expect(await stagingCount(B.vault)).toBeGreaterThan(0);

    // A replaces the file with different content → new etag on the blob.
    const v2 = bigBuffer(19);
    await A.vault.writeBinary("big.bin", v2);
    await A.sync();

    // B resumes: etag mismatch → discard partial, re-download from 0 → gets v2.
    flaky.reset();
    const r = await B.sync();
    expect(r.failed).toEqual([]);
    expect(flaky.rangeStarts[0]).toBe(0); // restarted, not resumed
    expect(sameBytes(await B.vault.readBinary("big.bin"), v2)).toBe(true);
    expect(await stagingCount(B.vault)).toBe(0);
  });

  it("a clean large download leaves no staging residue", async () => {
    const inner = new MemoryBackend();
    const content = bigBuffer();
    const A = makeDevice(inner, "A");
    await A.vault.writeBinary("big.bin", content);
    await A.sync();

    const B = makeDevice(inner, "B");
    await B.sync();
    expect(sameBytes(await B.vault.readBinary("big.bin"), content)).toBe(true);
    expect(await stagingCount(B.vault)).toBe(0);
  });
});
