/**
 * Git backup (M5, D7/FR9) — DESKTOP ONLY. Auto-commits the vault to a Git remote
 * for versioning, independent of the sync backend. Uses isomorphic-git on Node's
 * fs (Electron), so it must only ever be imported on desktop (the plugin loads it
 * dynamically behind Platform.isDesktopApp). Never imported on mobile.
 */
import git from "isomorphic-git";
import nodeHttp from "isomorphic-git/http/node";
import * as nodeFs from "fs";
import * as path from "path";

const DEFAULT_BRANCH = "main";
// Cap the bytes committed (and therefore pushed) per batch. isomorphic-git's
// HTTP push is weak on large packs — a single big push (e.g. a first backup with
// large attachments) can stall/reset — so we keep each push a digestible size.
const DEFAULT_MAX_PUSH_BYTES = 25 * 1024 * 1024;

export interface GitConfig {
  /** Absolute path to the vault (FileSystemAdapter.getBasePath()). */
  dir: string;
  remoteUrl?: string;
  username?: string;
  token?: string;
  authorName?: string;
  authorEmail?: string;
  /** Extra patterns to keep out of the backup (managed .gitignore block). */
  excludeGlobs?: string[];
  /** Optional diagnostic sink (e.g. plugin debug log) for git HTTP + push phases. */
  log?: (msg: string) => void;
}

// Markers delimiting the block of .gitignore SelfSync owns; content outside the
// block is left untouched so users can add their own ignores.
const GITIGNORE_BEGIN = "# --- SelfSync managed (do not edit this block) ---";
const GITIGNORE_END = "# --- end SelfSync managed ---";
// Always kept out of the backup: SelfSync's own device-specific data + OS trash.
const GITIGNORE_BASE = [".obsidian/plugins/selfsync/", ".trash/"];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface CommitInfo {
  oid: string;
  message: string;
  timestamp: number; // seconds since epoch (git author time)
  author: string;
}

export class GitBackup {
  private readonly fs = nodeFs;

  constructor(private readonly cfg: GitConfig) {}

  private author() {
    return {
      name: this.cfg.authorName || "SelfSync",
      email: this.cfg.authorEmail || "selfsync@localhost",
    };
  }

  private gitDir(): string {
    return path.join(this.cfg.dir, ".git");
  }

  async isRepo(): Promise<boolean> {
    return this.fs.existsSync(this.gitDir());
  }

  /** Initialize the repo (if needed), seed .gitignore, and wire the remote. */
  async init(): Promise<void> {
    if (!(await this.isRepo())) {
      await git.init({ fs: this.fs, dir: this.cfg.dir, defaultBranch: DEFAULT_BRANCH });
    }
    this.writeGitignore();
    if (this.cfg.remoteUrl) {
      const remotes = await git.listRemotes({ fs: this.fs, dir: this.cfg.dir });
      const origin = remotes.find((r) => r.remote === "origin");
      if (!origin) {
        await git.addRemote({ fs: this.fs, dir: this.cfg.dir, remote: "origin", url: this.cfg.remoteUrl });
      } else if (origin.url !== this.cfg.remoteUrl) {
        await git.deleteRemote({ fs: this.fs, dir: this.cfg.dir, remote: "origin" });
        await git.addRemote({ fs: this.fs, dir: this.cfg.dir, remote: "origin", url: this.cfg.remoteUrl });
      }
    }
  }

  /**
   * Ensure .gitignore contains SelfSync's managed block (base excludes + the user's
   * Git excludeGlobs), preserving any content outside the block. Idempotent.
   */
  private writeGitignore(): void {
    const p = path.join(this.cfg.dir, ".gitignore");
    const managed = [GITIGNORE_BEGIN, ...GITIGNORE_BASE, ...(this.cfg.excludeGlobs ?? []), GITIGNORE_END].join("\n");
    const existing = this.fs.existsSync(p) ? this.fs.readFileSync(p, "utf8") : "";
    const blockRe = new RegExp(escapeRegExp(GITIGNORE_BEGIN) + "[\\s\\S]*?" + escapeRegExp(GITIGNORE_END));
    let next: string;
    if (blockRe.test(existing)) {
      next = existing.replace(blockRe, managed);
    } else if (existing.trim().length > 0) {
      next = existing.replace(/\n*$/, "\n") + managed + "\n";
    } else {
      next = managed + "\n";
    }
    if (next !== existing) this.fs.writeFileSync(p, next);
  }

  /** Validate the remote is reachable with the configured credentials (no push). */
  async testRemote(): Promise<void> {
    if (!this.cfg.remoteUrl) throw new Error("No Git remote configured");
    await git.getRemoteInfo2({
      http: this.http(),
      url: this.cfg.remoteUrl,
      forPush: true,
      onAuth: () => this.authCallback(),
    });
  }

