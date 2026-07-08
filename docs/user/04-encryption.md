# Encryption

End-to-end encryption (E2EE) is **available** and **off by default**. When you
turn it on, your notes' **contents and names** are encrypted on your device before
they're uploaded, so your WebDAV server only ever stores ciphertext.

## What E2EE protects

When enabled, your WebDAV server only ever sees **ciphertext** and **opaque key
names** — it can't read your note contents, file names, or folder structure. You
set a **passphrase**; only devices with the same passphrase can read the vault.

- **Protects against:** a curious or compromised storage host.
- **Does *not* protect against:** a compromised device (your vault is plaintext
  locally — Obsidian has to read it), or a **lost passphrase** (there is no
  recovery backdoor — if you forget it, the data can't be decrypted).

## Turning it on

1. In **Settings → SelfSync**, enable **End-to-end encryption**.
2. Enter a strong **passphrase**. Write it down somewhere safe — it cannot be
   recovered, and there is no reset.
3. Enter the **same passphrase** on every device you sync (a different or
   mistyped passphrase is rejected before anything is written, so you can't
   corrupt the vault by getting it wrong).
4. Run **Sync now**.

> **Start on a fresh sync folder.** Turning encryption on changes how data is laid
> out on the server, so it starts a new encrypted copy — it does not convert your
> existing plaintext files in place. Point SelfSync at an empty sync folder when
> you enable E2EE, and delete the old plaintext folder from the server once every
> device has switched over. Likewise, changing the passphrase later does not
> re-encrypt already-uploaded data.

## With encryption off (the default)

With E2EE off, your files are stored **as-is** on the server, mirroring your vault
at their real paths. That has a nice side benefit: your notes are **browsable**
directly on the server (e.g. in the kDrive web UI or your file browser). Your
privacy then rests on:

- **Transport security** — use an **HTTPS** endpoint (see
  [backend setup](02-backend-setup.md)) so data is encrypted in transit.
- **Trust in the host** — for a server you self-host and control, that's you.

Data sovereignty — controlling *where* your data lives — is what you get either
way; **turn E2EE on** when you also want content confidentiality from the host
itself (e.g. a hosted provider you don't fully trust).
