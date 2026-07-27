/**
 * Human-readable summaries of a sync cycle's operations, for the plugin's
 * activity log and the headless client's stdout. Pure — no Obsidian import.
 */
import type { Op } from "../types.js";

export function describeOp(o: Op): string {
  switch (o.kind) {
    case "upload":
      return `↑ ${o.path}`;
    case "download":
      return `↓ ${o.path}`;
    case "deleteLocal":
      return `del-local ${o.path}`;
    case "deleteRemote":
      return `del-remote ${o.path}`;
    case "conflict":
      return `concurrent-edit ${o.path}`;
    case "move":
      return `move ${o.from} → ${o.to}`;
  }
}

export function summarizeOps(ops: Op[]): string {
  const shown = ops.slice(0, 6).map(describeOp);
  const extra = ops.length > shown.length ? ` (+${ops.length - shown.length} more)` : "";
  return shown.join(", ") + extra;
}
