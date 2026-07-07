# Encryption

> **Not yet available.** End-to-end encryption (E2EE) is planned but **not
> implemented**. There's a toggle in settings, but leave it **off** — turning it
> on today does *not* encrypt your content (it only changes how names are stored
> on the server), so it would give a false sense of protection without the
> benefit. This page describes the intended behavior for when it ships.

## What E2EE will protect

When enabled, your WebDAV server will only ever see **ciphertext** and **opaque
key names** — it won't be able to read your note contents, file names, or folder
structure. You'll set a **passphrase** on each device; only devices with the
passphrase can read the vault.

- **Protects against:** a curious or compromised storage host.
- **Does *not* protect against:** a compromised device (your vault is plaintext
  locally — Obsidian has to read it), or a **lost passphrase** (there will be no
  recovery backdoor — if you forget it, the data can't be decrypted).

## Today: encryption off (the default)

With E2EE off — the current behavior — your files are stored **as-is** on the
server, mirroring your vault at their real paths. That has a nice side benefit:
your notes are **browsable** directly on the server (e.g. in the kDrive web UI or
your file browser). Your privacy then rests on:

- **Transport security** — use an **HTTPS** endpoint (see
  [backend setup](02-backend-setup.md)) so data is encrypted in transit.
- **Trust in the host** — for a server you self-host and control, that's you.

Data sovereignty — controlling *where* your data lives — is what SelfSync gives
you today; content confidentiality from the host is what E2EE will add later.
