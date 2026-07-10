/**
 * Large files sync as ONE browsable object at their vault path (mirror layout),
 * and — the bug this guards — a large file that was only DOWNLOADED here (never
 * edited) is NOT reported as "skipped (too large)" on subsequent syncs. That
 * false skip came from the size guard running before the unchanged-file check in
 * scanVault; the fix reorders them so an unchanged file reuses its stored hash
 * (no read, no skip) regardless of size. Downloads of the single object are
 * already streamed (see the resumable-download tests).
 */
import { describe, expect, it } from "vitest";
import { MemoryBackend } from "../src/backend/storage-backend.js";
import { makeDevice } from "./support/devices.js";

const BIG_BYTES = 12 * 1024 * 1024; // > the 8 MiB download-stream chunk

function bigBuffer(): ArrayBuffer {
  const u = new Uint8Array(BIG_BYTES);
  for (let i = 0; i < BIG_BYTES; i++) u[i] = (i * 31 + (i >> 9)) & 0xff;
  return u.buffer;
}
function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

describe("large browsable file", () => {
  it("uploads a large file as one object at its vault path and does NOT re-upload it", async () => {
    const backend = new MemoryBackend();
    const A = makeDevice(backend, "A");
    const B = makeDevice(backend, "B");
    const content = bigBuffer();
    await A.vault.writeBinary("Attachments/big.bin", content);

    const r1 = await A.sync({ useMtimeShortcut: true });
    expect(r1.ops.some((o) => "path" in o && o.path === "Attachments/big.bin")).toBe(true);

    // Stored as ONE browsable blob at the real path — not split into parts.
    const keys = (await backend.list()).map((e) => e.key);
    expect(keys).toContain("Attachments/big.bin");
    expect(keys.some((k) => k.includes("/parts/"))).toBe(false);

    // Nothing changed → zero ops (mtime shortcut; no spurious re-upload).
    const r2 = await A.sync({ useMtimeShortcut: true });
    expect(r2.ops).toHaveLength(0);

    // B receives it byte-for-byte via streamed download.
    const rb = await B.sync();
    expect(rb.failed).toEqual([]);
    expect(sameBytes(await B.vault.readBinary("Attachments/big.bin"), content)).toBe(true);
  });

  it("does NOT report a downloaded-but-unchanged large file as skipped (the phone bug)", async () => {
    // Regression: a 50 MB PDF only ever downloaded (never edited) was reported
    // "Skipped (too large)" every sync because the size guard ran before the
    // unchanged-file check.
    const backend = new MemoryBackend();
    const A = makeDevice(backend, "A"); // "desktop": uploads whole, no cap
    const B = makeDevice(backend, "B"); // "phone": small cap
    const content = bigBuffer();
    await A.vault.writeBinary("big.pdf", content);
    await A.sync({ useMtimeShortcut: true });

    // Phone pulls it (downloads aren't capped) — arrives despite the small cap.
    const r1 = await B.sync({ maxFileBytes: 1024 * 1024, useMtimeShortcut: true });
    expect(r1.skippedLarge).toEqual([]);
    expect(sameBytes(await B.vault.readBinary("big.pdf"), content)).toBe(true);

    // Re-sync on the phone with the same small cap: the unchanged large file must
    // NOT be reported as skipped, and produces no ops.
    const r2 = await B.sync({ maxFileBytes: 1024 * 1024, useMtimeShortcut: true });
    expect(r2.skippedLarge).toEqual([]);
    expect(r2.ops).toHaveLength(0);
  });

  it("still skips a NEW oversized local file (must be read to hash/upload)", async () => {
    const backend = new MemoryBackend();
    const A = makeDevice(backend, "A");
    await A.vault.writeBinary("fresh-big.bin", bigBuffer());
    const r = await A.sync({ maxFileBytes: 1024 * 1024, useMtimeShortcut: true });
    expect(r.skippedLarge).toContain("fresh-big.bin");
  });
});
