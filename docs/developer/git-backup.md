# Git backup (desktop only)

An **optional, desktop-only** feature that auto-versions the vault to a Git
remote. It is a **backup/versioning** layer, completely independent of the sync
transport (D7). It lets the user browse history and restore older note versions
(UC9).

> **Status: implemented (M5, hardened in 0.6.0).** `src/git/git-backup.ts`
> (`GitBackup`) is dynamically imported only on desktop, so mobile never loads
> `isomorphic-git`/Node `fs`. It auto-commits after each sync (opt-in), exposes
> "commit now" / "push now" commands and buttons in the Sync panel, and a
> **File-history view** (`src/ui/file-history-view.ts`) shows an active note's
> commits with view/restore. `.gitignore` is seeded to exclude SelfSync's own
> (`.obsidian/plugins/selfsync/`) data; `.git/**` is excluded from *sync*.
>
> **Chunked backup:** commits + pushes in batches, cutting a batch at
> `git.pushChunkSize` files **or** ~25 MB of content (`DEFAULT_MAX_PUSH_BYTES`),
> whichever comes first — bounding by *bytes* (not just file count) is what keeps
> each push a small pack isomorphic-git can complete, since a first backup with
> large attachments would otherwise be one huge push that stalls/resets. Pushes are
> throttled and a pending push is retried on later syncs until it lands. If pushes
> still fail, push over SSH or raise the Gitea/reverse-proxy request timeout
> (git-over-HTTP via isomorphic-git is weak on very large single pushes). Tested
> headlessly against a real temp repo (incl. byte-based splitting).

## Why desktop-only

Mobile Obsidian cannot run git or shell commands, and the sync engine already
handles cross-device propagation. Git here is about **history**, not transport, so
restricting it to desktop is a clean, deliberate scope decision. The feature is
gated by `Platform.isDesktopApp` and is hidden/disabled in the mobile UI.

## Implementation

- **`isomorphic-git`** — a pure-JS git implementation, bundled with the plugin. It
  does **not** require the user to have a system `git` binary installed.
- Operates directly on the vault folder on disk (Node `fs`, desktop only — the
  only place Node APIs are used).
- Commits on a schedule / after sync settles: detect changes → stage → commit with
  a generated message (e.g. timestamp + change summary) → push to the configured
  remote over HTTPS with credentials.
- Self-hosted remotes (Gitea, GitLab, etc.) fit the data-sovereignty goal (NFR5).

## Relationship to sync

- Git backup and the sync engine are **independent**. Git commits the local vault
  state; it does not read or write the manifest, blobs, or State DB.
- Recommended ordering when both run on a desktop: let a sync settle, then commit,
  so commits reflect a converged state. This is a scheduling nicety, not a
  correctness requirement.

## Configuration (settings)

- Enable/disable Git backup (only shown on desktop).
- Remote URL + credentials (token/password over HTTPS).
- **Test connection** — `GitBackup.testRemote()` uses `isomorphic-git`
  `getRemoteInfo2` (`forPush: true`) to verify the remote is reachable with the
  configured credentials, without committing or pushing.
- Commit cadence (after sync / on interval / manual).
- Optional author name/email for commits.
- **Git backup excludes** (`git.excludeGlobs`) — extra patterns written into a
  *managed block* of `.gitignore` (delimited by marker comments); content outside
  the block is preserved and the block is updated in place on re-init. Use it to
  keep large/churning attachments out of the backup (see history size below).

## History size & compaction

`.git` lives at the vault root and history is **unbounded**. Text history is cheap
(delta-compressed), but **every version of a binary attachment is stored in full**,
so binaries are the real source of bloat. Two levers manage this:

- **Preventive:** exclude large/binary attachments via `git.excludeGlobs` so notes
  keep full history while binaries stop inflating `.git`.
- **Reclaim:** `GitBackup.compactHistory()` — deletes `.git`, re-inits, makes one
  fresh `SelfSync snapshot` commit of the current tree, and force-pushes to replace
  remote history. `isomorphic-git` has **no gc/repack**, so re-initializing the repo
  is the only way to actually reclaim disk from old history. This is **destructive
  and irreversible** (past versions can no longer be restored), so it is gated
  behind a confirmation modal and exposed as the "Git backup: compact history to
  snapshot" command / settings button. Desktop-only.

## Non-goals

- No git operations on mobile.
- Not a replacement for the sync engine — it is additive history/backup.
- No conflict resolution via git; the sync engine owns conflicts.
