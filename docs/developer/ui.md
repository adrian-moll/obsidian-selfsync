# UI integration

How the plugin surfaces itself inside Obsidian so the user always knows **when
sync happens, when it errors, and when conflicts occur** (FR11/FR12) — across
desktop and mobile.

## Constraint that shapes everything

The Obsidian **status bar is not available on mobile** (`addStatusBarItem` is
documented as "Not available on mobile"). So the status bar cannot be the primary
indicator. The **ribbon icon** and a **sidebar view** — both of which work on
mobile and desktop — carry the state, with the status bar as a desktop-only
bonus.

## Status surfaces

### Ribbon icon (desktop + mobile) — primary indicator
- Reflects engine state via icon glyph / color / tooltip:
  - **Idle** — neutral icon, tooltip "Synced <relative time>".
  - **Syncing** — animated/spinner state, tooltip "Syncing… n/m".
  - **Error** — red/warning icon, tooltip with the error summary.
  - **Conflicts present** — badge/count.
- Primary click opens the **Sync view**; a secondary action triggers "Sync now".

### Status bar item (desktop only)
- Compact text mirroring the ribbon state: `Synced 2m ago` / `Syncing… 3/12` /
  `⚠ error` / `⚠ 2 conflicts`. Click focuses the Sync view.

### Sync view (`ItemView` in a sidebar; desktop + mobile) — the dashboard
Sections:
- **Status header** — current state, last-sync time (relative + absolute), active
  backend, layout (mirror/opaque), **files synced** count, **skipped (too large)**
  count, and a **Git changes pending push** indicator when a push is outstanding.
- **Actions** — **Sync now** and a **Test connection** button (runs the same
  WebDAV `testConnection()` used in settings and toasts the result).
- **Activity** — in-progress and queued operations; a scrolling recent-activity
  log (uploaded/downloaded/deleted/renamed, with timestamps).
- **Errors** — last error with details and a **Retry** button.
- **Conflicts** — the conflict list (below).

### Notices (toasts)
- **Prominent** for errors and for each newly created conflict.
- **Quiet / optional** for routine "sync complete" (configurable, off by default
  to avoid noise).

## Conflict resolution UX (FR12)

Text notes are **3-way auto-merged** when concurrent edits touch different regions
(D3); only genuinely overlapping edits — or non-text files — fall back to a "keep
both" conflict copy (`sync-engine.md`). The UI makes those remaining conflicts
easy to find and resolve:

- The Sync view's **Conflicts** section lists each conflict copy: canonical path,
  originating device, and timestamp.
- Selecting an entry opens a **side-by-side diff** of the two versions, so the user
  can compare and merge into the canonical file, editing the merged result inline.
- Saving writes the canonical file and deletes the conflict copy (which then
  propagates as a normal deletion).

## File-history view (desktop only) — see `git-backup.md`

The Git-backed history browser is a separate `ItemView`, gated by
`Platform.isDesktopApp`. Summarized here for UI completeness:

- Opened via the "Show file history" command for the **active note**.
- Lists commits for that file (date, message, hash) from `isomorphic-git log`.
- Selecting a commit shows a diff against the current version; **Restore** writes
  the old version back into the vault (then syncs normally).
- Hidden entirely on mobile.

## Commands (command palette + assignable hotkeys)

- **Sync now** — force a sync cycle.
- **Open sync panel** — reveal the Sync view.
- **Show file history** — open the file-history view for the active note (desktop).
- **Show conflicts** — focus the Conflicts section.

## Settings tab

- **Backend** — WebDAV endpoint / credentials / sync folder + a **Test WebDAV
  connection** button.
- **Encryption** — per-backend E2EE toggle; passphrase entry; verifier status.
- **Triggers** — startup on/off, interval length, debounce delay,
  quit/background flush on/off.
- **Max file size (MB)** — skip files above this to avoid the large-file OOM crash
  (notably Android); 0 disables. See `git-backup.md`/engine `maxFileBytes`.
- **Debug logging** — verbose leveled logging to a rotating `selfsync.log` in the
  plugin folder (`util/logger.ts`; mobile-safe via `DataAdapter.append`).
- **Scope** — advanced exclude globs (defaults to whole vault).
- **Git backup** (desktop only) — enable, remote URL/credentials, **Test Git
  connection**, commit cadence, backup excludes, and **compact history to
  snapshot**.
- **Notifications** — which events raise Notices.

## Mobile summary

On mobile the user sees: the **ribbon icon** state, the **Sync view** (same as
desktop minus file-history), and **Notices** for errors/conflicts. No status bar,
no Git features. This is the concrete answer to the past "mobile felt like a black
box" problem — the Sync view gives an always-available status readout.
