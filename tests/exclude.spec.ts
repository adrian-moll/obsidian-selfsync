import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXCLUDES,
  OBSIDIAN_CONFIG_GLOB,
  buildExcludePatterns,
  globToRegExp,
  makeExcluder,
} from "../src/engine/exclude.js";

describe("glob exclusion", () => {
  it("matches exact paths", () => {
    const re = globToRegExp(".obsidian/workspace.json");
    expect(re.test(".obsidian/workspace.json")).toBe(true);
    expect(re.test(".obsidian/workspace-mobile.json")).toBe(false);
  });

  it("* matches within a segment, not across /", () => {
    const re = globToRegExp("notes/*.md");
    expect(re.test("notes/todo.md")).toBe(true);
    expect(re.test("notes/sub/todo.md")).toBe(false);
  });

  it("** matches across path separators", () => {
    const re = globToRegExp(".obsidian/plugins/selfsync/**");
    expect(re.test(".obsidian/plugins/selfsync/data.json")).toBe(true);
    expect(re.test(".obsidian/plugins/selfsync/nested/x.js")).toBe(true);
    expect(re.test(".obsidian/plugins/other/data.json")).toBe(false);
  });

  it("**/ prefix matches at any depth", () => {
    const re = globToRegExp("**/*.tmp");
    expect(re.test("a.tmp")).toBe(true);
    expect(re.test("a/b/c.tmp")).toBe(true);
    expect(re.test("a/b.md")).toBe(false);
  });

  it("always-on defaults exclude the plugin's own folder, the git repo, and .trash", () => {
    const ex = makeExcluder(DEFAULT_EXCLUDES);
    expect(ex(".obsidian/plugins/selfsync/data.json")).toBe(true);
    expect(ex(".git/index")).toBe(true);
    expect(ex(".git/objects/ab/cdef")).toBe(true);
    expect(ex(".trash/old.md")).toBe(true);
    expect(ex("Notes/todo.md")).toBe(false);
  });

  it("the .obsidian config glob covers the whole config folder", () => {
    const ex = makeExcluder([...DEFAULT_EXCLUDES, OBSIDIAN_CONFIG_GLOB]);
    expect(ex(".obsidian/appearance.json")).toBe(true);
    expect(ex(".obsidian/plugins/dataview/data.json")).toBe(true);
    expect(ex("Notes/todo.md")).toBe(false);
  });
});

describe("buildExcludePatterns", () => {
  it("config sync OFF excludes the whole .obsidian folder", () => {
    const ex = makeExcluder(buildExcludePatterns({ syncObsidianConfig: false, excludeGlobs: [] }));
    expect(ex(".obsidian/appearance.json")).toBe(true);
    expect(ex(".obsidian/plugins/dataview/main.js")).toBe(true);
    expect(ex(".obsidian/plugins/dataview/data.json")).toBe(true);
    expect(ex("Notes/a.md")).toBe(false);
  });

  it("config sync ON syncs config + plugin CODE but excludes data.json/workspace/cache", () => {
    const ex = makeExcluder(buildExcludePatterns({ syncObsidianConfig: true, excludeGlobs: [] }));

    // Synced (not excluded): portable config + the plugin code itself.
    expect(ex(".obsidian/appearance.json")).toBe(false);
    expect(ex(".obsidian/snippets/s.css")).toBe(false);
    expect(ex(".obsidian/themes/Foo/theme.css")).toBe(false);
    expect(ex(".obsidian/plugins/dataview/main.js")).toBe(false);
    expect(ex(".obsidian/plugins/dataview/manifest.json")).toBe(false);
    expect(ex(".obsidian/plugins/dataview/styles.css")).toBe(false);

    // Excluded: per-device settings/state, workspace, cache, our own folder, git, trash.
    expect(ex(".obsidian/plugins/dataview/data.json")).toBe(true);
    expect(ex(".obsidian/workspace.json")).toBe(true);
    expect(ex(".obsidian/workspace-mobile.json")).toBe(true);
    expect(ex(".obsidian/cache")).toBe(true);
    expect(ex(".obsidian/plugins/selfsync/data.json")).toBe(true);
    expect(ex(".git/index")).toBe(true);
    expect(ex(".trash/x.md")).toBe(true);

    expect(ex("Notes/a.md")).toBe(false);
  });

  it("appends the user's extra globs in both modes", () => {
    const on = makeExcluder(buildExcludePatterns({ syncObsidianConfig: true, excludeGlobs: ["**/*.tmp"] }));
    const off = makeExcluder(buildExcludePatterns({ syncObsidianConfig: false, excludeGlobs: ["Secret/**"] }));
    expect(on("Notes/scratch.tmp")).toBe(true);
    expect(off("Secret/x.md")).toBe(true);
  });
});
