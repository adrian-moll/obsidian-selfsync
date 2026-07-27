/**
 * The headless client and a plugin-style client as peers on one backend: device
 * N runs the real container stack (Node-fs vault, on-disk merge bases, file
 * State DB), device P the in-memory one. Convergence in both directions is what
 * makes the Docker client a legitimate device rather than a second protocol.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import { MemoryBackend } from "../src/backend/storage-backend.js";
import { dec, enc, makeDevice, makeNodeDevice } from "./support/devices.js";
import { createFileStateStore, loadStateEntries } from "../src/headless/state-file.js";

let tmp: string;
let dirs: { vault: string; state: string };

beforeEach(async () => {
  tmp = await fs.mkdtemp(nodePath.join(os.tmpdir(), "selfsync-headless-"));
  dirs = { vault: nodePath.join(tmp, "vault"), state: nodePath.join(tmp, "state") };
  await fs.mkdir(dirs.vault, { recursive: true });
  await fs.mkdir(dirs.state, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("headless device ↔ plugin device", () => {
  it("propagates a new file plugin → headless", async () => {
    const backend = new MemoryBackend();
    const P = makeDevice(backend, "plugin");
    const N = await makeNodeDevice(backend, "headless-1", dirs);
    await P.vault.writeBinary("notes/hello.md", enc("from obsidian"));
    await P.sync();
    await N.sync();
    expect(dec(await N.vault.readBinary("notes/hello.md"))).toBe("from obsidian");
  });

  it("propagates a new file headless → plugin", async () => {
    const backend = new MemoryBackend();
    const P = makeDevice(backend, "plugin");
    const N = await makeNodeDevice(backend, "headless-1", dirs);
    await N.vault.writeBinary("agent/output.md", enc("written by the agent"));
    await N.sync();
    await P.sync();
    expect(dec(await P.vault.readBinary("agent/output.md"))).toBe("written by the agent");
  });

  it("propagates edits, deletes and renames both ways", async () => {
    const backend = new MemoryBackend();
    const P = makeDevice(backend, "plugin");
    const N = await makeNodeDevice(backend, "headless-1", dirs);
    await P.vault.writeBinary("note.md", enc("v1"));
    await P.sync();
    await N.sync();

    await N.vault.writeBinary("note.md", enc("v2 from agent"));
    await N.sync();
    await P.sync();
    expect(dec(await P.vault.readBinary("note.md"))).toBe("v2 from agent");

    await P.vault.rename("note.md", "renamed.md");
    await P.sync();
    await N.sync();
    expect(await N.vault.exists("note.md")).toBe(false);
    expect(dec(await N.vault.readBinary("renamed.md"))).toBe("v2 from agent");

    await N.vault.remove("renamed.md");
    await N.sync();
    await P.sync();
    expect(await P.vault.exists("renamed.md")).toBe(false);
    // A re-sync must not resurrect it on either side.
    await N.sync();
    expect(await N.vault.exists("renamed.md")).toBe(false);
  });

  it("auto-merges concurrent edits to different regions using the on-disk base", async () => {
    const backend = new MemoryBackend();
    const P = makeDevice(backend, "plugin");
    const N = await makeNodeDevice(backend, "headless-1", dirs);
    await P.vault.writeBinary("note.md", enc("line1\nline2\nline3\n"));
    await P.sync();
    await N.sync();

    await P.vault.writeBinary("note.md", enc("EDITED-TOP\nline2\nline3\n"));
    await N.vault.writeBinary("note.md", enc("line1\nline2\nEDITED-BOTTOM\n"));
    await P.sync();
    const res = await N.sync();

    expect(res.merged).toEqual(["note.md"]);
    expect(res.conflictCopies).toEqual([]);
    const merged = dec(await N.vault.readBinary("note.md"));
    expect(merged).toContain("EDITED-TOP");
    expect(merged).toContain("EDITED-BOTTOM");
  });

  it("names conflict copies after the headless device id", async () => {
    const backend = new MemoryBackend();
    const P = makeDevice(backend, "plugin");
    const N = await makeNodeDevice(backend, "headless-1", dirs);
    await P.vault.writeBinary("note.md", enc("base\n"));
    await P.sync();
    await N.sync();

    // Same line edited on both sides → not auto-mergeable → keep both.
    await P.vault.writeBinary("note.md", enc("plugin wins the line\n"));
    await N.vault.writeBinary("note.md", enc("agent wins the line\n"));
    await P.sync();
    const res = await N.sync();

    expect(res.conflictCopies).toHaveLength(1);
    expect(res.conflictCopies[0]).toContain("headless-1");
    expect(dec(await N.vault.readBinary("note.md"))).toBe("plugin wins the line\n");
    expect(dec(await N.vault.readBinary(res.conflictCopies[0]))).toBe("agent wins the line\n");
  });

  it("keeps binary files intact through a round trip", async () => {
    const backend = new MemoryBackend();
    const P = makeDevice(backend, "plugin");
    const N = await makeNodeDevice(backend, "headless-1", dirs);
    const bytes = new Uint8Array(1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 256;
    await N.vault.writeBinary("assets/blob.bin", bytes.buffer);
    await N.sync();
    await P.sync();
    expect(new Uint8Array(await P.vault.readBinary("assets/blob.bin"))).toEqual(bytes);
  });
});

describe("headless state persistence", () => {
  it("survives a restart: a re-created device syncs to a no-op", async () => {
    const backend = new MemoryBackend();
    const P = makeDevice(backend, "plugin");
    const N1 = await makeNodeDevice(backend, "headless-1", dirs);
    await P.vault.writeBinary("note.md", enc("hello"));
    await P.sync();
    await N1.sync();
    expect(await loadStateEntries(dirs.state)).not.toEqual([]);

    // Same vault + state dir, fresh engine — the container restarting.
    const N2 = await makeNodeDevice(backend, "headless-1", dirs);
    const res = await N2.sync();
    expect(res.ops).toEqual([]);
    expect(res.conflictCopies).toEqual([]);
  });

  it("re-indexes instead of crashing when the state file is corrupt", async () => {
    const backend = new MemoryBackend();
    const P = makeDevice(backend, "plugin");
    await P.vault.writeBinary("note.md", enc("hello"));
    await P.sync();

    await fs.writeFile(nodePath.join(dirs.state, "state.json"), "{ this is not json", "utf-8");
    const warnings: string[] = [];
    const store = await createFileStateStore(dirs.state, (m) => warnings.push(m));
    expect(await store.all()).toEqual([]);
    expect(warnings.join(" ")).toMatch(/unreadable/);

    const N = await makeNodeDevice(backend, "headless-1", dirs);
    await N.sync();
    expect(dec(await N.vault.readBinary("note.md"))).toBe("hello");
  });
});
