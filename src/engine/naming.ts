/**
 * Blob naming strategy — decides how a logical vault path maps to a backend blob
 * key, and where the manifest lives. This is what makes the remote layout
 * mode-dependent (D12, docs/06-backends.md):
 *
 *   - MirrorNaming (encryption OFF): blobKey = the real vault path, so the backend
 *     folder mirrors the vault and is human-browsable. Manifest tucked into
 *     `.selfsync/`.
 *   - OpaqueNaming (encryption ON): blobKey = an opaque hash, so file names/paths
 *     are hidden from the host (the E2EE privacy guarantee).
 */
import { sha256 } from "../util/hash.js";
import { utf8 } from "../backend/http.js";

export interface BlobNaming {
  /** Backend key of the manifest object. */
  readonly manifestKey: string;
  /** Map a logical vault path to its backend blob key. */
  blobKey(path: string): Promise<string>;
}

/** Browsable layout: files stored at their real vault paths. */
export class MirrorNaming implements BlobNaming {
  readonly manifestKey = ".selfsync/manifest.json";
  async blobKey(path: string): Promise<string> {
    return path;
  }
}

/** Private layout: opaque, content-independent keys derived from the path. */
export class OpaqueNaming implements BlobNaming {
  readonly manifestKey = "manifest.json";
  async blobKey(path: string): Promise<string> {
    return "b-" + (await sha256(utf8.encode(path)));
  }
}
