import { describe, expect, it } from "vitest";
import { isMergeableText, mergeText } from "../src/engine/merge.js";

describe("mergeText (3-way)", () => {
  const base = "# Title\n\npara one\n\npara two\n\npara three\n";

  it("merges edits in separate regions", () => {
    const local = base.replace("para one", "para one EDITED");
    const remote = base.replace("para three", "para three EDITED");
    const merged = mergeText(base, local, remote);
    expect(merged).not.toBeNull();
    expect(merged).toContain("para one EDITED");
    expect(merged).toContain("para three EDITED");
  });

  it("returns null when the same line is edited on both sides", () => {
    const local = base.replace("para two", "para two — LOCAL");
    const remote = base.replace("para two", "para two — REMOTE");
    expect(mergeText(base, local, remote)).toBeNull();
  });

  it("takes the changed side when only one side changed", () => {
    const local = base.replace("para one", "para one EDITED");
    expect(mergeText(base, local, base)).toBe(local);
  });

  it("recognizes mergeable text extensions", () => {
    expect(isMergeableText("Notes/todo.md")).toBe(true);
    expect(isMergeableText("a.txt")).toBe(true);
    expect(isMergeableText("image.png")).toBe(false);
    expect(isMergeableText("data.canvas")).toBe(false);
  });
});
