/**
 * Repository inspection for connected sessions (M20.1 §8.2/§9.2). Read-only:
 * every helper observes the checkout and mutates nothing. The normalization
 * rule is a MIRROR of `agents/lib/preflight.ts#normalizeRemoteRepo` — the CLI
 * sits outside the runner's dependency firewall, so contracts are mirrored on
 * both sides rather than imported (repo convention); keep the two in lockstep.
 */

import { execFile } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Normalize a git remote URL to a lowercase `owner/name`, or null when it is
 * not a recognizable GitHub-style remote. PURE. The HOST is deliberately not
 * compared — mirrored verbatim from agents/lib/preflight.ts.
 */
export function normalizeRemoteRepo(url: string): string | null {
  const raw = url.trim();
  if (!raw) return null;
  // scp-like: git@github.com:owner/name.git (no scheme, colon-separated path).
  const scp = /^[^/]+@([^:/]+):(.+)$/.exec(raw);
  let pathPart: string;
  if (scp) {
    pathPart = scp[2]!;
  } else {
    try {
      pathPart = new URL(raw).pathname;
    } catch {
      return null;
    }
  }
  const trimmed = pathPart
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  if (trimmed.length < 2) return null;
  return `${trimmed[0]}/${trimmed[1]}`.toLowerCase();
}

/** Injectable git runner (argv array, never a shell — M19.2 §8.1). */
export type GitRunner = (
  args: string[],
  cwd: string,
  /** Larger output/time bounds for a call whose output must be COMPLETE (the tree digest). */
  opts?: { maxBuffer?: number; timeoutMs?: number },
) => Promise<{ code: number; stdout: string }>;

export const defaultGitRunner: GitRunner = (args, cwd, opts) =>
  new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd,
        timeout: opts?.timeoutMs ?? 10_000,
        maxBuffer: opts?.maxBuffer ?? 4 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        resolve({
          code:
            error === null
              ? 0
              : typeof (error as { code?: unknown }).code === "number"
                ? Number((error as { code: number }).code)
                : 1,
          stdout: String(stdout),
        });
      },
    );
  });

/**
 * The identity a checkout with no usable origin works under. M20.1 assumed
 * every project has a remote; not every project does, and a connected session
 * only needs a STABLE `owner/name` — so a remote-less checkout is identified
 * by its own directory name under the reserved `local` owner. Stable while
 * the folder keeps its name; two remote-less checkouts sharing a basename
 * share an identity, which is the same collision the host-blind remote
 * normalization above already accepts. PURE.
 */
export function localRepoIdentity(root: string): string {
  const base = root.split(/[/\\]/).filter(Boolean).pop() ?? "";
  const name =
    base
      .trim()
      .toLowerCase()
      .replace(/[\s/\\]+/g, "-")
      .slice(0, 100) || "checkout";
  return `local/${name}`;
}

/** What session start/attach records about the checkout (M20.1 §8.2 step 3). */
export interface RepoInspection {
  /** Absolute repository root — LOCAL ONLY, never sent to the server (AC10). */
  root: string;
  /**
   * Normalized lowercase `owner/name` — always set: a checkout without a
   * usable origin falls back to `localRepoIdentity(root)`.
   */
  repoOwnerName: string;
  /** True when `repoOwnerName` came from the directory, not from a remote. */
  syntheticRepoIdentity: boolean;
  /** Raw origin URL (for local diagnostics only), or null without an origin. */
  originUrl: string | null;
  /** Current branch, or null when detached. */
  branch: string | null;
  /** HEAD commit SHA, or null in an unborn repository. */
  head: string | null;
  /** True when the working tree or index has uncommitted changes. */
  dirty: boolean;
}

/**
 * Inspect the current directory's repository without mutation. Returns null
 * when `cwd` is not inside a git work tree.
 */
