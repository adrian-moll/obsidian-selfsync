/**
 * Headless test of the Git backup layer against a real temp repo (Node fs +
 * isomorphic-git). Push isn't exercised (needs a remote); commit/log/read/restore
 * and .gitignore behavior are.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GitBackup } from "../src/git/git-backup.js";

let dir: string;
let backup: GitBackup;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "selfsync-git-"));
  backup = new GitBackup({ dir, authorName: "Test", authorEmail: "test@example.com" });
  await backup.init();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("GitBackup", () => {
  const V1 = "alpha\n";
  const V2 = "alpha beta gamma\n"; // different size so it's never racy-clean

  it("commits changes, skips no-op, and records history newest-first", async () => {
    writeFileSync(join(dir, "note.md"), V1);
    expect((await backup.commitAll("first")).committed).toBe(true);

    expect((await backup.commitAll("noop")).committed).toBe(false); // nothing changed

    writeFileSync(join(dir, "note.md"), V2);
    expect((await backup.commitAll("second")).committed).toBe(true);

    const history = await backup.log("note.md");
    expect(history).toHaveLength(2);
    expect(history[0].message).toBe("second"); // newest first
  });

  it("reads and restores a past version", async () => {
    const history = await backup.log("note.md");
    const firstOid = history[history.length - 1].oid;
    expect(await backup.readFileAt(firstOid, "note.md")).toBe(V1);

    await backup.restore(firstOid, "note.md");
    expect(readFileSync(join(dir, "note.md"), "utf8")).toBe(V1);
    await backup.commitAll("restore v1"); // checkpoint so the tree is clean again
  });

  it("commits in chunks via backup()", async () => {
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(dir, `chunk-${i}.md`), `content ${i} ${"x".repeat(i)}`);
    }
    const res = await backup.backup("chunked", { chunkSize: 3, push: false });
    expect(res.commits).toBe(4); // ceil(10 / 3)
    expect(res.pushed).toBe(false);

    const res2 = await backup.backup("noop", { chunkSize: 3, push: false });
    expect(res2.commits).toBe(0); // nothing left to commit
  });

  it("splits commits by byte size so each push stays small", async () => {
    for (let i = 0; i < 3; i++) writeFileSync(join(dir, `big-${i}.bin`), "x".repeat(1000));
    // 1000+1000 fits in 2500; the third file spills into a second commit.
    const res = await backup.backup("bytes", { chunkSize: 100, maxBytesPerCommit: 2500, push: false });
    expect(res.commits).toBe(2);
  });

  it("honors .gitignore for the plugin's own data folder", async () => {
    mkdirSync(join(dir, ".obsidian", "plugins", "selfsync"), { recursive: true });
    writeFileSync(join(dir, ".obsidian", "plugins", "selfsync", "data.json"), "device-specific");
    // The only change is inside the ignored folder → nothing to commit.
    expect((await backup.commitAll("should ignore")).committed).toBe(false);
  });
});
