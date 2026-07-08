# Deployment & release

Distribution target: **private, via BRAT** — installable and auto-updating on all
platforms **including mobile**, without going through the official community-store
review (D10 / FR14). The community store remains an option later.

## Build artifacts

An Obsidian plugin is three files placed in
`<vault>/.obsidian/plugins/<plugin-id>/`:

- `main.js` — the bundled plugin (esbuild output).
- `manifest.json` — id, name, version, `minAppVersion`, `isDesktopOnly` (**false**
  — the sync path is cross-platform; Git features self-gate at runtime).
- `styles.css` — plugin styles.

## Repository layout for releases

- A **GitHub repository** for the plugin.
- Repo root also contains `manifest.json` and **`versions.json`** (maps plugin
  version → minimum Obsidian version) — required for BRAT/Obsidian to pick a
  compatible release. The floor is currently **1.12.3** (large-file downloads use
  `DataAdapter.appendBinary`, added in 1.12.3); don't lower it, and keep
  `versions.json` in sync when it changes.
- **Tagged releases**: each release tag (e.g. `1.2.0`, matching `manifest.json`
  `version`) has `main.js`, `manifest.json`, and `styles.css` attached as assets.

## Release process (automated)

A **GitHub Actions** workflow, triggered on a version tag:

1. Install deps, run the test suite (L1–L3, see `testing.md`).
2. `esbuild` production build → `main.js`.
3. Create a GitHub Release for the tag and upload the three assets.

Version bumping: update `version` in `manifest.json` and add the entry to
`versions.json`, commit, then push the matching tag. (A small `version-bump`
script keeps these in sync — mirrors the Obsidian sample-plugin convention.)

## Installing via BRAT (recommended)

1. Install the **BRAT** community plugin on each device (desktop, iPad, Android).
2. In BRAT, "Add beta plugin" → the plugin's GitHub repo.
3. BRAT downloads the latest release into the plugin folder and **auto-updates**
   on subsequent releases.

This is the key win for the user's setup: BRAT handles file placement on
**mobile**, which is otherwise the most painful part of installing a non-store
plugin.

## Manual install (fallback)

Copy `main.js`, `manifest.json`, and `styles.css` into
`<vault>/.obsidian/plugins/<plugin-id>/` and enable the plugin in
Settings → Community plugins. On mobile this requires a file manager to reach the
vault folder, which is why BRAT is preferred there.

## Bootstrap nuance

The plugin can sync `.obsidian` (D6), so in principle installing on one device
could propagate the plugin to others. But the **first** sync on a new device
requires the plugin to already be present to run — a chicken-and-egg. Therefore
BRAT is the clean per-device **bootstrap**; after that, updates come from BRAT (or,
if `.obsidian` sync is enabled, from sync — with BRAT as the reliable fallback).

## Community store (deferred)

Publishing to the official community plugin list would give one-click install and
auto-update for anyone, but requires review, broader hardening, and ongoing
support for arbitrary users. Out of scope initially; the release layout above is
already store-compatible, so the door stays open.
