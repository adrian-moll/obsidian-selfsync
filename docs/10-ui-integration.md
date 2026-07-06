# 10 — UI integration

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
- **Status header** — current state, last-sync time, active backend, E2EE on/off.
- **Activity** — in-progress and queued operations; a scrolling recent-activity
  log (uploaded/downloaded/deleted/renamed, with timestamps).
- **Errors** — last error with details and a **Retry** button.
- **Conflicts** — the conflict list (below).

### Notices (toasts)
- **Prominent** for errors and for each newly created conflict.
- **Quiet / optional** for routine "sync complete" (configurable, off by default
  to avoid noise).

## Conflict resolution UX (D9 / FR12)

Conflicts are never auto-merged — the engine writes a "keep both" copy
(`05-sync-engine.md`). The UI makes them easy to find and resolve:

- The Sync view's **Conflicts** section lists each conflict copy: canonical path,
  originating device, and timestamp.
- Selecting an entry opens a **side-by-side diff** of the two versions (built on
  Obsidian's bundled CodeMirror), so the user can compare and **merge manually**
  into the canonical file.
- Once merged, the user **dismisses** the conflict, which deletes the conflict
  copy (which then propagates as a normal deletion).
- No automatic three-way merge — this keeps data safety absolute and avoids a
  merge-editor's bug surface.

## File-history view (desktop only) — see `08-git-backup.md`

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

- **Backend** — choose WebDAV or CouchDB; endpoint/credentials; test connection.
- **Encryption** — per-backend E2EE toggle; passphrase entry; verifier status.
- **Triggers** — startup on/off, interval length, debounce delay,
  quit/background flush on/off.
- **Scope** — advanced exclude globs (defaults to whole vault).
- **Git backup** (desktop only) — enable, remote URL/credentials, commit cadence.
- **Notifications** — which events raise Notices.

## Mobile summary

On mobile the user sees: the **ribbon icon** state, the **Sync view** (same as
desktop minus file-history), and **Notices** for errors/conflicts. No status bar,
no Git features. This is the concrete answer to the past "mobile felt like a black
box" problem — the Sync view gives an always-available status readout.
