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
`.obsidian` config folder — app settings, workspace layout, and plugin data churn
differently on each device and tend to cause noise. You can turn config sync on in
**Settings → SelfSync** if you want it, but leaving it off is recommended.
