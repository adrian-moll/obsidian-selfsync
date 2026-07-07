# SelfSync — User guide

SelfSync keeps an [Obsidian](https://obsidian.md) vault in sync across your
devices (Windows, iPad, Android) using a **WebDAV backend you control** — either a
hosted provider like Infomaniak kDrive, or a small server you self-host. No
third-party managed sync service, and your notes live where you decide.

What you get:

- **Two-way sync** of your whole vault — notes, attachments, and other files.
- **Safe conflict handling** — edit the same note on two devices and nothing is
  lost: SelfSync merges non-overlapping changes automatically and keeps both
  copies only when edits truly collide.
- **Crash-safe** — if a device is interrupted mid-sync, the next start cleans up;
  your vault and remote are never corrupted.
- **Optional Git backup** (desktop) — version history you can browse and restore
  from.

## Guide

1. [Install](01-install.md) — add the plugin via BRAT on each device.
2. [Set up a backend](02-backend-setup.md) — self-host a WebDAV server, or use a
   hosted provider like kDrive.
3. [Using SelfSync](03-using-selfsync.md) — syncing, the status panel, conflicts,
   and Git backup.
4. [Encryption](04-encryption.md) — what it will protect *(not yet available)*.
5. [Troubleshooting](05-troubleshooting.md) — common messages and fixes.

> Looking for how it works under the hood? See the
> [Developer guide](../developer/).
