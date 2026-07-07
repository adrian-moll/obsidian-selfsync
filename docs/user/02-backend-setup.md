# Set up a backend

SelfSync syncs against a **WebDAV** server you control. Pick one of two paths:

- **Self-host a WebDAV server** (recommended if you don't already pay for one) —
  one small Docker container, described below.
- **Use a hosted provider** like Infomaniak kDrive — if you already have one.

Either way, you end up with three things to enter in **Settings → SelfSync**: a
**URL**, a **username**, and a **password**.

---

## Option A — Self-host a WebDAV server (Apache)

The repo ships a ready-to-run WebDAV server (Apache `mod_dav`) in
[`docker/`](../../docker). On any machine with Docker:

```bash
cd docker
# set your own credentials first (edit docker-compose.yml or export these):
#   WEBDAV_USER, WEBDAV_PASSWORD
docker compose up -d webdav
```

This serves WebDAV on port **8080** and stores data in a Docker volume. In
SelfSync set:

| Field | Value |
|-------|-------|
| WebDAV URL | `http://<server-host>:8080` |
| WebDAV username | your `WEBDAV_USER` (default `selfsync`) |
| WebDAV password | your `WEBDAV_PASSWORD` (change it from the default!) |
| Sync folder | e.g. `selfsync` (created automatically) |

### Put HTTPS in front (important)

Plain `http://` is fine for testing on the same machine, but for real use across
devices you need **HTTPS**:

- **Mobile Obsidian effectively requires HTTPS** — plain HTTP endpoints are
  refused or distrusted.
- Without TLS your password and note contents cross the network in the clear.

Put a TLS-terminating reverse proxy (e.g. [Caddy](https://caddyserver.com/) or
Traefik) in front of the container and point SelfSync at the `https://` proxy URL.
Caddy will obtain a certificate automatically if the host has a public domain.

---

## Option B — Hosted provider (Infomaniak kDrive)

If you already have kDrive (or another WebDAV provider), just point SelfSync at it:

| Field | Value |
|-------|-------|
| WebDAV URL | e.g. `https://<kdrive-id>.connect.kdrive.infomaniak.com/` |
| WebDAV username | your Infomaniak email |
| WebDAV password | an **app-specific password** (see below) |
| Sync folder | e.g. `selfsync` |

> **kDrive needs an app-specific password.** The WebDAV endpoint rejects your
> normal login password. Generate one at
> **manager.infomaniak.com → account → security → application passwords** and use
> that.

---

## After setup

Enter the same details on **every device**, then open the SelfSync panel from the
ribbon and hit **Sync now**. The first sync uploads (or pulls) your whole vault;
after that it runs automatically. See [Using SelfSync](03-using-selfsync.md).

If something doesn't connect, check [Troubleshooting](05-troubleshooting.md).

## Where your password is stored (Backend security)

Your WebDAV password (and the Git backup token, if you use it) is kept in the
plugin's own `data.json`. The **Backend security** setting controls how it's stored
on each device — it applies locally, so you can choose differently per device:

| Mode | What it does |
|------|--------------|
| **Device keychain** *(default)* | On **desktop**, the password is encrypted with your operating system's keychain (Windows Credential Store, macOS Keychain, Linux libsecret) — it can't be read from the file without your OS login. On **mobile**, where there's no such keychain, it automatically falls back to *Obfuscated*. |
| **Obfuscated** | Stored scrambled so it isn't sitting there as plain text — enough to stop casual glances, screen-shares, or an accidentally shared `data.json`. It is **reversible** by anyone technical, so it is *not* real encryption. |
| **Plaintext** | Stored exactly as typed. Simplest, but anyone who can read your vault folder can read the password. |

There's no unlock prompt in any mode — sync keeps running automatically in the
background. The setting shows whether your device's keychain is actually available.

> **Heads-up for Device keychain:** because the encryption is tied to *this* device
> and OS user, a `data.json` encrypted here can't be decrypted on a different
> computer or user account. If you copy your vault elsewhere, just re-enter the
> password there. (SelfSync never syncs its own settings between devices, so this
> only comes up if you manually move files.)
