/**
 * IndexedDbStateStore + createStateStore: keyed persistence (only changed keys per
 * flush), batching contract parity with JsonStateStore, persistence across reopen,
 * clear, migration from legacy data.json entries, and JSON fallback when IndexedDB
 * is unavailable.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, beforeEach } from "vitest";
import { createStateStore, IndexedDbStateStore } from "../src/engine/indexeddb-state-store.js";
import { JsonStateStore } from "../src/engine/state-db.js";
import type { StateEntry } from "../src/types.js";

const entry = (path: string, hash = "h"): StateEntry => ({
  path,
  contentHash: hash,
  size: 1,
  mtime: 1,
  version: 1,
  blobKey: path,
});

// A fresh IndexedDB per test so DB names don't leak between cases.
beforeEach(() => {
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
});

const idb = (): IDBFactory => (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB;

describe("IndexedDbStateStore", () => {
  it("round-trips put/get/all/delete/toMap", async () => {
    const s = await IndexedDbStateStore.open(idb(), "db1");
    await s.put(entry("a.md"));
    await s.put(entry("b.md"));
    expect((await s.get("a.md"))?.path).toBe("a.md");
    expect((await s.all()).length).toBe(2);
    expect([...(await s.toMap()).keys()].sort()).toEqual(["a.md", "b.md"]);
    await s.delete("a.md");
    expect(await s.get("a.md")).toBeUndefined();
    expect((await s.all()).length).toBe(1);
  });

  it("persists across a reopen (data survives)", async () => {
    const s1 = await IndexedDbStateStore.open(idb(), "db2");
    await s1.put(entry("keep.md", "x"));
    await s1.put(entry("gone.md"));
    await s1.delete("gone.md");

    const s2 = await IndexedDbStateStore.open(idb(), "db2");
    expect((await s2.all()).map((e) => e.path)).toEqual(["keep.md"]);
    expect((await s2.get("keep.md"))?.contentHash).toBe("x");
  });

  it("batches: no writes are visible until flush, then all at once", async () => {
    const s1 = await IndexedDbStateStore.open(idb(), "db3");
    s1.beginBatch();
    await s1.put(entry("a.md"));
    await s1.put(entry("b.md"));
    await s1.delete("a.md"); // net effect: only b.md persisted

    // Nothing committed yet — a separate connection sees an empty store.
    const mid = await IndexedDbStateStore.open(idb(), "db3");
    expect((await mid.all()).length).toBe(0);

    await s1.flush();
    const after = await IndexedDbStateStore.open(idb(), "db3");
    expect((await after.all()).map((e) => e.path)).toEqual(["b.md"]);
  });

  it("clear() empties the store and persists", async () => {
    const s1 = await IndexedDbStateStore.open(idb(), "db4");
    await s1.put(entry("a.md"));
    await s1.clear();
    expect((await s1.all()).length).toBe(0);
    const s2 = await IndexedDbStateStore.open(idb(), "db4");
    expect((await s2.all()).length).toBe(0);
  });
});

describe("createStateStore", () => {
  it("uses IndexedDB and migrates legacy data.json entries once", async () => {
    const legacy = [entry("one.md"), entry("two.md")];
    const r = await createStateStore({
      indexedDB: idb(),
      dbName: "mig",
      legacyEntries: legacy,
      jsonPersist: async () => {},
    });
    expect(r.backend).toBe("indexeddb");
    expect(r.migrated).toBe(true);
    expect((await r.store.all()).length).toBe(2);

    // A second open finds the store populated → no re-migration.
    const r2 = await createStateStore({
      indexedDB: idb(),
      dbName: "mig",
      legacyEntries: legacy,
      jsonPersist: async () => {},
    });
    expect(r2.migrated).toBe(false);
    expect((await r2.store.all()).length).toBe(2);
  });

  it("falls back to JsonStateStore when IndexedDB is unavailable", async () => {
    const persisted: number[] = [];
    const r = await createStateStore({
      indexedDB: undefined,
      dbName: "nope",
      legacyEntries: [entry("a.md")],
      jsonPersist: async (all) => {
        persisted.push(all.length);
      },
    });
    expect(r.backend).toBe("json");
    expect(r.store).toBeInstanceOf(JsonStateStore);
    expect((await r.store.all()).length).toBe(1);
    await r.store.put(entry("b.md")); // JSON store persists immediately
    expect(persisted).toContain(2);
  });
});
