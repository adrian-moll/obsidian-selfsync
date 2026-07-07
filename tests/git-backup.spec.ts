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

describe("GitBackup managed .gitignore", () => {
  let d: string;

  beforeAll(() => {
    d = mkdtempSync(join(tmpdir(), "selfsync-gi-"));
  });
  afterAll(() => rmSync(d, { recursive: true, force: true }));

  it("writes base excludes + user globs into a managed block and preserves user lines", async () => {
    // Pre-existing user content outside any managed block.
    writeFileSync(join(d, ".gitignore"), "# my own ignores\nsecret.txt\n");
    const b = new GitBackup({ dir: d, excludeGlobs: ["**/*.mp4", "Attachments/**"] });
    await b.init();

    const gi = readFileSync(join(d, ".gitignore"), "utf8");
    expect(gi).toContain("# my own ignores");
    expect(gi).toContain("secret.txt");
    expect(gi).toContain(".obsidian/plugins/selfsync/");
    expect(gi).toContain("**/*.mp4");
    expect(gi).toContain("Attachments/**");

    // Re-running with different globs updates the managed block in place (no dup).
    const b2 = new GitBackup({ dir: d, excludeGlobs: ["**/*.zip"] });
    await b2.init();
    const gi2 = readFileSync(join(d, ".gitignore"), "utf8");
    expect(gi2).toContain("**/*.zip");
    expect(gi2).not.toContain("**/*.mp4"); // replaced, not appended
    expect(gi2.match(/do not edit this block/g)?.length).toBe(1); // exactly one managed block
    expect(gi2).toContain("secret.txt"); // user content still preserved
  });

  it("git-ignores files matching a user exclude glob", async () => {
    const b = new GitBackup({ dir: d, excludeGlobs: ["**/*.big"], authorName: "T", authorEmail: "t@e.co" });
    await b.init();
    writeFileSync(join(d, "keep.md"), "hello\n");
    writeFileSync(join(d, "huge.big"), "x".repeat(1000));
    expect((await b.commitAll("first")).committed).toBe(true); // keep.md committed
    expect(await b.log("keep.md")).toHaveLength(1);
    // Changing only the ignored file leaves nothing to commit.
    writeFileSync(join(d, "huge.big"), "y".repeat(2000));
    expect((await b.commitAll("noop")).committed).toBe(false);
  });
});

describe("GitBackup compactHistory", () => {
  let d: string;

  beforeAll(() => {
    d = mkdtempSync(join(tmpdir(), "selfsync-compact-"));
  });
  afterAll(() => rmSync(d, { recursive: true, force: true }));

  it("collapses all history into a single fresh snapshot commit", async () => {
    const b = new GitBackup({ dir: d, authorName: "T", authorEmail: "t@e.co" });
    await b.init();
    writeFileSync(join(d, "note.md"), "v1\n");
    await b.commitAll("first");
    writeFileSync(join(d, "note.md"), "v2 longer\n");
    await b.commitAll("second");
    expect((await b.log("note.md")).length).toBe(2);

    const res = await b.compactHistory(); // no remote → pushed: false, no error
    expect(res.pushed).toBe(false);
    expect(res.pushError).toBeUndefined();

    const history = await b.log();
    expect(history).toHaveLength(1); // single snapshot commit
    expect(history[0].message).toBe("SelfSync snapshot");
    // Working file survives with its current content.
    expect(readFileSync(join(d, "note.md"), "utf8")).toBe("v2 longer\n");
  });
});
