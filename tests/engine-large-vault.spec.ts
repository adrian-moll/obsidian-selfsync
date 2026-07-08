/**
 * Large-vault first sync must scale ~linearly, not O(N²). Regression guard for the
 * Android OOM crash (0.9.0): the State DB was serialized+persisted once per file,
 * and the whole manifest deep-cloned once per 100-op chunk. Now the State DB is
 * persisted once per committed chunk, and the manifest is mutated in place.
 */
import { describe, expect, it } from "vitest";
import { MemoryBackend } from "../src/backend/storage-backend.js";
import { MemoryVaultAdapter } from "../src/vault/memory-vault-adapter.js";
import { JsonStateStore } from "../src/engine/state-db.js";
import { MemoryBaseStore } from "../src/engine/base-store.js";
import { SyncEngine } from "../src/engine/engine.js";
import { MirrorNaming } from "../src/engine/naming.js";
import { enc } from "./support/devices.js";

const CHUNK = 100; // must match SyncEngine's commit chunk size

describe("large-vault first sync scaling", () => {
  it("persists the State DB once per chunk, not once per file", async () => {
    const N = 3000;
    const backend = new MemoryBackend();
    const vault = new MemoryVaultAdapter();
    for (let i = 0; i < N; i++) await vault.writeBinary(`n/${i}.md`, enc(`file ${i}`));

    let persistCount = 0;
    const state = new JsonStateStore([], async () => {
      persistCount++;
    });
    const logs: string[] = [];
    const engine = new SyncEngine({
      vault,
      backend,
      state,
      deviceId: "A",
      naming: new MirrorNaming(),
      baseStore: new MemoryBaseStore(),
    });

    const res = await engine.sync({
      timestampIso: "2026-01-01T00-00-00Z",
      log: (m) => logs.push(m),
    });

    // Correctness: every file uploaded and recorded in the manifest + State DB.
    expect(res.committed).toBe(true);
    const keys = new Set((await backend.list()).map((e) => e.key));
    for (let i = 0; i < N; i++) expect(keys.has(`n/${i}.md`)).toBe(true);
    expect((await state.all()).length).toBe(N);

    // Fix #1: one persist per committed chunk (⌈N/CHUNK⌉), NOT ~N.
    const expectedChunks = Math.ceil(N / CHUNK);
    expect(persistCount).toBe(expectedChunks);
    expect(persistCount).toBeLessThan(N / 10);

    // Fix #3: the engine emitted phase diagnostics between "Sync start" and done.
    expect(logs.some((l) => l.startsWith("manifest loaded:"))).toBe(true);
    expect(logs.some((l) => l === `scanned vault: ${N} files, 0 oversized skipped`)).toBe(true);
    expect(logs.some((l) => l === `reconciled: ${N} ops`)).toBe(true);
    expect(logs.filter((l) => l.startsWith("committed chunk:")).length).toBe(expectedChunks);
  });

  it("keeps a deferred batch atomic: nothing persists until flush", async () => {
    const persisted: number[] = [];
    const state = new JsonStateStore([], async (all) => {
      persisted.push(all.length);
    });

    state.beginBatch();
    await state.put({ path: "a.md", contentHash: "h", size: 1, mtime: 1, version: 1, blobKey: "a.md" });
    await state.put({ path: "b.md", contentHash: "h", size: 1, mtime: 1, version: 1, blobKey: "b.md" });
    expect(persisted).toEqual([]); // deferred — no writes yet
    await state.flush();
    expect(persisted).toEqual([2]); // one write, both entries

    // Outside a batch, writes persist immediately (unchanged behavior).
    await state.put({ path: "c.md", contentHash: "h", size: 1, mtime: 1, version: 1, blobKey: "c.md" });
    expect(persisted).toEqual([2, 3]);
  });
});
