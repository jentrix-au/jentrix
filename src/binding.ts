/**
 * Folder alignment — the checkout ↔ workspace binding (client-runtime v2
 * §11). LEVEL 1 of the two alignment levels: one non-secret file at the git
 * root answering "which Jentrix deployment and workspace should commands from
 * this checkout use by default?". It creates no server row, starts no
 * session, enables no native MCP, and contains no bearer — a default and a
 * drift detector, never proof of access (P5, D2).
 */

import { randomBytes } from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { PROJECT_CONFIG_DIR, scaffoldProjectConfigDir } from "./config";
import { EXIT_CODES } from "./errors";

export const BINDING_FILE = "binding.json";

export interface FolderBinding {
  version: 1;
  /** The normalized MCP endpoint membership was verified against. */
  endpoint: string;
  /** Canonical workspace identity. */
  workspaceId: string;
  /** Offline display snapshot — never used for authorization. */
  workspaceSlug: string;
  /** Normalized (or synthetic) repo identity — never an absolute path. */
  repoOwnerName: string;
  alignedAt: string;
}

export class BindingError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number = EXIT_CODES.INVALID_INPUT) {
    super(message);
    this.exitCode = exitCode;
  }
}

export function bindingPathOf(gitRoot: string): string {
  return join(gitRoot, PROJECT_CONFIG_DIR, BINDING_FILE);
}

/**
 * Read the binding at the GIT ROOT (never arbitrary cwd ancestry — §11.4).
 * Returns null when absent. Unknown future fields are ignored; an unknown
 * MAJOR version refuses with a re-align instruction rather than guessing.
 */
export function readFolderBinding(gitRoot: string): FolderBinding | null {
  const path = bindingPathOf(gitRoot);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BindingError(
      `FOLDER_BINDING_INVALID: ${path} is not valid JSON — fix or remove it, then re-run \`jentrix folder align\`.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BindingError(
      `FOLDER_BINDING_INVALID: ${path} does not hold a binding object — re-run \`jentrix folder align\`.`,
    );
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) {
    throw new BindingError(
      `FOLDER_BINDING_VERSION: ${path} carries binding version ${String(
        record.version,
      )}, which this CLI does not understand — upgrade the CLI or re-run \`jentrix folder align\`.`,
    );
  }
  for (const key of [
    "endpoint",
    "workspaceId",
    "workspaceSlug",
    "repoOwnerName",
    "alignedAt",
  ] as const) {
    if (typeof record[key] !== "string" || record[key].length === 0) {
      throw new BindingError(
        `FOLDER_BINDING_INVALID: ${path} is missing "${key}" — re-run \`jentrix folder align\`.`,
      );
    }
  }
  return {
    version: 1,
    endpoint: record.endpoint as string,
    workspaceId: record.workspaceId as string,
    workspaceSlug: record.workspaceSlug as string,
    repoOwnerName: record.repoOwnerName as string,
    alignedAt: record.alignedAt as string,
  };
}

/**
 * §11.1 — the ignore precondition: `scaffoldProjectConfigDir` writes the
 * self-ignoring `.stacks/.gitignore` (`*`) only when NONE exists; an
 * operator's own ignore file is preserved, so when it does not cover the
 * binding the write must REFUSE with the exact entry to add — committing a
 * personal deployment/workspace default would repoint another operator's
 * commands.
 */
function assertBindingIgnored(gitRoot: string): void {
  const ignorePath = join(gitRoot, PROJECT_CONFIG_DIR, ".gitignore");
  let raw: string;
  try {
    raw = readFileSync(ignorePath, "utf8");
  } catch {
    // scaffold just wrote it (or the dir is fresh) — the `*` default covers.
    return;
  }
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const covers = lines.some(
    (line) =>
      line === "*" ||
      line === BINDING_FILE ||
      line === `/${BINDING_FILE}` ||
      line === "*.json",
  );
  if (!covers) {
    throw new BindingError(
      `FOLDER_BINDING_NOT_IGNORED: ${ignorePath} does not ignore ${BINDING_FILE} — add the line "${BINDING_FILE}" to it, then re-run. A committed binding would repoint every other operator's commands at your deployment/workspace.`,
    );
  }
}

/** Atomic owner-only write via the config writer's tmp + rename idiom. */
export function writeFolderBinding(
  gitRoot: string,
  binding: FolderBinding,
): string {
  scaffoldProjectConfigDir(gitRoot);
  assertBindingIgnored(gitRoot);
  const path = bindingPathOf(gitRoot);
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, `${JSON.stringify(binding, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return path;
}

export function clearFolderBinding(gitRoot: string): boolean {
  const path = bindingPathOf(gitRoot);
  if (!existsSync(path)) return false;
  // Only the binding — never config.json, markers, or native MCP files (D14).
  unlinkSync(path);
  return true;
}

/**
 * §11.4 — drift checks before a remote mutation uses the binding's scope.
 * Both FAIL CLOSED: a mutation must never land in the wrong deployment or be
 * attributed under a repo identity the checkout no longer has.
 */
export function assertBindingCurrent(
  binding: FolderBinding,
  active: { endpoint: string; repoOwnerName: string },
): void {
  if (normalizeEndpoint(binding.endpoint) !== normalizeEndpoint(active.endpoint)) {
    throw new BindingError(
      `FOLDER_ENDPOINT_MISMATCH: this checkout is folder-aligned to ${binding.endpoint}, but the active credential targets ${active.endpoint} — re-run \`jentrix folder align\` here (or switch credentials) before mutating. Refusing to silently repoint.`,
      EXIT_CODES.FORBIDDEN,
    );
  }
  if (binding.repoOwnerName !== active.repoOwnerName) {
    throw new BindingError(
      `FOLDER_REPO_CHANGED: this folder was bound as ${binding.repoOwnerName} but now inspects as ${active.repoOwnerName} — the remote changed. Re-run \`jentrix folder align\` to confirm the new identity.`,
      EXIT_CODES.CONFLICT,
    );
  }
}

export function normalizeEndpoint(url: string): string {
  return url.replace(/\/+$/, "").toLowerCase();
}

export const FOLDER_NOT_ALIGNED_MESSAGE =
  "FOLDER_NOT_ALIGNED: this checkout has no folder binding — run `jentrix folder align` (or `jentrix setup`) to bind it to a workspace first.";

/**
 * The pre-mutation gate session commands run (§11.4): binding present, same
 * endpoint, same repo — else fail closed with the named drift code.
 */
export function requireFolderBinding(
  gitRoot: string,
  active: { endpoint: string; repoOwnerName: string },
): FolderBinding {
  const binding = readFolderBinding(gitRoot);
  if (!binding) {
    throw new BindingError(FOLDER_NOT_ALIGNED_MESSAGE);
  }
  assertBindingCurrent(binding, active);
  return binding;
}
