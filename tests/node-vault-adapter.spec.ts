/**
 * Contract tests for the Node-fs VaultAdapter used by the headless client. The
 * engine assumes exact semantics from this interface — recursive POSIX listing,
 * stable integer mtimes, appends that make the file grow by exactly the appended
 * bytes (large-download resume), and parent-directory creation — so each is
 * pinned here against a real temp directory.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { NodeVaultAdapter, PathEscapeError } from "../src/vault/node-vault-adapter.js";

const enc = (s: string): ArrayBuffer => {
  const v = new TextEncoder().encode(s);
  const b = new ArrayBuffer(v.byteLength);
  new Uint8Array(b).set(v);
  return b;
};
const dec = (b: ArrayBuffer): string => new TextDecoder().decode(b);

describe("NodeVaultAdapter", () => {
  let root: string;
  let vault: NodeVaultAdapter;

  beforeEach(async () => {
    root = await fs.mkdtemp(nodePath.join(os.tmpdir(), "selfsync-vault-"));
    vault = new NodeVaultAdapter({ root });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("lists files recursively with POSIX separators", async () => {
    await vault.writeBinary("note.md", enc("a"));
    await vault.writeBinary("folder/sub/deep.md", enc("b"));
    expect((await vault.list()).sort()).toEqual(["folder/sub/deep.md", "note.md"]);
  });

  it("lists nothing for an empty vault and omits directories", async () => {
    await fs.mkdir(nodePath.join(root, "empty-folder"), { recursive: true });
    expect(await vault.list()).toEqual([]);
  });

  it("prunes .git and .trash at the root only", async () => {
    await vault.writeBinary(".git/objects/ab/cdef", enc("git"));
    await vault.writeBinary(".trash/old.md", enc("trash"));
    // A nested .git is NOT pruned: `.git/**` is root-anchored, so excluding it
    // here would hide a file the engine would otherwise sync.
    await vault.writeBinary("projects/repo/.git/config", enc("nested"));
    expect((await vault.list()).sort()).toEqual(["projects/repo/.git/config"]);
  });

  it("returns integer, stable mtimes and null for non-files", async () => {
    await vault.writeBinary("note.md", enc("hello"));
    const first = await vault.stat("note.md");
    const second = await vault.stat("note.md");
    expect(first).not.toBeNull();
    expect(first!.size).toBe(5);
    expect(Number.isInteger(first!.mtime)).toBe(true);
    // scanVault compares mtime with ===, so repeated stats must agree exactly.
    expect(second).toEqual(first);

    await fs.mkdir(nodePath.join(root, "folder"), { recursive: true });
    expect(await vault.stat("folder")).toBeNull();
    expect(await vault.stat("missing.md")).toBeNull();
  });

  it("creates parent directories on write and rename", async () => {
    await vault.writeBinary("a/b/c/note.md", enc("nested"));
    expect(dec(await vault.readBinary("a/b/c/note.md"))).toBe("nested");
    await vault.rename("a/b/c/note.md", "x/y/moved.md");
    expect(await vault.exists("a/b/c/note.md")).toBe(false);
    expect(dec(await vault.readBinary("x/y/moved.md"))).toBe("nested");
  });

  it("appends bytes so the file length is the resume offset", async () => {
    await vault.appendBinary("staging/blob", enc("0123456789"));
    expect((await vault.stat("staging/blob"))!.size).toBe(10);
    await vault.appendBinary("staging/blob", enc("abcde"));
    expect((await vault.stat("staging/blob"))!.size).toBe(15);
    expect(dec(await vault.readBinary("staging/blob"))).toBe("0123456789abcde");
  });

  it("appends to a not-yet-existing file by creating it", async () => {
    await vault.appendBinary("fresh.bin", enc("xyz"));
    expect(dec(await vault.readBinary("fresh.bin"))).toBe("xyz");
  });

  it("prunes empty parent directories on remove but keeps the root", async () => {
    await vault.writeBinary("a/b/note.md", enc("x"));
    await vault.writeBinary("a/keep.md", enc("y"));
    await vault.remove("a/b/note.md");
    expect(fsSync.existsSync(nodePath.join(root, "a", "b"))).toBe(false);
    expect(fsSync.existsSync(nodePath.join(root, "a"))).toBe(true); // still holds keep.md
    await vault.remove("a/keep.md");
    expect(fsSync.existsSync(nodePath.join(root, "a"))).toBe(false);
    expect(fsSync.existsSync(root)).toBe(true);
  });

  it("removes a missing file without throwing", async () => {
    await expect(vault.remove("nope.md")).resolves.toBeUndefined();
  });

  it("rejects paths that escape the vault root", async () => {
    await expect(vault.readBinary("../outside.md")).rejects.toThrow(PathEscapeError);
    await expect(vault.writeBinary("a/../../outside.md", enc("x"))).rejects.toThrow(PathEscapeError);
    expect(await vault.exists("../outside.md")).toBe(false); // exists() swallows it
  });

  it("treats a leading slash as vault-root-relative (like Obsidian's normalizePath)", async () => {
    await vault.writeBinary("/rooted.md", enc("x"));
    expect(fsSync.existsSync(nodePath.join(root, "rooted.md"))).toBe(true);
    expect(await vault.list()).toEqual(["rooted.md"]);
  });

  it.skipIf(process.platform === "win32")("skips symlinks when listing", async () => {
    await vault.writeBinary("real.md", enc("x"));
    await fs.symlink(nodePath.join(root, "real.md"), nodePath.join(root, "link.md"));
    expect(await vault.list()).toEqual(["real.md"]);
  });
});
