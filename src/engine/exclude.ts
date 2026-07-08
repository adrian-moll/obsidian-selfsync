/**
 * Path exclusion for sync (FR8). Excluded paths are never uploaded, downloaded,
 * or deleted — they're invisible to reconciliation.
 *
 * The defaults keep device-specific / volatile files out of sync. Most
 * importantly, SelfSync's OWN plugin folder is excluded: its data.json (settings
 * + per-device sync state) differs on every device, so syncing it produces
 * endless conflict copies. Obsidian workspace files are per-device too.
 */
/** Always excluded, regardless of the config-sync setting. */
export const DEFAULT_EXCLUDES: string[] = [
  ".obsidian/plugins/selfsync/**", // our own plugin + state (device-specific)
  ".git/**", // the desktop Git-backup repo — device-local, must never sync
  ".trash/**",
];

/** Excludes the whole Obsidian config folder (opt-out via the config-sync setting). */
export const OBSIDIAN_CONFIG_GLOB = ".obsidian/**";

/**
 * Kept excluded even when the user opts to sync `.obsidian`, so that config sync
 * carries the portable stuff (appearance, hotkeys, snippets, themes, and each
 * plugin's CODE — manifest/main.js/styles.css — so plugins install & enable on a
 * new device) but NOT the device-specific parts:
 *   - workspace files: Obsidian rewrites these per device → sync churn.
 *   - cache: device-local search/index cache.
 *   - plugins/<id>/data.json: each plugin's SETTINGS + per-device state, often
 *     including secrets. Excluding it avoids conflict copies inside plugin folders
 *     and plaintext secret upload; each device keeps its own plugin settings, and a
 *     plugin migrates its own local data on update (the normal upgrade path). A
 *     plugin that stores per-device state outside data.json can be added to the
 *     user's Extra exclude patterns.
 */
export const OBSIDIAN_CONFIG_EXCLUDES: string[] = [
  ".obsidian/workspace.json",
  ".obsidian/workspace-mobile.json",
  ".obsidian/workspace",
  ".obsidian/cache",
  ".obsidian/plugins/*/data.json",
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

/**
 * Assemble the full exclude glob list for a sync from the user's settings:
 * always-on defaults, then either the whole `.obsidian` folder (config sync off)
 * or just the device-specific bits (config sync on), then the user's extra globs.
 * Pure (no Obsidian import) so it's unit-tested directly.
 */
export function buildExcludePatterns(settings: {
  syncObsidianConfig: boolean;
  excludeGlobs: string[];
}): string[] {
  const patterns = [...DEFAULT_EXCLUDES];
  if (settings.syncObsidianConfig) patterns.push(...OBSIDIAN_CONFIG_EXCLUDES);
  else patterns.push(OBSIDIAN_CONFIG_GLOB);
  patterns.push(...settings.excludeGlobs);
  return patterns;
}
