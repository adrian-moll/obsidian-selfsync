/**
 * Git backup (M5, D7/FR9) — DESKTOP ONLY. Auto-commits the vault to a Git remote
 * for versioning, independent of the sync backend. Uses isomorphic-git on Node's
 * fs (Electron), so it must only ever be imported on desktop (the plugin loads it
 * dynamically behind Platform.isDesktopApp). Never imported on mobile.
 */
import git from "isomorphic-git";
import http from "isomorphic-git/http/node";
import * as nodeFs from "fs";
import * as path from "path";

const DEFAULT_BRANCH = "main";

export interface GitConfig {
  /** Absolute path to the vault (FileSystemAdapter.getBasePath()). */
  dir: string;
  remoteUrl?: string;
  username?: string;
  token?: string;
  authorName?: string;
  authorEmail?: string;
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
    const gitignore = path.join(this.cfg.dir, ".gitignore");
    if (!this.fs.existsSync(gitignore)) {
      // Keep SelfSync's own (device-specific) data and OS trash out of the backup.
      this.fs.writeFileSync(gitignore, [".obsidian/plugins/selfsync/", ".trash/", ""].join("\n"));
    }
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

  async push(): Promise<void> {
    if (!this.cfg.remoteUrl) throw new Error("No Git remote configured");
    await git.push({
      fs: this.fs,
      http,
      dir: this.cfg.dir,
      remote: "origin",
      ref: DEFAULT_BRANCH,
      onAuth: () => ({ username: this.cfg.username || this.cfg.token || "", password: this.cfg.token || "" }),
    });
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
