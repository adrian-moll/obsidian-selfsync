/**
 * CryptoBackend — a StorageBackend decorator that transparently encrypts blobs
 * (and, since the manifest is just another blob written through here, the
 * manifest too → path privacy) for E2EE (M3, docs/developer/encryption.md).
 *
 * The engine above this is oblivious to encryption: CryptoBackend speaks in
 * PLAINTEXT byte-coordinates. `head` reports the plaintext size; `readRange`
 * takes a plaintext byte range, works out which ciphertext frames cover it,
 * fetches only those frames from the inner backend in one ranged GET, decrypts,
 * and returns the requested plaintext slice. So the engine's streamed-download
 * loop (ranged reads → appendBinary) keeps working unchanged and large encrypted
 * files still stream without being held whole in memory (the mobile OOM fix).
 *
 * Framed blob format ("SSE1") — enables per-frame, seekable decryption:
 *
 *   header (17 bytes):
 *     magic     4  "SSE1"
 *     version   1  = 1
 *     chunkSize 4  uint32 BE   plaintext bytes per frame (C)
 *     plainSize 8  uint64 BE   total plaintext length (P)
 *   frame k (k = 0 … ceil(P/C)-1):
 *     IV       12  fresh per frame
 *     ct+tag  L_k+16           L_k = min(C, P - k·C)
 *
 *   Every frame but the last holds exactly C plaintext bytes, so frame k always
 *   begins at header + k·(C+28) — that fixed stride is what makes a plaintext
 *   offset map to a frame in O(1). Empty plaintext (P=0) stores a header only.
 */
import type { BackendCapabilities, ReadResult, RemoteEntry, StorageBackend } from "./storage-backend.js";
import { decryptGcm, encryptGcm, IV_BYTES, TAG_BYTES } from "../util/crypto.js";

const MAGIC = "SSE1";
export const HEADER_BYTES = 17;
/** Per-frame storage overhead: IV (12) + GCM tag (16). */
const FRAME_OVERHEAD = IV_BYTES + TAG_BYTES;
/**
 * Default plaintext bytes per frame. 1 MiB divides the engine's 8 MiB streamed
 * read chunk evenly (so each streamed read is frame-aligned) and keeps the
 * transient buffer per frame small on mobile.
 */
export const DEFAULT_CHUNK_BYTES = 1024 * 1024;

interface FramedHeader {
  version: number;
  chunkSize: number; // C
  plainSize: number; // P
}

/** Number of frames for a plaintext of `plainSize` at `chunkSize`. */
export function frameCount(plainSize: number, chunkSize: number): number {
  return plainSize === 0 ? 0 : Math.ceil(plainSize / chunkSize);
}

/** Plaintext length carried by frame `k`. */
function framePlainLen(k: number, plainSize: number, chunkSize: number): number {
  return Math.min(chunkSize, plainSize - k * chunkSize);
}

/** Stored (ciphertext) byte length of frame `k`. */
function frameStoredLen(k: number, plainSize: number, chunkSize: number): number {
  return framePlainLen(k, plainSize, chunkSize) + FRAME_OVERHEAD;
}

/** Byte offset of frame `k` within the blob (fixed stride — see format note). */
function frameOffset(k: number, chunkSize: number): number {
  return HEADER_BYTES + k * (chunkSize + FRAME_OVERHEAD);
}

function writeHeader(chunkSize: number, plainSize: number): Uint8Array {
  const buf = new Uint8Array(HEADER_BYTES);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < 4; i++) buf[i] = MAGIC.charCodeAt(i);
  buf[4] = 1;
  view.setUint32(5, chunkSize, false);
  view.setBigUint64(9, BigInt(plainSize), false);
  return buf;
}

export function parseHeader(data: ArrayBuffer | Uint8Array): FramedHeader {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (buf.byteLength < HEADER_BYTES) throw new Error("encrypted blob truncated (header)");
  for (let i = 0; i < 4; i++) {
    if (buf[i] !== MAGIC.charCodeAt(i)) throw new Error("not a SelfSync encrypted blob (bad magic)");
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const version = buf[4];
  if (version !== 1) throw new Error(`unsupported encrypted blob version ${version}`);
  return { version, chunkSize: view.getUint32(5, false), plainSize: Number(view.getBigUint64(9, false)) };
}

function concat(parts: Array<ArrayBuffer | Uint8Array>, total: number): ArrayBuffer {
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p instanceof Uint8Array ? p : new Uint8Array(p), o);
    o += p.byteLength;
  }
  return out.buffer;
}

export class CryptoBackend implements StorageBackend {
  /** Cache of parsed headers by key — a blob's (C,P) is immutable for its
   *  content, and a CryptoBackend instance lives for a single sync cycle, so
   *  this avoids re-fetching the header on every streamed readRange. */
  private readonly headers = new Map<string, FramedHeader>();

  constructor(
    private readonly inner: StorageBackend,
    private readonly key: CryptoKey,
    private readonly chunkSize: number = DEFAULT_CHUNK_BYTES,
  ) {}

