/**
 * Vault file watcher for the headless client — the counterpart of the plugin's
 * `vault.on("modify" | "create" | "delete" | "rename")` hooks.
 *
 * It is an ACCELERATOR, never the source of truth: convergence is guaranteed by
 * the startup and interval syncs, so a missed or coalesced event only delays a
 * cycle. That's why a platform without recursive watching degrades to a warning
 * rather than an error.
 *
 * Events are not suppressed while a sync is running. The engine's own downloads
 * do fire events, but the debounce plus the scheduler's cooldown absorb them and
 * a redundant cycle is a cheap no-op — whereas dropping events during a sync can
 * lose a real edit made in that window.
 */
import { watch, type FSWatcher } from "node:fs";
import * as fs from "node:fs/promises";

export interface VaultWatcher {
  close(): void;
}

export interface WatchOptions {
  root: string;
  /** Same excluder the sync uses, so ignored paths never trigger a cycle. */
  exclude: (path: string) => boolean;
  onChange: (path: string) => void;
  log?: { info(m: string): void; warn(m: string): void; debug(m: string): void };
}

const NO_OP_WATCHER: VaultWatcher = { close: () => {} };

export async function watchVault(opts: WatchOptions): Promise<VaultWatcher> {
  const log = opts.log;
  try {
    // A missing vault dir would make watch() throw ENOENT; create it so a fresh
    // volume starts watching immediately instead of only after the first sync.
    await fs.mkdir(opts.root, { recursive: true });
  } catch {
    // If we can't create it, watch() reports the real problem below.
  }

  let watcher: FSWatcher;
  try {
    watcher = watch(opts.root, { recursive: true, persistent: true });
  } catch (e) {
    log?.warn(
      `Recursive file watching unavailable (${(e as Error).message}) — ` +
        "falling back to interval-only sync; local edits sync on the next interval",
    );
    return NO_OP_WATCHER;
  }

  watcher.on("change", (_event, filename) => {
    if (!filename) return;
    const path = filename.toString().split(/[\\/]/).join("/");
    if (opts.exclude(path)) return;
    log?.debug(`change ${path}`);
    opts.onChange(path);
  });

  watcher.on("error", (e) => {
    // Keep running: the interval trigger still converges without the watcher.
    log?.warn(`File watcher error (interval sync continues): ${e.message}`);
  });

  log?.info(`Watching ${opts.root} for changes`);
  return { close: () => watcher.close() };
}
