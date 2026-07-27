/**
 * Regression: a file that is already identical locally and remotely but missing
 * from the State DB must have its merge base adopted, so the NEXT edit uploads
 * instead of producing a conflict copy for an edit nobody conflicted over.
 *
 * Reproduces the states that cause it: a lost State DB (reset / corruption /
 * a cycle that lost the manifest race) and a vault folder copied into place
 * rather than downloaded.
 */
import { describe, expect, it } from "vitest";
import { MemoryBackend } from "../src/backend/storage-backend.js";
import { MemoryVaultAdapter } from "../src/vault/memory-vault-adapter.js";
import { MemoryStateStore } from "../src/engine/state-db.js";
import { MemoryBaseStore } from "../src/engine/base-store.js";
import { SyncEngine } from "../src/engine/engine.js";
import { MirrorNaming } from "../src/engine/naming.js";
import { dec, enc, makeDevice } from "./support/devices.js";

/** A device whose State DB and BaseStore can be wiped, simulating a state loss. */
function makeResettableDevice(backend: MemoryBackend, id: string) {
  const vault = new MemoryVaultAdapter();
  let state = new MemoryStateStore();
  let baseStore = new MemoryBaseStore();
  let n = 0;
  const build = (): SyncEngine =>
    new SyncEngine({ vault, backend, state, deviceId: id, naming: new MirrorNaming(), baseStore });
  let engine = build();
  return {
    vault,
    sync: () => engine.sync({ timestampIso: `2026-02-02T00-00-${String(n++).padStart(2, "0")}Z` }),
    resetState: () => {
      state = new MemoryStateStore();
      baseStore = new MemoryBaseStore();
      engine = build();
    },
  };
}

describe("adopting already-in-sync files into the State DB", () => {
  it("uploads (not conflicts) on the first edit after a state reset", async () => {
    const backend = new MemoryBackend();
    const A = makeDevice(backend, "A");
    const B = makeResettableDevice(backend, "B");

    await A.vault.writeBinary("note.md", enc("shared\n"));
    await A.sync();
    await B.sync();
    expect(dec(await B.vault.readBinary("note.md"))).toBe("shared\n");

    // B loses its State DB but keeps the vault — the file is still identical
    // on both sides, so this sync has nothing to transfer.
    B.resetState();
    const rescan = await B.sync();
    expect(rescan.ops).toEqual([]);

    // The next local edit must be a plain upload.
    await B.vault.writeBinary("note.md", enc("edited by B\n"));
    const res = await B.sync();
    expect(res.conflictCopies).toEqual([]);
    expect(res.ops.map((o) => o.kind)).toEqual(["upload"]);

    await A.sync();
    expect(dec(await A.vault.readBinary("note.md"))).toBe("edited by B\n");
  });

  it("restores 3-way merging for text after a state reset", async () => {
    const backend = new MemoryBackend();
    const A = makeDevice(backend, "A");
    const B = makeResettableDevice(backend, "B");

    await A.vault.writeBinary("note.md", enc("line1\nline2\nline3\n"));
    await A.sync();
    await B.sync();
    B.resetState();
    await B.sync(); // adopts the base content, not just the hash

    await A.vault.writeBinary("note.md", enc("TOP\nline2\nline3\n"));
    await B.vault.writeBinary("note.md", enc("line1\nline2\nBOTTOM\n"));
    await A.sync();
    const res = await B.sync();

    expect(res.merged).toEqual(["note.md"]);
    expect(res.conflictCopies).toEqual([]);
    const merged = dec(await B.vault.readBinary("note.md"));
    expect(merged).toContain("TOP");
    expect(merged).toContain("BOTTOM");
  });

  it("adopts a vault that was copied into place rather than downloaded", async () => {
    const backend = new MemoryBackend();
    const A = makeDevice(backend, "A");
    await A.vault.writeBinary("a.md", enc("one\n"));
    await A.vault.writeBinary("b.md", enc("two\n"));
    await A.sync();

    // A brand-new device that already has byte-identical content.
    const C = makeResettableDevice(backend, "C");
    await C.vault.writeBinary("a.md", enc("one\n"));
    await C.vault.writeBinary("b.md", enc("two\n"));
    const first = await C.sync();
    expect(first.ops).toEqual([]);

    await C.vault.writeBinary("a.md", enc("changed on C\n"));
    const res = await C.sync();
    expect(res.conflictCopies).toEqual([]);
    expect(res.ops.map((o) => o.kind)).toEqual(["upload"]);
  });

  it("does not adopt when the content genuinely differs", async () => {
    const backend = new MemoryBackend();
    const A = makeDevice(backend, "A");
    const B = makeResettableDevice(backend, "B");
    await A.vault.writeBinary("note.md", enc("from A\n"));
    await A.sync();

    // B has a DIFFERENT file at the same path and no history for it: a real
    // collision, which must still keep both copies.
    await B.vault.writeBinary("note.md", enc("from B\n"));
    const res = await B.sync();
    expect(res.conflictCopies).toHaveLength(1);
    expect(dec(await B.vault.readBinary("note.md"))).toBe("from A\n");
  });
});
