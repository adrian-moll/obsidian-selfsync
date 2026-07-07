/**
 * The max-file-size guard (the Android large-file crash fix). Oversized files must
 * never be read into memory, never propagate, and — critically — never be treated
 * as a deletion just because they were skipped locally.
 */
import { describe, expect, it } from "vitest";
import { MemoryBackend } from "../src/backend/storage-backend.js";
import { dec, enc, makeDevice } from "./support/devices.js";

const SMALL = "hi";
const BIG = "x".repeat(1000);

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

  it("skips downloading an oversized remote file (would OOM on the receiver too)", async () => {
    const backend = new MemoryBackend();
    const A = makeDevice(backend, "A");
    const B = makeDevice(backend, "B");
    // A uploads a big file with NO cap.
    await A.vault.writeBinary("big.bin", enc(BIG));
    await A.sync();

    // B syncs WITH a cap → must not pull the oversized blob.
    const rb = await B.sync({ maxFileBytes: 100 });
    expect(rb.skippedLarge).toContain("big.bin");
    expect(await B.vault.exists("big.bin")).toBe(false);
  });
});
