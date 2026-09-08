/** Session runtime. */
import { type SessionCommandDeps } from "./deps";
import { type RepoInspection, inspectRepository } from "../repo";
import {
  UsageError,
  type SessionToolCaller,
  ToolCallError,
} from "../tool-client";
import { envelopeToExit, EXIT_CODES, isUnauthorizedError } from "../errors";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function inspectCheckout(
  deps: SessionCommandDeps,
): Promise<RepoInspection> {
  const inspection = await inspectRepository(deps.cwd(), deps.git);
  if (!inspection) {
    throw new UsageError(
      "the current directory is not inside a git work tree — run from your project checkout, or make this folder one: git init (then git remote add origin git@github.com:<owner>/<repo>.git)",
    );
  }
  return inspection;
}

export async function withCaller<T>(
  deps: SessionCommandDeps,
  fn: (
    caller: SessionToolCaller,
    target: { token: string; url: string },
  ) => Promise<T>,
  opts?: { sessionId?: string },
): Promise<T> {
  const target = deps.resolveTarget();
  const { caller, close } = await deps.connect(
    opts?.sessionId ? { ...target, sessionId: opts.sessionId } : target,
  );
  try {
    return await fn(caller, freshTarget(deps, target));
  } finally {
    await close().catch(() => undefined);
  }
}

/**
 * The token to hand the RAW REST legs, re-resolved AFTER connect.
 *
 * `connect` performs the C4.2 OAuth refresh and PERSISTS the rotated pair to
 * the config file, but the `target` it was handed still holds the expired
 * access token. Flows that mix MCP with direct `fetch` — every `jentrix push`,
 * `artifact`, and the issue mint — passed that stale token as their bearer, so
 * the first push after an access token expired failed with a bare
 * `STACKS_LOGIN_REQUIRED` while the MCP half of the SAME command succeeded.
 * The next invocation then read the refreshed token off disk and worked, which
 * makes a deterministic one-shot failure read as a flake and sends the
 * operator to re-login they never needed (observed in the TPM e2e round).
 *
 * Re-reading is the whole fix: the refresh already wrote the answer down.
 * A config file that became unreadable in between falls back to the original
 * target — the same token as before, so this can only ever improve on it.
 */
function freshTarget(
  deps: SessionCommandDeps,
  original: { token: string; url: string },
): { token: string; url: string } {
  try {
    return deps.resolveTarget();
  } catch {
    return original;
  }
}

export function stacksBaseUrlOf(mcpUrl: string): string {
  return new URL(mcpUrl).origin;
}

export function refuseProjectScope(
  project: string | undefined,
  deps: Pick<SessionCommandDeps, "writeErr">,
): boolean {
  if (project === undefined) return false;
  deps.writeErr(
    "SESSION_PROJECT_REMOVED: sessions use the folder workspace. Run `jentrix folder align`, omit --project, then use `jentrix task project add --task <id-or-key> --project <id-or-slug>` for an optional task label.",
  );
  return true;
}

export function reportError(error: unknown, deps: SessionCommandDeps): number {
  if (error instanceof UsageError) {
    deps.writeErr(`error: ${error.message}`);
    return error.exitCode;
  }
  if (error instanceof ToolCallError && error.envelope) {
    const decision = envelopeToExit(error.envelope);
    deps.writeErr(decision.stderr);
    if (decision.stdout !== undefined) deps.writeOut(decision.stdout);
    if (error.message.includes("EVIDENCE_FLOOR"))
      deps.writeErr(
        "To close with the unmet checks stamped MISSING: `jentrix session end --acknowledge-evidence-gaps` (declare deviations with `jentrix push gap`).",
      );
    return decision.code;
  }
  const withCode = error as { exitCode?: number; message?: string };
  if (typeof withCode?.exitCode === "number") {
    deps.writeErr(`error: ${withCode.message ?? "failed"}`);
    return withCode.exitCode;
  }
  const message = error instanceof Error ? error.message : String(error);
  deps.writeErr(`error: ${message}`);
  if (message.includes("EVIDENCE_FLOOR")) {
    // §6: the refusal envelope is relayed VERBATIM above; add only the escape
    // hatch — an honest close over the named gaps.
    deps.writeErr(
      "To close anyway with the unmet checks stamped MISSING: `jentrix session end --acknowledge-evidence-gaps` (a declared deviation is an ordinary `jentrix push gap`).",
    );
    return EXIT_CODES.CONFLICT;
  }
  if (isUnauthorizedError(error)) return EXIT_CODES.TRANSPORT;
  if (message.includes("SESSION_ALREADY_BOUND")) return EXIT_CODES.CONFLICT;
  if (
    message.includes("FORBIDDEN") ||
    message.includes("PROJECT_DISCOVERY_REQUIRES_UNPINNED_LOGIN")
  ) {
    return EXIT_CODES.FORBIDDEN;
  }
  return 1;
}
