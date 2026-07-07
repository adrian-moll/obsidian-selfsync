/**
 * Two-device auto-merge simulation: concurrent edits to DIFFERENT regions of a
 * note merge automatically (no conflict copy); edits to the SAME region fall back
 * to keep-both. Exercises the engine + BaseStore + 3-way merge end to end.
 */
import { describe, expect, it } from "vitest";
import { MemoryBackend } from "../src/backend/storage-backend.js";
import { dec, enc, makeDevice } from "./support/devices.js";

const NOTE = "note.md";
const BASE = "# Title\n\nalpha\n\nbeta\n\ngamma\n";

async function bootstrap() {
  const backend = new MemoryBackend();
  const A = makeDevice(backend, "A");
  const B = makeDevice(backend, "B");
  await A.vault.writeBinary(NOTE, enc(BASE));
  await A.sync(); // A uploads; base stored on A
  await B.sync(); // B downloads; base stored on B
  return { backend, A, B };
}

describe("two-device auto-merge", () => {
  it("auto-merges concurrent edits to different regions (no conflict copy)", async () => {
    const { A, B } = await bootstrap();

    await A.vault.writeBinary(NOTE, enc(BASE.replace("alpha", "alpha EDITED-BY-A")));
    await B.vault.writeBinary(NOTE, enc(BASE.replace("gamma", "gamma EDITED-BY-B")));

    await A.sync(); // A uploads its version
    const r = await B.sync(); // B detects concurrent edit → 3-way merge

    expect(r.merged).toContain(NOTE);
    expect(r.conflictCopies).toHaveLength(0);
    const mergedOnB = dec(await B.vault.readBinary(NOTE));
    expect(mergedOnB).toContain("alpha EDITED-BY-A");
    expect(mergedOnB).toContain("gamma EDITED-BY-B");

    // No conflict-copy files were created.
    const copies = (await B.vault.list()).filter((p) => p.includes("(conflict"));
    expect(copies).toHaveLength(0);

    // A converges to the merged version on its next sync.
    await A.sync();
    const mergedOnA = dec(await A.vault.readBinary(NOTE));
    expect(mergedOnA).toBe(mergedOnB);
  });

  it("falls back to keep-both when the same region is edited on both", async () => {
    const { A, B } = await bootstrap();

    await A.vault.writeBinary(NOTE, enc(BASE.replace("beta", "beta — VERSION A")));
    await B.vault.writeBinary(NOTE, enc(BASE.replace("beta", "beta — VERSION B")));

    await A.sync();
    const r = await B.sync();

    expect(r.merged).toHaveLength(0);
    expect(r.conflictCopies).toHaveLength(1);
    const copies = (await B.vault.list()).filter((p) => p.includes("(conflict"));
    expect(copies).toHaveLength(1);
    expect(dec(await B.vault.readBinary(NOTE))).toContain("VERSION A"); // remote canonical
    expect(dec(await B.vault.readBinary(copies[0]))).toContain("VERSION B"); // local kept
  });
});
