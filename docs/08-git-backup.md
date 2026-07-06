# 08 — Git backup (desktop only)

An **optional, desktop-only** feature that auto-versions the vault to a Git
remote. It is a **backup/versioning** layer, completely independent of the sync
transport (D7). It lets the user browse history and restore older note versions
(UC9).

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
- Commit cadence (after sync / on interval / manual).
- Optional author name/email for commits.
- Optional `.gitignore` seeding (e.g. exclude `.obsidian/workspace*`,
  plugin caches).

## Non-goals

- No git operations on mobile.
- Not a replacement for the sync engine — it is additive history/backup.
- No conflict resolution via git; the sync engine owns conflicts.
