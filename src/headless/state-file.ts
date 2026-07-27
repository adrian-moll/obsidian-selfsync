/**
 * File-backed State DB for the headless client.
 *
 * The plugin stores its State DB in IndexedDB (with data.json as a fallback);
 * neither exists in a container, so we use the same JsonStateStore with a persist
 * callback that writes `<stateDir>/state.json`. The engine batches writes — one
 * flush per committed manifest chunk — so serializing the whole snapshot per
 * flush is not the hot path.
 *
 * Losing this file is safe: the next sync re-indexes against the remote manifest.
 * It's still written atomically (tmp + rename) so a crash mid-write can't leave a
 * truncated JSON that would silently drop every file's merge base.
 */
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { JsonStateStore } from "../engine/state-db.js";
import type { StateEntry } from "../types.js";

export const STATE_FILE_NAME = "state.json";

/** Write a file atomically within its own directory. */
export async function writeFileAtomic(file: string, contents: string): Promise<void> {
  await fs.mkdir(nodePath.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, contents, "utf-8");
  await fs.rename(tmp, file);
}

/**
 * Load the persisted state entries, or [] if absent/corrupt. `onWarn` reports a
 * corrupt file — silently re-indexing would look like an unexplained full resync.
 */
export async function loadStateEntries(stateDir: string, onWarn?: (msg: string) => void): Promise<StateEntry[]> {
  const file = nodePath.join(stateDir, STATE_FILE_NAME);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch {
    return []; // first run
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return parsed as StateEntry[];
  } catch (e) {
    onWarn?.(`State DB at ${file} is unreadable (${(e as Error).message}) — re-indexing from the remote manifest`);
    return [];
  }
}

export async function createFileStateStore(stateDir: string, onWarn?: (msg: string) => void): Promise<JsonStateStore> {
  const file = nodePath.join(stateDir, STATE_FILE_NAME);
  const initial = await loadStateEntries(stateDir, onWarn);
  return new JsonStateStore(initial, async (all) => {
    await writeFileAtomic(file, JSON.stringify(all));
  });
}
