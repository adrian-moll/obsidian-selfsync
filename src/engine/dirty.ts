/**
 * Local-change tracking between syncs, fed by the app's file events.
 *
 * File events don't distinguish the user's edits from SelfSync's own writes: a
 * sync that downloads files fires modify/create events for them, which used to
 * schedule a second full sync for nothing. So events only mark paths as
 * *possibly* changed; {@link hasRealLocalChanges} then compares each against the
 * State DB (the last-synced size + mtime — the same shortcut scanVault uses) and
 * ignores paths that already match. It runs when the debounced sync fires, by
 * which time the triggering sync has committed its state.
 *
 * Pure (no Obsidian import) so it is unit-tested directly.
 */
import type { StateStore } from "./state-db.js";

/** Current size + mtime of a vault file, or null if it is absent / not a file. */
export type FileStatLookup = (path: string) => { size: number; mtime: number } | null;

/** Whether any of `paths` differs from what the last sync recorded. */
export async function hasRealLocalChanges(
  paths: Iterable<string>,
  lookup: FileStatLookup,
  state: StateStore,
  exclude: (path: string) => boolean = () => false,
): Promise<boolean> {
  for (const path of paths) {
    if (exclude(path)) continue;
    const current = lookup(path);
    const synced = await state.get(path);
    const known = synced && !synced.deleted ? synced : undefined;
    if (current) {
      if (!known || known.size !== current.size || known.mtime !== current.mtime) return true;
    } else if (known) {
      return true; // deleted (or renamed away) since the last sync
    }
  }
  return false;
}
