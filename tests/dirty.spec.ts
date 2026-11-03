import { describe, expect, it } from "vitest";
import { hasRealLocalChanges, type FileStatLookup } from "../src/engine/dirty.js";
import { JsonStateStore } from "../src/engine/state-db.js";
import type { StateEntry } from "../src/types.js";

const entry = (path: string, size: number, mtime: number, deleted = false): StateEntry => ({
  path,
  contentHash: "h",
  size,
  mtime,
  version: 1,
  blobKey: path,
  deleted,
});

const store = (entries: StateEntry[]) => new JsonStateStore(entries, async () => {});
const files =
  (m: Record<string, { size: number; mtime: number }>): FileStatLookup =>
  (p) =>
    m[p] ?? null;

describe("hasRealLocalChanges", () => {
  it("ignores events for files that already match the last sync (our own downloads)", async () => {
    const state = store([entry("a.md", 10, 100), entry("b.png", 20, 200)]);
    const lookup = files({ "a.md": { size: 10, mtime: 100 }, "b.png": { size: 20, mtime: 200 } });
    expect(await hasRealLocalChanges(["a.md", "b.png"], lookup, state)).toBe(false);
  });

  it("sees an edit (size or mtime differs)", async () => {
    const state = store([entry("a.md", 10, 100)]);
    expect(await hasRealLocalChanges(["a.md"], files({ "a.md": { size: 10, mtime: 101 } }), state)).toBe(true);
    expect(await hasRealLocalChanges(["a.md"], files({ "a.md": { size: 11, mtime: 100 } }), state)).toBe(true);
  });

  it("sees a new file, and a file re-created over a tombstone", async () => {
    const state = store([entry("gone.md", 5, 50, true)]);
    expect(await hasRealLocalChanges(["new.md"], files({ "new.md": { size: 1, mtime: 1 } }), state)).toBe(true);
    expect(await hasRealLocalChanges(["gone.md"], files({ "gone.md": { size: 5, mtime: 50 } }), state)).toBe(true);
  });

  it("sees a deletion or rename-away of a synced file, but not of an unknown one", async () => {
    const state = store([entry("a.md", 10, 100)]);
    expect(await hasRealLocalChanges(["a.md"], files({}), state)).toBe(true);
    expect(await hasRealLocalChanges(["never-synced.md"], files({}), state)).toBe(false);
  });

  it("ignores excluded paths", async () => {
    const state = store([]);
    const lookup = files({ ".trash/x.md": { size: 1, mtime: 1 } });
    expect(await hasRealLocalChanges([".trash/x.md"], lookup, state, (p) => p.startsWith(".trash/"))).toBe(false);
  });
});
