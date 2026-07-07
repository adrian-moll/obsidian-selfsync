# Troubleshooting

Most messages appear in the **Activity** log of the SelfSync panel (there's a
**Copy** button to grab the text). Common ones:

## "Not configured" / nothing syncs

The backend URL is empty or wasn't saved. Open **Settings → SelfSync** and fill in
the WebDAV **URL**, **username**, and **password**, then hit **Sync now**. See
[backend setup](02-backend-setup.md).

## "ClientRequest only supports http: and https: protocols"

The WebDAV URL is malformed — usually a missing or mistyped scheme. It must start
with `http://` or `https://` (for example `https://dav.example.com`), not just
`dav.example.com` or a `webdav://` scheme.

## Nothing syncs on iPad/Android, but desktop works

Mobile Obsidian effectively **requires HTTPS**. A plain `http://` endpoint that
works on your desktop/LAN will be refused or distrusted on mobile. Put a TLS
reverse proxy in front of your server and use the `https://` URL — see
[backend setup](02-backend-setup.md).

## "Offline — will retry when the connection returns"

Informational, not an error. SelfSync couldn't reach the server (no network, server
down, wrong URL). It retries automatically on the next trigger. If it never
recovers, check the URL and that the server is up.

## A brief error right after a big change that then fixes itself

If you occasionally see a transient failure moments after a burst of edits that's
gone by the next sync, that's expected: some self-hosted servers briefly reject a
too-fast conditional write, and SelfSync retries automatically after a short delay.
No action needed unless it keeps repeating for the same file.

## Password is blank after moving the vault to another computer

If your **Backend security** mode is **Device keychain**, the saved password is
encrypted for *that* device and OS user only — it can't be decrypted on a different
machine or account, so it comes up empty there. Just re-enter the WebDAV password
(and Git token) on the new device. See
[Where your password is stored](02-backend-setup.md).

## Login rejected on kDrive

kDrive's WebDAV endpoint does **not** accept your normal login password. Generate
an **app-specific password** (manager.infomaniak.com → account → security →
application passwords) and use that instead.

## Git backup: "push deferred (timeout/offline) — will retry"

SelfSync commits and pushes in batches bounded by size, so a large first backup
goes up in digestible pieces and pending pushes are retried on later syncs — it
usually lands on its own. The message shows the underlying error in parentheses.
If pushes keep failing:

- **First-time / very large backup that won't go through the plugin:** seed it once
  from a terminal — `cd <vault> && git push origin main` — then the plugin only
  sends small incremental pushes afterward. (`isomorphic-git`, which the plugin
  uses, is weak on very large single pushes.)
- Lower the batch size in **Settings → SelfSync → Git backup**.
- Raise the request timeout on your Git server / reverse proxy, or push over SSH.

Note: the plugin authenticates with the **username + token** in its Git backup
settings — it does **not** use your system git credential cache. If pushes fail
with an auth error, check those fields (use a Gitea/GitHub **access token**, not
your password).

(Git backup is desktop-only; it won't run on mobile.)

## Still stuck?

Copy the Activity log (button in the SelfSync panel) and open an issue on the
[GitHub repo](https://github.com/adrian-moll/obsidian-selfsync).
