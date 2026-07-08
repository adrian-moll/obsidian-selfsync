import { describe, expect, it } from "vitest";
import { isEnabledPluginList, isObsidianConfig, mergeEnabledLists } from "../src/engine/config-merge.js";

describe("config path predicates", () => {
  it("isObsidianConfig matches only paths under .obsidian/", () => {
    expect(isObsidianConfig(".obsidian/app.json")).toBe(true);
    expect(isObsidianConfig(".obsidian/plugins/x/main.js")).toBe(true);
    expect(isObsidianConfig("Notes/todo.md")).toBe(false);
  });

  it("isEnabledPluginList matches the two enabled-list files exactly", () => {
    expect(isEnabledPluginList(".obsidian/community-plugins.json")).toBe(true);
    expect(isEnabledPluginList(".obsidian/core-plugins.json")).toBe(true);
    expect(isEnabledPluginList(".obsidian/appearance.json")).toBe(false);
    expect(isEnabledPluginList(".obsidian/plugins/x/data.json")).toBe(false);
  });
});

describe("mergeEnabledLists", () => {
  it("unions array-shaped lists (community-plugins.json), de-duped", () => {
    const merged = mergeEnabledLists(JSON.stringify(["a", "b"]), JSON.stringify(["b", "c"]));
    expect(JSON.parse(merged!)).toEqual(["a", "b", "c"]);
  });

  it("is symmetric enough to converge (both sides end with the same set)", () => {
    const ab = JSON.parse(mergeEnabledLists(JSON.stringify(["a"]), JSON.stringify(["b"]))!);
    const ba = JSON.parse(mergeEnabledLists(JSON.stringify(["b"]), JSON.stringify(["a"]))!);
    expect(new Set(ab)).toEqual(new Set(ba));
  });

  it("unions object-shaped lists (newer core-plugins.json), enabling if either is on", () => {
    const local = JSON.stringify({ "file-explorer": true, graph: false });
    const remote = JSON.stringify({ graph: true, backlink: true });
    const merged = JSON.parse(mergeEnabledLists(local, remote)!);
    expect(merged).toEqual({ "file-explorer": true, graph: true, backlink: true });
  });

  it("returns 2-space-indented JSON (matches Obsidian's formatting)", () => {
    const merged = mergeEnabledLists(JSON.stringify(["a"]), JSON.stringify(["b"]));
    expect(merged).toBe('[\n  "a",\n  "b"\n]');
  });

  it("returns null on unparseable input or mismatched shapes (caller falls back)", () => {
    expect(mergeEnabledLists("not json", "[]")).toBeNull();
    expect(mergeEnabledLists(JSON.stringify(["a"]), JSON.stringify({ a: true }))).toBeNull();
  });
});