  /**
   * Discard ALL history and keep only the current working tree as a single fresh
   * commit, then (if a remote is set) force-push to replace remote history.
   * isomorphic-git has no gc/repack, so re-initializing the repo is the only way to
   * actually reclaim disk from old (binary) history. Destructive and irreversible.
   */
  async compactHistory(): Promise<{ pushed: boolean; pushError?: string }> {
    const gitDir = this.gitDir();
    if (this.fs.existsSync(gitDir)) this.fs.rmSync(gitDir, { recursive: true, force: true });
    await this.init(); // fresh repo + re-seed .gitignore + re-wire remote
    await this.commitAll("SelfSync snapshot");
    if (!this.cfg.remoteUrl) return { pushed: false };
    try {
      await this.push(true);
      return { pushed: true };
    } catch (e) {
      return { pushed: false, pushError: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Stage every change and commit. Returns committed=false when nothing changed. */
  async commitAll(message: string): Promise<{ committed: boolean; oid?: string }> {
    const { dir } = this.cfg;
    const matrix = await git.statusMatrix({ fs: this.fs, dir });
    let changed = false;
    // Row: [filepath, HEAD, WORKDIR, STAGE]. WORKDIR 0 = absent (deleted).
    for (const [filepath, head, workdir] of matrix) {
      if (head === workdir) continue; // unchanged
      if (workdir === 0) await git.remove({ fs: this.fs, dir, filepath });
      else await git.add({ fs: this.fs, dir, filepath });
      changed = true;
    }
    if (!changed) return { committed: false };
    const oid = await git.commit({ fs: this.fs, dir, message, author: this.author() });
    return { committed: true, oid };
  }

  /**
   * Commit all changes and (optionally) push, in batches: stage+commit+push each
   * batch, cutting a batch when it reaches `chunkSize` files **or**
   * `maxBytesPerCommit` bytes. Bounding by bytes (not just file count) keeps each
   * push a small pack that isomorphic-git can complete — a first backup with large
   * attachments would otherwise be one huge push that stalls/resets. A file larger
   * than the byte cap is committed on its own. On a push failure, stops pushing
   * further batches (commits still complete locally) and reports it for later retry.
   */
  async backup(
    message: string,
    opts: { chunkSize?: number; maxBytesPerCommit?: number } = {},
  ): Promise<{ commits: number }> {
    const maxFiles = Math.max(1, opts.chunkSize ?? 100);
    const maxBytes = Math.max(1, opts.maxBytesPerCommit ?? DEFAULT_MAX_PUSH_BYTES);
    const { dir } = this.cfg;
    const matrix = await git.statusMatrix({ fs: this.fs, dir });
    const changed = matrix.filter((row) => row[1] !== row[2]); // HEAD !== WORKDIR

    let commits = 0;
    let batch: typeof changed = [];
    let batchBytes = 0;
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      for (const row of batch) {
        const filepath = row[0];
        if (row[2] === 0) await git.remove({ fs: this.fs, dir, filepath });
        else await git.add({ fs: this.fs, dir, filepath });
      }
      await git.commit({ fs: this.fs, dir, message, author: this.author() });
      commits++;
      batch = [];
      batchBytes = 0;
    };

    for (const row of changed) {
      let size = 0;
      if (row[2] !== 0) {
        try {
          size = this.fs.statSync(path.join(dir, row[0])).size;
        } catch {
          size = 0; // deleted/unreadable → treat as weightless
        }
      }
      // Cut the current (non-empty) batch before it would exceed either cap.
      if (batch.length > 0 && (batch.length >= maxFiles || batchBytes + size > maxBytes)) {
        await flush();
      }
      batch.push(row);
      batchBytes += size;
    }
    await flush();
    return { commits };
  }

  private authCallback() {
    return { username: this.cfg.username || this.cfg.token || "", password: this.cfg.token || "" };
  }

  /**
   * The isomorphic-git HTTP client, wrapped to log each request's method, path,
   * status, and duration (and failures) when a diagnostic sink is provided — so a
   * push timeout tells us WHICH request (ref advertisement GET vs pack POST) died
   * and how long it took, instead of a bare "Request timed out".
   */
  private http(): typeof nodeHttp {
    const log = this.cfg.log;
    if (!log) return nodeHttp;
    return {
      request: async (req: Parameters<typeof nodeHttp.request>[0]) => {
        const start = Date.now();
        let where = req.url;
        try {
          const u = new URL(req.url);
          where = u.pathname + u.search;
        } catch {
          /* keep full url */
        }
        try {
          const res = await nodeHttp.request(req);
          log(`http ${req.method} ${where} → ${res.statusCode} ${res.statusMessage} (${Date.now() - start}ms)`);
          return res;
        } catch (e) {
          const err = e as { name?: string; message?: string; code?: string };
          log(`http ${req.method} ${where} ✗ ${err?.name || "Error"} ${err?.code || ""}: ${err?.message} (${Date.now() - start}ms)`);
          throw e;
        }
      },
    };
  }

  /** Push local HEAD to the remote branch. `force` replaces remote history (used
   *  by compaction). Routine backups use {@link pushIncremental} instead. */
  async push(force = false): Promise<void> {
    if (!this.cfg.remoteUrl) throw new Error("No Git remote configured");
    await git.push({
      fs: this.fs,
      http: this.http(),
      dir: this.cfg.dir,
      remote: "origin",
      ref: DEFAULT_BRANCH,
      force,
      onAuth: () => this.authCallback(),
    });
  }

  /**
   * Push unpushed commits to the remote branch ONE SMALL PACK AT A TIME, from
   * wherever the remote currently is up to local HEAD. Resumable: if a push times
   * out partway, the remote has still advanced by the commits that landed, so the
   * next call resumes from there instead of re-sending everything. This is what
   * lets a large first backup complete over a slow / timeout-prone link, and
   * prevents the "retry keeps re-pushing the whole vault" death spiral. Returns
   * how many commits were pushed (0 = already up to date).
   */
  async pushIncremental(): Promise<{ pushed: number }> {
    if (!this.cfg.remoteUrl) throw new Error("No Git remote configured");
    const { dir } = this.cfg;
    const log = this.cfg.log ?? (() => {});
    const http = this.http();
    const onAuth = () => this.authCallback();
    const localHead = await git.resolveRef({ fs: this.fs, dir, ref: DEFAULT_BRANCH });

    // What does the remote already have on this branch? (null = empty / no branch)
    let remoteOid: string | null = null;
    try {
      const refs = await git.listServerRefs({ http, url: this.cfg.remoteUrl, prefix: `refs/heads/${DEFAULT_BRANCH}`, onAuth });
      remoteOid = refs.find((r) => r.ref === `refs/heads/${DEFAULT_BRANCH}`)?.oid ?? null;
    } catch (e) {
      log(`push: listServerRefs failed (${e instanceof Error ? e.message : String(e)}); assuming empty remote`);
      remoteOid = null;
    }
    if (remoteOid === localHead) return { pushed: 0 };

    // Local commits from HEAD back to (but not including) the remote's oid, then
    // reversed to oldest-first so each push fast-forwards the remote by one commit.
    const entries = await git.log({ fs: this.fs, dir, ref: DEFAULT_BRANCH });
    const pending: string[] = [];
    for (const e of entries) {
      if (e.oid === remoteOid) break;
      pending.push(e.oid);
    }
    pending.reverse();
    log(
      `push: HEAD ${localHead.slice(0, 7)}, remote ${remoteOid ? remoteOid.slice(0, 7) : "(none)"}, ` +
        `${pending.length} commit(s) to push`,
    );

    let pushed = 0;
    for (const oid of pending) {
      const start = Date.now();
      log(`push: sending commit ${pushed + 1}/${pending.length} (${oid.slice(0, 7)})…`);
      await git.push({ fs: this.fs, http, dir, remote: "origin", ref: oid, remoteRef: DEFAULT_BRANCH, onAuth });
      pushed++;
      log(`push: commit ${pushed}/${pending.length} done (${Date.now() - start}ms)`);
    }
    return { pushed };
  }

  /** Commit history, optionally filtered to a single file's changes. */
  async log(filepath?: string, depth = 50): Promise<CommitInfo[]> {
    const entries = await git.log({ fs: this.fs, dir: this.cfg.dir, depth, ref: "HEAD", filepath });
    return entries.map((e) => ({
      oid: e.oid,
      message: e.commit.message.trim(),
      timestamp: e.commit.author.timestamp,
      author: e.commit.author.name,
    }));
  }

  /** Read a file's content as of a given commit. */
  async readFileAt(oid: string, filepath: string): Promise<string> {
    const { blob } = await git.readBlob({ fs: this.fs, dir: this.cfg.dir, oid, filepath });
    return new TextDecoder().decode(blob);
  }

  /** Restore a file's content from a past commit into the working tree. */
  async restore(oid: string, filepath: string): Promise<void> {
    const content = await this.readFileAt(oid, filepath);
    this.fs.writeFileSync(path.join(this.cfg.dir, filepath), content);
  }
}
