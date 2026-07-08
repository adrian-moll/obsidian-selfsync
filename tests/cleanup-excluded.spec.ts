/**
 * cleanupExcluded: prune manifest entries, remote blobs, and local-state records for
 * paths that are currently excluded from sync (e.g. a `.git/` repo synced by an old
 * build before `.git/**` was excluded), with a safe dry-run preview.
 */
import { describe, expect, it } from "vitest";
import {
  ConditionalWriteError,
  MemoryBackend,
  type BackendCapabilities,
  type StorageBackend,
} from "../src/backend/storage-backend.js";
import { MemoryStateStore } from "../src/engine/state-db.js";
import { ManifestStore } from "../src/engine/manifest-store.js";
import { emptyManifest } from "../src/engine/manifest.js";
import { MirrorNaming } from "../src/engine/naming.js";
import { makeExcluder } from "../src/engine/exclude.js";
import { cleanupExcluded } from "../src/engine/cleanup.js";
import type { ManifestEntry, StateEntry } from "../src/types.js";
import { enc } from "./support/devices.js";

const naming = new MirrorNaming();
const exclude = makeExcluder([".git/**"]);

function mEntry(path: string, size = 10): ManifestEntry {
  return { contentHash: "h", version: 1, blobKey: path, size, mtime: 1, deleted: false };
}
function sEntry(path: string): StateEntry {
  return { path, contentHash: "h", size: 10, mtime: 1, version: 1, blobKey: path };
}

/** Seed a backend with a manifest listing the given paths + a blob for each. */
async function seed(backend: StorageBackend, paths: string[]): Promise<void> {
  const manifest = emptyManifest("A");
  for (const p of paths) {
    manifest.entries[p] = mEntry(p);
    await backend.write(p, enc(`data ${p}`));
  }
  await new ManifestStore(backend, "A", naming.manifestKey).commit(manifest);
}

function stateOf(paths: string[]): MemoryStateStore {
  const s = new MemoryStateStore();
  for (const p of paths) void s.put(sEntry(p));
  return s;
}

describe("cleanupExcluded", () => {
  it("dry run reports excluded entries and changes nothing", async () => {
    const backend = new MemoryBackend();
    await seed(backend, [".git/x", "a.md"]);
    const state = stateOf([".git/x", "a.md"]);
    const manifests = new ManifestStore(backend, "A", naming.manifestKey);

    const res = await cleanupExcluded({ manifests, backend, exclude, state, dryRun: true });

    expect(res.paths).toEqual([".git/x"]);
    expect(res.count).toBe(1);
    expect(res.committed).toBe(false);
    // Nothing removed.
    expect(Object.keys((await manifests.load()).manifest.entries).sort()).toEqual([".git/x", "a.md"]);
    expect(await backend.read(".git/x")).toBeTruthy();
    expect((await state.all()).map((e) => e.path).sort()).toEqual([".git/x", "a.md"]);
  });

  it("removes excluded entries from manifest, blobs, and state; keeps the rest", async () => {
    const backend = new MemoryBackend();
    await seed(backend, [".git/x", ".git/objects/y", "a.md", "notes/b.md"]);
    const state = stateOf([".git/x", ".git/objects/y", "a.md", "notes/b.md"]);
    const manifests = new ManifestStore(backend, "A", naming.manifestKey);

    const res = await cleanupExcluded({ manifests, backend, exclude, state, dryRun: false });

    expect(res.committed).toBe(true);
    expect(res.paths.sort()).toEqual([".git/objects/y", ".git/x"]);
    expect(Object.keys((await manifests.load()).manifest.entries).sort()).toEqual(["a.md", "notes/b.md"]);
    await expect(backend.read(".git/x")).rejects.toThrow(); // blob deleted
    expect(await backend.read("a.md")).toBeTruthy(); // kept
    expect((await state.all()).map((e) => e.path).sort()).toEqual(["a.md", "notes/b.md"]);
  });

  it("is a no-op when nothing is excluded", async () => {
    const backend = new MemoryBackend();
    await seed(backend, ["a.md", "b.md"]);
    const manifests = new ManifestStore(backend, "A", naming.manifestKey);
    const res = await cleanupExcluded({ manifests, backend, exclude, state: new MemoryStateStore(), dryRun: false });
    expect(res.count).toBe(0);
    expect(res.committed).toBe(false);
  });

  it("retries the commit if the manifest changed concurrently", async () => {
    const inner = new MemoryBackend();
    await seed(inner, [".git/x", "a.md"]);
    // Reject the first manifest write once, to force a reload + retry.
    let tripped = false;
    const backend: StorageBackend = {
      testConnection: () => inner.testConnection(),
      list: () => inner.list(),
      read: (k) => inner.read(k),
      readWithMeta: (k) => inner.readWithMeta(k),
      write: (k, d, e) => {
        if (!tripped && k.includes("manifest.json")) {
          tripped = true;
          throw new ConditionalWriteError(k);
        }
        return inner.write(k, d, e);
      },
      remove: (k, e) => inner.remove(k, e),
      move: (f, t) => inner.move(f, t),
      capabilities: (): BackendCapabilities => inner.capabilities(),
    };
    const state = stateOf([".git/x", "a.md"]);
    const manifests = new ManifestStore(backend, "A", naming.manifestKey);

    const res = await cleanupExcluded({ manifests, backend, exclude, state, dryRun: false });

    expect(tripped).toBe(true);
    expect(res.committed).toBe(true);
    expect(Object.keys((await manifests.load()).manifest.entries)).toEqual(["a.md"]);
  });
});
