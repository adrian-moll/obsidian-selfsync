# 00 — Overview

## What this is

A self-built **Obsidian plugin** for syncing and backing up a vault across
**Windows, iPad, and Android**, against a **user-controlled backend**. No
third-party managed service is required; with end-to-end encryption enabled, the
storage host only ever sees ciphertext.

## Why

The author already uses Obsidian on all three platforms. Existing community sync
plugins failed on two axes:

- **Mobile was unreliable** — sync worked on desktop but was flaky/incomplete on
  iPad and Android.
- **Setup was too complex** — hard to configure or fragile once running.

Obsidian Sync (the official paid service) works, but the data is hosted by a
third party and the author wants to **know and control where the data lives**
(data sovereignty is a hard requirement).

## What it does

1. **Two-way sync** of the entire vault (notes, attachments, binaries) against a
   **pluggable backend**.
   - **Primary backend:** a folder on **Infomaniak kDrive over WebDAV**.
   - **Alternative backend:** a **self-hostable CouchDB** (single Docker container).
2. **Optional end-to-end encryption** (configurable per backend, default ON).
3. **Optional, desktop-only Git backup** that auto-versions the vault (a commit
   per change set), independent of the sync backend.

## Design pillars

- **Mobile-first reliability.** An interrupted sync (the mobile OS killing the
  app mid-operation) must never corrupt the vault or the remote. The engine is
  crash-safe and reconciles on startup.
- **Data safety over convenience.** Conflicts produce a "keep both" copy; nothing
  is ever silently overwritten.
- **One engine, dumb backends.** A single sync engine runs over a thin storage
  abstraction, so every backend behaves identically and there is one code path to
  test.
- **Simple setup.** Sensible defaults, a first-run wizard, whole-vault sync out of
  the box.

## Document map

| Doc | Contents |
|-----|----------|
| `00-overview.md` | This file. |
| `01-requirements.md` | Functional and non-functional requirements. |
| `02-use-cases.md` | Concrete user scenarios. |
| `03-architecture.md` | Component layout and data flow. |
| `04-technical-decisions.md` | ADR-style record of locked decisions. |
| `05-sync-engine.md` | State DB, remote manifest, journal, reconciliation rules. |
| `06-backends.md` | `StorageBackend` contract, WebDAV notes, CouchDB + docker. |
| `07-encryption.md` | E2EE scheme, key handling, path privacy. |
| `08-git-backup.md` | Desktop-only versioning layer. |
| `09-roadmap.md` | Milestones, spikes, verification. |
| `10-ui-integration.md` | Status surfaces (ribbon/status bar/Sync view/Notices), conflict diff, file-history view. |
| `11-deployment.md` | BRAT install, release artifacts, GitHub Actions. |
| `12-testing.md` | The L1–L4 test pyramid (unit, containers, simulation, manual). |
