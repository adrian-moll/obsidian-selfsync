/**
 * 3-way text merge for auto-resolving concurrent edits (D3, amended): when two
 * devices edit DIFFERENT regions of a note, merge them automatically; only
 * genuinely overlapping edits fall back to a keep-both conflict copy. Never loses
 * data either way.
 *
 * Uses node-diff3 on lines, with the common ancestor (last-synced version) as the
 * base — see BaseStore.
 */
import { merge as diff3 } from "node-diff3";

const EOL = /\r?\n/;

/**
 * Attempt a 3-way line merge. Returns the merged text, or null if the two sides'
 * changes overlap (caller should keep both).
 */
export function mergeText(base: string, local: string, remote: string): string | null {
  // node-diff3 merge(a, o, b): a = "ours" (local), o = original (base), b = "theirs" (remote).
  const result = diff3(local.split(EOL), base.split(EOL), remote.split(EOL));
  if (result.conflict) return null;
  return result.result.join("\n");
}

const TEXT_EXTENSIONS = [".md", ".markdown", ".txt", ".text"];

/** Whether a path is a text note we can safely line-merge. */
export function isMergeableText(path: string): boolean {
  const lower = path.toLowerCase();
  return TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
