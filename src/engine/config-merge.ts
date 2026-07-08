/**
 * Conflict resolution for `.obsidian` CONFIG files (not notes). Config is
 * settings — regenerable, and churned per device — so unlike notes it should
 * auto-resolve instead of producing keep-both conflict copies (which are noisy,
 * especially the enabled-plugin lists that change on every install/toggle).
 *
 * Policy (D3, config amendment):
 *   - The enabled-plugin lists (community-plugins.json / core-plugins.json) merge
 *     as a UNION, so both devices' plugins stay enabled — nothing is lost. Works
 *     without a common base (union is symmetric). Downside: disabling a plugin on
 *     one device won't disable it on the other.
 *   - Every other `.obsidian` config file resolves newest-wins (handled by the
 *     engine using mtime), so no conflict copies are created under `.obsidian`.
 *
 * Notes (everything outside `.obsidian`) are unaffected — they still keep-both.
 */

/** Whether a synced path is an Obsidian config file (under `.obsidian/`). */
export function isObsidianConfig(path: string): boolean {
  return path.startsWith(".obsidian/");
}

/** The enabled-plugin list files, whose conflicts are union-merged. */
export function isEnabledPluginList(path: string): boolean {
  return path === ".obsidian/community-plugins.json" || path === ".obsidian/core-plugins.json";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Union-merge two enabled-plugin lists. Handles both on-disk shapes Obsidian has
 * used: a JSON array of ids (community-plugins.json, older core-plugins.json) or a
 * `{ id: boolean }` object map (newer core-plugins.json). Returns the merged JSON
 * (2-space indented, matching Obsidian's own formatting) or null if the inputs
 * can't be parsed / don't match a known shape — in which case the caller falls
 * back to newest-wins.
 */
export function mergeEnabledLists(localJson: string, remoteJson: string): string | null {
  let a: unknown;
  let b: unknown;
  try {
    a = JSON.parse(localJson);
    b = JSON.parse(remoteJson);
  } catch {
    return null;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    const seen = new Set<string>();
    const out: unknown[] = [];
    for (const x of [...a, ...b]) {
      const key = typeof x === "string" ? x : JSON.stringify(x);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(x);
      }
    }
    return JSON.stringify(out, null, 2);
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const out: Record<string, unknown> = { ...a };
    for (const [k, v] of Object.entries(b)) {
      if (!(k in out)) out[k] = v;
      // Enabled if EITHER device has it enabled (union of the "on" set).
      else if (typeof out[k] === "boolean" || typeof v === "boolean") out[k] = Boolean(out[k]) || Boolean(v);
      // Non-boolean clash: keep local's value (stable, arbitrary).
    }
    return JSON.stringify(out, null, 2);
  }

  return null; // unknown / mismatched shapes → caller resolves newest-wins
}
