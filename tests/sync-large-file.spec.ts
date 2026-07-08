/**
 * The max-file-size guard. It caps only what we hold WHOLE in memory: uploads and
 * the non-streamed download fallback. Oversized LOCAL files are never uploaded and
 * — critically — never treated as a deletion. Downloads stream in ranged chunks,
 * so large REMOTE files are pulled regardless of the cap (see the download tests).
 */
import { describe, expect, it } from "vitest";
import {
  MemoryBackend,
  type BackendCapabilities,
  type ReadResult,
  type RemoteEntry,
  type StorageBackend,
} from "../src/backend/storage-backend.js";
import { dec, enc, makeDevice } from "./support/devices.js";

/** A backend with NO ranged-read support (no head/readRange), forcing the
 *  whole-blob download fallback — like a server that ignores Range requests. */
class NoRangeBackend implements StorageBackend {
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

const SMALL = "hi";
const BIG = "x".repeat(1000);

/** A buffer larger than one download chunk (8 MiB), to exercise streaming. */
function bigBuffer(): ArrayBuffer {
  const n = 9 * 1024 * 1024 + 77;
  const u = new Uint8Array(n);
  for (let i = 0; i < n; i++) u[i] = (i * 31) & 0xff;
  return u.buffer;
}
function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

describe("max file size guard", () => {
  it("skips a new oversized local file (never uploads it) but syncs small ones", async () => {
    const backend = new MemoryBackend();
    const A = makeDevice(backend, "A");
    const B = makeDevice(backend, "B");
    await A.vault.writeBinary("small.md", enc(SMALL));
    await A.vault.writeBinary("big.bin", enc(BIG));

    const r = await A.sync({ maxFileBytes: 100 });
    expect(r.skippedLarge).toContain("big.bin");
    expect(r.ops.some((o) => "path" in o && o.path === "big.bin")).toBe(false);

    await B.sync({ maxFileBytes: 100 });
    expect(await B.vault.exists("small.md")).toBe(true);
    expect(await B.vault.exists("big.bin")).toBe(false); // never propagated
  });

  it("does NOT delete a previously-synced file that later exceeds the limit", async () => {
    const backend = new MemoryBackend();
    const A = makeDevice(backend, "A");
    const B = makeDevice(backend, "B");
    // Sync a small file normally on both devices.
    await A.vault.writeBinary("note.md", enc(SMALL));
    await A.sync();
    await B.sync();
    expect(await B.vault.exists("note.md")).toBe(true);

    // It grows large on A; A now runs with a size cap.
    await A.vault.writeBinary("note.md", enc(BIG));
    const r = await A.sync({ maxFileBytes: 100 });
    expect(r.skippedLarge).toContain("note.md");
    // No deleteRemote/upload was emitted for it — it's simply left alone.
    expect(r.ops).toHaveLength(0);

    // B (no cap) still sees the OLD content — the remote was untouched, not deleted.
    const rb = await B.sync();
    expect(rb.ops.some((o) => o.kind === "deleteLocal")).toBe(false);
    expect(await B.vault.exists("note.md")).toBe(true);
    expect(dec(await B.vault.readBinary("note.md"))).toBe(SMALL);
  });

  it("DOWNLOADS an oversized remote file via streaming (the cap is upload-only)", async () => {
    const backend = new MemoryBackend();
    const A = makeDevice(backend, "A");
    const B = makeDevice(backend, "B");
    const content = bigBuffer(); // > 8 MiB → streamed
    await A.vault.writeBinary("big.bin", content);
    await A.sync();

    // B syncs WITH a small cap → downloads are streamed, so it still arrives and
    // is not reported as skipped.
    const rb = await B.sync({ maxFileBytes: 1024 * 1024 });
    expect(rb.skippedLarge).not.toContain("big.bin");
    expect(await B.vault.exists("big.bin")).toBe(true);
    expect(sameBytes(await B.vault.readBinary("big.bin"), content)).toBe(true);
  });

  it("reports (does not crash on) an over-cap remote file when the server has no range support", async () => {
    const inner = new MemoryBackend();
    const A = makeDevice(inner, "A");
    await A.vault.writeBinary("big.bin", bigBuffer()); // > 8 MiB, > cap below
    await A.sync();

    // B's backend can't do ranged reads and the blob exceeds the whole-in-memory
    // cap, so it must be reported as failed (retry next cycle), never read whole.
    const B = makeDevice(new NoRangeBackend(inner), "B");
    const rb = await B.sync({ maxFileBytes: 1024 * 1024 });
    expect(rb.committed).toBe(false);
    expect(rb.failed).toContain("big.bin");
    expect(await B.vault.exists("big.bin")).toBe(false);
  });
});
