import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXCLUDES,
  OBSIDIAN_CONFIG_GLOB,
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
