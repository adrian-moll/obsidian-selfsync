import { describe, expect, it } from "vitest";
import { reconcile, type ReconcileOptions } from "../src/engine/reconciler.js";
import { emptyManifest } from "../src/engine/manifest.js";
import type { FileMeta, Manifest, ManifestEntry, StateEntry } from "../src/types.js";

// --- builders -------------------------------------------------------------

const fm = (path: string, hash: string, mtime = 1): FileMeta => ({
  path,
  contentHash: hash,
  size: hash.length,
  mtime,
});

const se = (path: string, hash: string, extra: Partial<StateEntry> = {}): StateEntry => ({
  path,
  contentHash: hash,
  size: hash.length,
  mtime: 1,
  version: 1,
  blobKey: `blob-${path}`,
  ...extra,
});

const me = (hash: string, extra: Partial<ManifestEntry> = {}): ManifestEntry => ({
  contentHash: hash,
  version: 1,
  blobKey: "k",
  size: hash.length,
  mtime: 1,
  ...extra,
});

function manifest(entries: Record<string, ManifestEntry>): Manifest {
  return { formatVersion: 1, updatedBy: "remote", entries };
}

const OPTS: ReconcileOptions = { conflictCopyPath: (p: string) => `${p}.conflict` };

function run(local: FileMeta[], base: StateEntry[], remote: Manifest, opts: ReconcileOptions = OPTS) {
  return reconcile(
    {
      local: new Map(local.map((f) => [f.path, f])),
      base: new Map(base.map((b) => [b.path, b])),
      remote,
    },
    opts,
  );
}

// --- rule table -----------------------------------------------------------

describe("reconcile — reconciliation rules", () => {
  it("no-op when nothing changed", () => {
    const ops = run([fm("a.md", "h1")], [se("a.md", "h1")], manifest({ "a.md": me("h1") }));
    expect(ops).toEqual([]);
  });

  it("uploads a locally edited file", () => {
    const ops = run([fm("a.md", "h2")], [se("a.md", "h1")], manifest({ "a.md": me("h1") }));
    expect(ops).toEqual([{ kind: "upload", path: "a.md" }]);
  });

  it("uploads a brand-new local file", () => {
    const ops = run([fm("new.md", "h1")], [], emptyManifest("remote"));
    expect(ops).toEqual([{ kind: "upload", path: "new.md" }]);
  });

  it("downloads a remotely edited file", () => {
    const ops = run([fm("a.md", "h1")], [se("a.md", "h1")], manifest({ "a.md": me("h2") }));
    expect(ops).toEqual([{ kind: "download", path: "a.md" }]);
  });

  it("downloads a brand-new remote file", () => {
    const ops = run([], [], manifest({ "a.md": me("h1") }));
    expect(ops).toEqual([{ kind: "download", path: "a.md" }]);
  });

  it("tombstones the remote when a synced file is deleted locally", () => {
    const ops = run([], [se("a.md", "h1")], manifest({ "a.md": me("h1") }));
    expect(ops).toEqual([{ kind: "deleteRemote", path: "a.md" }]);
  });

  it("deletes locally when the remote is tombstoned", () => {
    const ops = run(
      [fm("a.md", "h1")],
      [se("a.md", "h1")],
      manifest({ "a.md": me("h1", { deleted: true, contentHash: "" }) }),
    );
    expect(ops).toEqual([{ kind: "deleteLocal", path: "a.md" }]);
  });

  it("keeps both on a genuine edit/edit conflict", () => {
    const ops = run([fm("a.md", "h2")], [se("a.md", "h1")], manifest({ "a.md": me("h3") }));
    expect(ops).toEqual([{ kind: "conflict", path: "a.md", conflictCopyPath: "a.md.conflict" }]);
  });

  it("is a no-op when both sides converged to the same content", () => {
    const ops = run([fm("a.md", "h2")], [se("a.md", "h1")], manifest({ "a.md": me("h2") }));
    expect(ops).toEqual([]);
  });

  it("resurrects (download) when local deleted but remote edited", () => {
    const ops = run([], [se("a.md", "h1")], manifest({ "a.md": me("h2") }));
    expect(ops).toEqual([{ kind: "download", path: "a.md" }]);
  });
});

// --- rename detection -----------------------------------------------------

describe("reconcile — rename detection", () => {
  it("collapses delete+create of identical content into a move", () => {
    const ops = run(
      [fm("b.md", "h1")], // moved to b.md
      [se("a.md", "h1")], // was a.md
      manifest({ "a.md": me("h1") }),
    );
    expect(ops).toEqual([{ kind: "move", from: "a.md", to: "b.md" }]);
  });

  it("does NOT move when detection is disabled (falls back to delete + upload)", () => {
    const ops = run([fm("b.md", "h1")], [se("a.md", "h1")], manifest({ "a.md": me("h1") }), {
      conflictCopyPath: (p) => `${p}.conflict`,
      detectRenames: false,
    });
    expect(ops).toEqual(
      expect.arrayContaining([
        { kind: "deleteRemote", path: "a.md" },
        { kind: "upload", path: "b.md" },
      ]),
    );
    expect(ops).toHaveLength(2);
  });
});
