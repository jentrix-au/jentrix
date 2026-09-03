/**
 * Repository inspection for connected sessions (M20.1 §8.2/§9.2). Read-only:
 * every helper observes the checkout and mutates nothing. The normalization
 * rule is a MIRROR of `agents/lib/preflight.ts#normalizeRemoteRepo` — the CLI
 * sits outside the runner's dependency firewall, so contracts are mirrored on
 * both sides rather than imported (repo convention); keep the two in lockstep.
 */

import { execFile } from "node:child_process";

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
) => Promise<{ code: number; stdout: string }>;

export const defaultGitRunner: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: 10_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
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
