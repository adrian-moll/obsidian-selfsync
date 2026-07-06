# 02 — Use cases

Each use case notes the requirements it exercises (see `01-requirements.md`).

- **UC1 — New device onboarding.** Install the plugin, enter backend details and
  the E2EE passphrase, and run the initial sync, which pulls the whole vault.
  *(FR1, FR2, FR5, FR10)*

- **UC2 — Edit on desktop, appears on phone.** Edit a note on Windows; the change
  is uploaded shortly after typing stops (debounced). The phone pulls it on its
  next trigger. *(FR1, FR6)*

- **UC3 — Concurrent edit, both offline.** The same note is edited on two devices
  while both are offline. On the next sync, both versions are preserved: the
  incoming remote version is kept and a local conflict copy is written. The user
  merges manually. *(FR3, FR4, NFR2)*

- **UC4 — Delete propagation.** A note is deleted on the iPad. A tombstone is
  recorded in the manifest so other devices delete it too — the file is **not**
  resurrected by a device that still has the old copy. *(FR3)*

- **UC5 — Rename / move.** A file is moved into a folder. This propagates as a
  move (manifest key rewrite), not as delete + recreate that would lose the file's
  Git/version continuity. *(FR3)*

- **UC6 — Interrupted sync on mobile.** The OS kills Obsidian mid-upload. On the
  next launch, the journal is replayed and the engine reconciles: no corruption,
  no half-written manifest, no lost or duplicated files. *(NFR1, NFR2)*

- **UC7 — Large attachment.** A large PDF or image is added. It transfers via
  chunked, resumable upload; the stored blob hashes match the source. *(NFR3)*

- **UC8 — Switch backend.** The user moves from WebDAV to CouchDB. The plugin
  re-initializes against the new backend and performs an initial reconcile.
  *(FR2)*

- **UC9 — Desktop Git versioning.** Over time, edits accumulate as commits on the
  Git remote. The user browses history and restores an older version of a note.
  *(FR9)*

- **UC10 — Wrong / rotated passphrase.** On a device, an incorrect E2EE passphrase
  is entered. A stored key verifier detects it up front with a clear error — no
  partial or garbage writes occur. *(FR5, NFR2)*