  // ---- passthrough -------------------------------------------------------
  testConnection(): Promise<void> {
    return this.inner.testConnection();
  }
  list(): Promise<RemoteEntry[]> {
    return this.inner.list(); // sizes are ciphertext sizes; only cleanup/tests read them
  }
  remove(key: string, prevEtag?: string): Promise<void> {
    return this.inner.remove(key, prevEtag);
  }
  move(from: string, to: string): Promise<void> {
    return this.inner.move(from, to); // ciphertext relocates as-is
  }
  capabilities(): BackendCapabilities {
    return this.inner.capabilities();
  }

  // ---- encrypt on write --------------------------------------------------
  async write(key: string, data: ArrayBuffer, prevEtag?: string): Promise<string> {
    const framed = await this.encryptFramed(data);
    this.headers.delete(key);
    // inner.write throws ConditionalWriteError on an etag mismatch, which
    // propagates untouched so the engine's concurrency-retry logic still sees it.
    return this.inner.write(key, framed, prevEtag);
  }

  private async encryptFramed(plaintext: ArrayBuffer): Promise<ArrayBuffer> {
    const P = plaintext.byteLength;
    const C = this.chunkSize;
    const n = frameCount(P, C);
    const parts: Array<ArrayBuffer | Uint8Array> = [writeHeader(C, P)];
    let total = HEADER_BYTES;
    const src = new Uint8Array(plaintext);
    for (let k = 0; k < n; k++) {
      const start = k * C;
      const frame = await encryptGcm(this.key, src.subarray(start, start + framePlainLen(k, P, C)));
      parts.push(frame);
      total += frame.byteLength;
    }
    return concat(parts, total);
  }

  // ---- decrypt on read ---------------------------------------------------
  async read(key: string): Promise<ArrayBuffer> {
    return this.decryptFramedWhole(await this.inner.read(key));
  }

  async readWithMeta(key: string): Promise<ReadResult | null> {
    const r = await this.inner.readWithMeta(key);
    if (!r) return null;
    return { data: await this.decryptFramedWhole(r.data), etag: r.etag };
  }

  private async decryptFramedWhole(framed: ArrayBuffer): Promise<ArrayBuffer> {
    const { chunkSize: C, plainSize: P } = parseHeader(framed);
    if (P === 0) return new ArrayBuffer(0);
    const buf = new Uint8Array(framed);
    const n = frameCount(P, C);
    const parts: ArrayBuffer[] = [];
    let o = HEADER_BYTES;
    for (let k = 0; k < n; k++) {
      const sz = frameStoredLen(k, P, C);
      parts.push(await decryptGcm(this.key, buf.subarray(o, o + sz)));
      o += sz;
    }
    return concat(parts, P);
  }

  // ---- streaming (plaintext coordinates) --------------------------------
  async head(key: string): Promise<{ size: number; acceptRanges: boolean; etag?: string } | null> {
    const meta = this.inner.head ? await this.inner.head(key) : null;
    if (!meta) return null;
    const header = await this.loadHeader(key);
    return { size: header.plainSize, acceptRanges: meta.acceptRanges, etag: meta.etag };
  }

  async readRange(key: string, start: number, endInclusive: number): Promise<ArrayBuffer> {
    const { chunkSize: C, plainSize: P } = await this.loadHeader(key);
    if (P === 0) return new ArrayBuffer(0);
    const n = frameCount(P, C);
    const firstFrame = Math.floor(start / C);
    const lastFrame = Math.min(Math.floor(endInclusive / C), n - 1);

    const cipherStart = frameOffset(firstFrame, C);
    const cipherEnd = frameOffset(lastFrame, C) + frameStoredLen(lastFrame, P, C) - 1;
    const cipher = new Uint8Array(await this.inner.readRange!(key, cipherStart, cipherEnd));

    // Decrypt frames firstFrame…lastFrame → contiguous plaintext, then slice out
    // exactly [start, endInclusive] within it.
    const parts: ArrayBuffer[] = [];
    let coveredPlain = 0;
    let o = 0;
    for (let k = firstFrame; k <= lastFrame; k++) {
      const sz = frameStoredLen(k, P, C);
      const pt = await decryptGcm(this.key, cipher.subarray(o, o + sz));
      parts.push(pt);
      coveredPlain += pt.byteLength;
      o += sz;
    }
    const plain = new Uint8Array(concat(parts, coveredPlain));
    const localStart = start - firstFrame * C;
    const slice = plain.subarray(localStart, endInclusive - firstFrame * C + 1);
    const out = new ArrayBuffer(slice.byteLength);
    new Uint8Array(out).set(slice);
    return out;
  }

  /** Fetch (or reuse) the parsed header for `key`. */
  private async loadHeader(key: string): Promise<FramedHeader> {
    const cached = this.headers.get(key);
    if (cached) return cached;
    let raw: ArrayBuffer;
    if (this.inner.readRange) {
      raw = await this.inner.readRange(key, 0, HEADER_BYTES - 1);
    } else {
      raw = await this.inner.read(key); // no range support: fall back to a whole read
    }
    const header = parseHeader(raw);
    this.headers.set(key, header);
    return header;
  }
}