export async function inspectRepository(
  cwd: string,
  git: GitRunner = defaultGitRunner,
): Promise<RepoInspection | null> {
  const top = await git(["rev-parse", "--show-toplevel"], cwd);
  const root = top.stdout.trim();
  if (top.code !== 0 || !root) return null;
  const [origin, branch, head, status] = await Promise.all([
    git(["remote", "get-url", "origin"], root),
    git(["symbolic-ref", "--short", "-q", "HEAD"], root),
    git(["rev-parse", "HEAD"], root),
    git(["status", "--porcelain"], root),
  ]);
  const originUrl = origin.code === 0 ? origin.stdout.trim() || null : null;
  const fromRemote = originUrl ? normalizeRemoteRepo(originUrl) : null;
  return {
    root,
    repoOwnerName: fromRemote ?? localRepoIdentity(root),
    syntheticRepoIdentity: fromRemote === null,
    originUrl,
    branch: branch.code === 0 ? branch.stdout.trim() || null : null,
    head: head.code === 0 ? head.stdout.trim() || null : null,
    dirty: status.code === 0 && status.stdout.trim().length > 0,
  };
}

/** The dirty digest is EXACT or UNKNOWN: these bounds turn a tree into "unknown", never into an approximation. */
export const DIRTY_DIGEST_LIMITS = {
  /** `git diff HEAD` output the runner may hold (bytes). */
  diffBytes: 256 * 1024 * 1024,
  /** Untracked files hashed before the tree is declared unknown. */
  untrackedFiles: 5000,
  /** Untracked bytes hashed before the tree is declared unknown. */
  untrackedBytes: 512 * 1024 * 1024,
};

export interface DirtyDigestOptions {
  /** Injectable reader (tests): the file's bytes, or null when unreadable. */
  readFile?: (path: string) => Buffer | null;
  limits?: Partial<typeof DIRTY_DIGEST_LIMITS>;
}

/** Stream one file's bytes into the hash without holding it in memory. */
async function hashFileInto(hash: Hash, path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", () => resolve(false));
    stream.on("end", () => resolve(true));
  });
}

/**
 * R03 / F02b — the SCOPED dirty-state digest: sha256 over `git status
 * --porcelain`, the COMPLETE `git diff HEAD`, and the COMPLETE contents of
 * every untracked file. Two checkouts at the same revision with different
 * uncommitted content get different digests, so a receipt taken before an
 * edit cannot cover a claim made after it. The 2026-09-13 review showed the
 * earlier bounded version hashing only a large file's SIZE — a byte-for-byte
 * different file then bound the same digest. Now the digest is EXACT or it is
 * `null` (unknown): an unreadable checkout, a diff the runner could not hold,
 * more untracked files or bytes than the limits, or an unreadable untracked
 * file each return null, and the evidence floor binds nothing to unknown.
 */
export async function scopedDirtyDigest(
  git: GitRunner,
  root: string,
  options: DirtyDigestOptions | ((path: string) => Buffer | null) = {},
): Promise<string | null> {
  const opts: DirtyDigestOptions = typeof options === "function" ? { readFile: options } : options;
  const limits = { ...DIRTY_DIGEST_LIMITS, ...(opts.limits ?? {}) };
  const status = await git(["status", "--porcelain", "--untracked-files=all"], root);
  if (status.code !== 0) return null;
  const hash = createHash("sha256");
  hash.update(status.stdout);
  hash.update("\0");
  const diff = await git(["diff", "HEAD"], root, { maxBuffer: limits.diffBytes, timeoutMs: 120_000 });
  if (diff.code !== 0) return null;
  if (Buffer.byteLength(diff.stdout, "utf8") > limits.diffBytes) return null;
  hash.update(diff.stdout);
  hash.update("\0");
  let files = 0;
  let bytes = 0;
  for (const line of status.stdout.split("\n")) {
    if (!line.startsWith("?? ")) continue;
    if (++files > limits.untrackedFiles) return null;
    const path = line.slice(3).trim();
    const abs = join(root, path);
    hash.update(path);
    hash.update("\0");
    if (opts.readFile) {
      const content = opts.readFile(abs);
      if (!content) return null;
      bytes += content.byteLength;
      if (bytes > limits.untrackedBytes) return null;
      hash.update(content);
    } else {
      let size: number;
      try {
        size = statSync(abs).size;
      } catch {
        return null;
      }
      bytes += size;
      if (bytes > limits.untrackedBytes) return null;
      if (!(await hashFileInto(hash, abs))) return null;
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}
