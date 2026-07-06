/**
 * Two-device simulation (L3): two independent engines (each with its own vault +
 * State DB) sync through one shared backend. Asserts convergence for the core
 * reconciliation outcomes and keep-both conflicts (docs/12-testing.md). Uses the
 * in-memory backend so it runs everywhere; the same scenarios run against real
 * backends via the contract/live tests.
 */
import { describe, expect, it } from "vitest";
import { MemoryBackend } from "../src/backend/storage-backend.js";
import { dec, enc, makeDevice } from "./support/devices.js";

/** Two devices with note.md ("hello") synced on both. */
async function bootstrap() {
  const backend = new MemoryBackend();
  const A = makeDevice(backend, "A");
  const B = makeDevice(backend, "B");
  await A.vault.writeBinary("note.md", enc("hello"));
  await A.sync();
  await B.sync();
  return { backend, A, B };
}

describe("two-device simulation", () => {
  it("propagates a new file A → B", async () => {
    const { B } = await bootstrap();
    expect(await B.vault.exists("note.md")).toBe(true);
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
    // A re-sync must not resurrect it.
    await A.sync();
    expect(await A.vault.exists("note.md")).toBe(false);
  });

  it("propagates a rename A → B as a move", async () => {
    const { A, B } = await bootstrap();
    await A.vault.rename("note.md", "renamed.md");
    const r = await A.sync();
    expect(r.ops.some((o) => o.kind === "move")).toBe(true);
    await B.sync();
    expect(await B.vault.exists("note.md")).toBe(false);
    expect(await B.vault.exists("renamed.md")).toBe(true);
    expect(dec(await B.vault.readBinary("renamed.md"))).toBe("hello");
  });

  it("keeps both on a concurrent edit conflict", async () => {
    const { A, B } = await bootstrap();
    // Both edit the same file while offline.
    await A.vault.writeBinary("note.md", enc("A-version"));
    await B.vault.writeBinary("note.md", enc("B-version"));

    await A.sync(); // A uploads A-version
    const r = await B.sync(); // B detects the conflict
    expect(r.ops.some((o) => o.kind === "conflict")).toBe(true);

    // Canonical file now holds the remote (A) version...
    expect(dec(await B.vault.readBinary("note.md"))).toBe("A-version");
    // ...and B's own edit survives as a conflict copy.
    const copies = (await B.vault.list()).filter((p) => p.startsWith("note (conflict"));
    expect(copies).toHaveLength(1);
    expect(dec(await B.vault.readBinary(copies[0]))).toBe("B-version");

    // The conflict copy propagates back to A on its next sync.
    await A.sync();
    expect(await A.vault.exists(copies[0])).toBe(true);
    expect(dec(await A.vault.readBinary(copies[0]))).toBe("B-version");
  });

  it("converges to a clean state (no ops) once both are in sync", async () => {
    const { A, B } = await bootstrap();
    expect((await A.sync()).ops).toHaveLength(0);
    expect((await B.sync()).ops).toHaveLength(0);
  });
});
