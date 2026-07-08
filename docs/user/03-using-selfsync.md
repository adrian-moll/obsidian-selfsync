# Using SelfSync

Once a [backend is set up](02-backend-setup.md) on each device, SelfSync mostly
runs itself. Here's what you see and control.

## When does it sync?

SelfSync syncs on several triggers so you rarely think about it:

- **On startup** — reconciles the moment Obsidian opens (the reliable backbone).
- **On an interval** — every few minutes (configurable).
- **On change** — shortly after you stop typing/editing (debounced).
- **On background/close** — best-effort flush when the app is backgrounded.

You can always force one with **Sync now**.

### Manual-only mode

Prefer to sync only when *you* decide? Turn off **Automatic sync** in
**Settings → SelfSync**. All the automatic triggers above stop, and your vault is
left untouched until you run **Sync now** (command, ribbon, or Advanced) — which
still works normally. Handy on a metered connection, or while reorganizing a lot
of files and you don't want mid-edit syncs.

## The status panel

Open the **SelfSync** view from the ribbon icon (works on desktop and mobile). It
shows:

- **Status** — idle / syncing / error, the last-sync time, and the active backend.
- **Activity** — a running log of what synced (uploaded / downloaded / deleted /
  renamed), with a **Copy** button so you can grab it if you need to report a
  problem.
- **Errors** — the last error with a **Retry**.
- **Conflicts** — any files that need your attention (below).

On desktop there's also a compact indicator in the status bar. On mobile the
ribbon icon and this panel are your window into what's happening — no more
guessing.

## Conflicts

Edit the same note on two devices and SelfSync protects both versions:

- If the edits touch **different parts** of the note, they're **merged
  automatically** — you don't have to do anything.
- If they **overlap** (or the file isn't text), SelfSync keeps **both** versions:
  your file plus a **conflict copy**, so nothing is lost.

To resolve a conflict copy:

1. Open the **Conflicts** section in the SelfSync panel — each entry shows the
   file, the device it came from, and when.
2. Click it to open a **side-by-side diff** of the two versions.
3. Edit the merged result and **save** — SelfSync writes your merged file and
   removes the conflict copy (which then disappears on your other devices too).

## Deletes and renames

Deleting or moving a file on one device propagates correctly to the others — a
deleted file won't be resurrected by a device that still had the old copy, and a
move is carried across as a move (not a delete-and-recreate).

## Git backup (desktop only)

Optionally, SelfSync can version your vault to a **Git remote** (e.g. a self-hosted
Gitea/GitLab, or GitHub) so you have full history. This is **desktop-only** —
mobile Obsidian can't run Git — and is independent of syncing.

Enable it under **Settings → SelfSync → Git backup** and set the remote URL and a
token/password. Then:

- **Auto-commit after sync** (opt-in) commits changes as they settle, or use the
  **Git backup: commit now** command / panel button.
- **File history** — run **Show file history** on the active note to see its
  commits; preview any version, diff two versions or a version against the current
  file, and **Restore** an old one back into your vault (it then syncs normally).

> Large first-time backups are committed and pushed in batches so they get through
> server/proxy timeouts. If a push times out it's retried on later syncs. See
> [Troubleshooting](05-troubleshooting.md) if pushes keep failing.
