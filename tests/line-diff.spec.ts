import { describe, expect, it } from "vitest";
import { lineDiff } from "../src/util/line-diff.js";
import { canonicalPathOf, isConflictCopy } from "../src/engine/engine.js";

describe("lineDiff", () => {
  it("marks unchanged lines as not changed", () => {
    const rows = lineDiff("a\nb\nc", "a\nb\nc");
    expect(rows.every((r) => !r.changed)).toBe(true);
    expect(rows.map((r) => r.left)).toEqual(["a", "b", "c"]);
  });

  it("aligns a single changed line", () => {
    const rows = lineDiff("a\nb\nc", "a\nX\nc");
    const changed = rows.filter((r) => r.changed);
    // the middle line differs → one row with left "b", one with right "X"
    expect(changed.some((r) => r.left === "b" && r.right === null)).toBe(true);
    expect(changed.some((r) => r.left === null && r.right === "X")).toBe(true);
    // unchanged anchors preserved
    expect(rows.some((r) => !r.changed && r.left === "a")).toBe(true);
    expect(rows.some((r) => !r.changed && r.left === "c")).toBe(true);
  });

  it("handles added lines on the right", () => {
    const rows = lineDiff("a", "a\nb");
    expect(rows.find((r) => r.right === "b" && r.left === null)?.changed).toBe(true);
  });
});

describe("conflict-copy path helpers", () => {
  it("round-trips canonical ↔ conflict copy", () => {
    const copy = "Notes/todo (conflict deviceA 2026-01-01T00-00-00Z).md";
    expect(isConflictCopy(copy)).toBe(true);
    expect(canonicalPathOf(copy)).toBe("Notes/todo.md");
  });

  it("leaves a normal path unchanged", () => {
    expect(isConflictCopy("Notes/todo.md")).toBe(false);
    expect(canonicalPathOf("Notes/todo.md")).toBe("Notes/todo.md");
  });
});
