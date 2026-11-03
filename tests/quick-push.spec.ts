/**
 * The quick push used when the app closes / goes to the background
 * (SyncEngine.pushLocalChanges), and the session manifest cache it relies on.
 */
import { describe, expect, it } from "vitest";
import { MemoryBackend } from "../src/backend/storage-backend.js";
import { MemoryVaultAdapter } from "../src/vault/memory-vault-adapter.js";
import { MemoryStateStore } from "../src/engine/state-db.js";
import { MemoryBaseStore } from "../src/engine/base-store.js";
import { SyncEngine } from "../src/engine/engine.js";
import { MirrorNaming } from "../src/engine/naming.js";
import { ManifestStore, type ManifestCache } from "../src/engine/manifest-store.js";
import { dec, enc } from "./support/devices.js";

const TS = "2026-01-01T00-00-00Z";

function device(backend: MemoryBackend, id: string, manifestCache?: ManifestCache) {
  const vault = new MemoryVaultAdapter();
  const engine = new SyncEngine({
    vault,
    backend,
    state: new MemoryStateStore(),
    deviceId: id,
    naming: new MirrorNaming(),
    baseStore: new MemoryBaseStore(),
    manifestCache,
  });
  return {
    vault,
    sync: () => engine.sync({ timestampIso: TS, useMtimeShortcut: true }),
    push: (paths: string[]) => engine.pushLocalChanges(paths, { timestampIso: TS, useMtimeShortcut: true }),
  };
}

/** A MemoryBackend that counts content reads of a key. */
class CountingBackend extends MemoryBackend {
  reads = new Map<string, number>();
  async read(key: string): Promise<ArrayBuffer> {
    this.reads.set(key, (this.reads.get(key) ?? 0) + 1);
    return super.read(key);
  }
  async readWithMeta(key: string) {
    this.reads.set(key, (this.reads.get(key) ?? 0) + 1);
    return super.readWithMeta(key);
  }
}

describe("pushLocalChanges (quick push on close)", () => {
  it("uploads edits, new files and deletions of the given paths", async () => {
    const backend = new MemoryBackend();
    const a = device(backend, "A");
    const b = device(backend, "B");
    await a.vault.writeBinary("note.md", enc("v1"));
    await a.vault.writeBinary("old.md", enc("bye"));
    await a.sync();
    await b.sync();

    await a.vault.writeBinary("note.md", enc("v2"));
    await a.vault.writeBinary("new.md", enc("hello"));
    await a.vault.remove("old.md");
    const res = await a.push(["note.md", "new.md", "old.md"]);
    expect(res.conflict).toBe(false);
    expect(res.ops.map((o) => o.kind).sort()).toEqual(["deleteRemote", "upload", "upload"]);

    await b.sync();
    expect(dec(await b.vault.readBinary("note.md"))).toBe("v2");
    expect(dec(await b.vault.readBinary("new.md"))).toBe("hello");
    expect(await b.vault.exists("old.md")).toBe(false);
  });

  it("touches only the given paths", async () => {
    const backend = new MemoryBackend();
    const a = device(backend, "A");
    await a.vault.writeBinary("edited.md", enc("x"));
    await a.vault.writeBinary("other.md", enc("not listed"));
    await a.push(["edited.md"]);

    const b = device(backend, "B");
    await b.sync();
    expect(await b.vault.exists("edited.md")).toBe(true);
    expect(await b.vault.exists("other.md")).toBe(false);
  });

  it("leaves a path the other device also changed for the full sync (no overwrite)", async () => {
    const backend = new MemoryBackend();
    const a = device(backend, "A");
    const b = device(backend, "B");
    await a.vault.writeBinary("note.md", enc("base\n"));
    await a.sync();
    await b.sync();

    await b.vault.writeBinary("note.md", enc("from B\n"));
    await b.sync();
    await a.vault.writeBinary("note.md", enc("from A\n"));
    const res = await a.push(["note.md"]);
    expect(res.ops).toEqual([]); // a download/merge is needed → deferred

    const c = device(backend, "C");
    await c.sync();
    expect(dec(await c.vault.readBinary("note.md"))).toBe("from B\n"); // B's edit intact
    expect(await a.vault.exists("note.md")).toBe(true); // A's edit kept locally for the full sync
  });
});

describe("ManifestStore cache", () => {
  it("skips re-downloading an unchanged manifest and re-reads after another device commits", async () => {
    const backend = new CountingBackend();
    const key = new MirrorNaming().manifestKey;
    const cache: ManifestCache = { entry: null };
    const a = device(backend, "A", cache);
    await a.vault.writeBinary("n.md", enc("1"));
    await a.sync(); // commits → cache holds the committed manifest
    const readsAfterCommit = backend.reads.get(key) ?? 0;

    await a.sync(); // unchanged → served from the cache
    expect(backend.reads.get(key) ?? 0).toBe(readsAfterCommit);

    const b = device(backend, "B");
    await b.sync();
    await b.vault.writeBinary("n.md", enc("2"));
    await b.sync(); // B commits → etag changes
    const before = backend.reads.get(key) ?? 0;
    await a.sync();
    expect(backend.reads.get(key)).toBe(before + 1);
    expect(dec(await a.vault.readBinary("n.md"))).toBe("2");
  });

  it("hands out an independent copy each load (the engine mutates it)", async () => {
    const backend = new MemoryBackend();
    const cache: ManifestCache = { entry: null };
    const store = new ManifestStore(backend, "A", "manifest.json", cache);
    const first = await store.load();
    await store.commit(first.manifest, first.etag);
    const x = await store.load();
    x.manifest.entries["mutated"] = { contentHash: "h", version: 1, blobKey: "k", size: 0, mtime: 0, deleted: false };
    const y = await store.load();
    expect(y.manifest.entries["mutated"]).toBeUndefined();
  });
});
