/**
 * Path exclusion for sync (FR8). Excluded paths are never uploaded, downloaded,
 * or deleted — they're invisible to reconciliation.
 *
 * The defaults keep device-specific / volatile files out of sync. Most
 * importantly, SelfSync's OWN plugin folder is excluded: its data.json (settings
 * + per-device sync state) differs on every device, so syncing it produces
 * endless conflict copies. Obsidian workspace files are per-device too.
 */
export const DEFAULT_EXCLUDES: string[] = [
  ".obsidian/plugins/selfsync/**", // our own plugin + state (device-specific)
  ".obsidian/workspace.json",
  ".obsidian/workspace-mobile.json",
  ".obsidian/workspace",
  ".trash/**",
];

/** Convert a simple glob to a RegExp. `**` matches across `/`; `*` within a segment. */
export function globToRegExp(glob: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*"; // ** → anything, including path separators
        i += 2;
        if (glob[i] === "/") i += 1; // consume the slash in "**/"
      } else {
        re += "[^/]*"; // * → within a single path segment
        i += 1;
      }
    } else if ("\\^$.|?+()[]{}".includes(c)) {
      re += "\\" + c;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  re += "$";
  return new RegExp(re);
}

/** Build a predicate matching any of the given glob patterns. */
export function makeExcluder(patterns: string[]): (path: string) => boolean {
  const regexps = patterns.filter((p) => p.trim().length > 0).map(globToRegExp);
  return (path: string) => regexps.some((r) => r.test(path));
}
