# Install

**Requires Obsidian 1.12.3 or newer** on every device (SelfSync uses the
`appendBinary` API introduced in 1.12.3 to stream large files without crashing on
mobile). Update Obsidian first if you're on an older version.

SelfSync isn't in the Obsidian community plugin store yet. Install it with
**BRAT** ([Beta Reviewer's Auto-update Tool](https://github.com/TfTHacker/obsidian42-brat)),
which works on desktop **and** mobile and keeps the plugin auto-updated.

## Steps (repeat on every device)

1. In Obsidian, open **Settings → Community plugins**, install and enable **BRAT**.
2. Open **BRAT → Add beta plugin** and enter:
   ```
   adrian-moll/obsidian-selfsync
   ```
3. Back in **Community plugins**, enable **SelfSync**.
4. Repeat on each device you sync (Windows, iPad, Android).

Next: [set up a backend](02-backend-setup.md), then come back and run your first
sync.

## Manual install (fallback)

If you'd rather not use BRAT, copy `main.js`, `manifest.json`, and `styles.css`
from the [latest release](https://github.com/adrian-moll/obsidian-selfsync/releases)
into your vault's `.obsidian/plugins/selfsync/` folder, then enable the plugin in
**Community plugins**. (You'll need to repeat this to update.)

## A note on `.obsidian` config sync

By default SelfSync syncs your **notes and attachments** but **not** the
`.obsidian` config folder. You can turn **Sync Obsidian config folder** on in
**Settings → SelfSync** if you want your setup to follow you across devices.

When it's on, SelfSync syncs the **portable** config — appearance, hotkeys,
snippets, themes, and your **installed plugins themselves** (so the same plugins
appear and enable on every device) — but deliberately keeps the **device-specific**
parts local:

- **Each plugin's own settings** (`data.json`) stay on the device. A plugin starts
  with default settings on a new device (configure it once there). This avoids
  conflict copies inside plugin folders and never uploads plugin secrets (API
  tokens) to your server.
- **Workspace layout** and **cache** are never synced (Obsidian rewrites them per
  device).

If a specific plugin keeps per-device state somewhere other than `data.json`, add
that path to **Extra exclude patterns**.

> **Turning it on later won't delete anything.** Any plugin `data.json` a previous
> version already uploaded is simply left on the backend; reclaim that space with
> **Advanced → Clean up excluded files**.

## Setting up a new device quickly (share your config)

You don't have to re-enter all your settings on each device. On a device that's
already set up, open **Advanced → Export config to backend** — this publishes your
non-secret settings (exclude patterns, sync interval, WebDAV URL/username…) to the
backend. Your **password and encryption passphrase are never included**, and neither
is your **Git backup** setup — Git is desktop-only and configured per device.

On a **new** device, install SelfSync, enter the WebDAV URL, credentials, and sync
folder, and **Save**. SelfSync then detects the shared config and offers to import
it before the first sync. You only need to type the secrets (password, and
passphrase if encryption is on). You can re-pull the latest config anytime with
**Advanced → Import config from backend**.

(On an encrypted backend, set your passphrase first — the shared config is stored
encrypted too, so the host only ever sees ciphertext.)
