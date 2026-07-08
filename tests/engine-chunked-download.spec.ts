/**
 * Large downloads must stream to disk in ranged chunks (appendBinary), never a
 * single whole-blob read — the fix for the Android OOM crash on a 49 MB file.
 * Verifies the streamed file is byte-identical and that the whole-blob read path
 * is not used for large blobs.
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

/** Deterministic binary buffer with a non-repeating-per-256 pattern to catch
 *  chunk misordering/off-by-one assembly bugs. */
function bytes(n: number): ArrayBuffer {
  const u = new Uint8Array(n);
  for (let i = 0; i < n; i++) u[i] = (i * 7 + (i >> 8)) & 0xff;
  return u.buffer;
}

function equalBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** Delegating backend that counts whole-blob reads vs ranged reads. */
class CountingBackend implements StorageBackend {
  reads = 0;
  ranged = 0;
  heads = 0;
  constructor(private readonly inner: MemoryBackend) {}
  testConnection() {
    return this.inner.testConnection();
  }
  list(): Promise<RemoteEntry[]> {
    return this.inner.list();
  }
  read(key: string): Promise<ArrayBuffer> {
    this.reads++;
    return this.inner.read(key);
  }
  readWithMeta(key: string): Promise<ReadResult | null> {
    return this.inner.readWithMeta(key);
  }
  async head(key: string) {
    this.heads++;
    return this.inner.head(key);
  }
  readRange(key: string, start: number, end: number): Promise<ArrayBuffer> {
    this.ranged++;
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
}

describe("chunked large-file download", () => {
  it("streams a >8 MB blob in ranged chunks and reassembles it byte-for-byte", async () => {
    const backend = new CountingBackend(new MemoryBackend());
    const size = 20 * 1024 * 1024 + 123; // 20 MB + tail, not a chunk multiple
    const content = bytes(size);

    // Device A uploads the big file.
    const a = makeDevice(backend, "A");
    await a.vault.writeBinary("big/photo.raw", content);
    const up = await a.sync();
    expect(up.committed).toBe(true);

    // Device B downloads it — must use the chunked (ranged) path.
    const b = makeDevice(backend, "B");
    backend.reads = 0;
    backend.ranged = 0;
    backend.heads = 0;
    const down = await b.sync();

    expect(down.committed).toBe(true);
    const got = await b.vault.readBinary("big/photo.raw");
    expect(equalBytes(got, content)).toBe(true);

    // Streamed: 3 ranged reads (8+8+~4 MB), one head, zero whole-blob reads.
    expect(backend.ranged).toBe(Math.ceil(size / (8 * 1024 * 1024)));
    expect(backend.heads).toBe(1);
    expect(backend.reads).toBe(0);
  });

  it("still uses a single read for small blobs", async () => {
    const backend = new CountingBackend(new MemoryBackend());
    const a = makeDevice(backend, "A");
    await a.vault.writeBinary("small.bin", bytes(1024));
    await a.sync();

    const b = makeDevice(backend, "B");
    backend.reads = 0;
    backend.ranged = 0;
    await b.sync();

    const got = await b.vault.readBinary("small.bin");
    expect(equalBytes(got, bytes(1024))).toBe(true);
    expect(backend.ranged).toBe(0);
    expect(backend.reads).toBe(1);
  });
});
