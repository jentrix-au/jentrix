/**
 * `jentrix session contact --paths a,b,c` (hardening PRD S3, D11) — which of
 * the named files did THIS session actually open?
 *
 * The defect it answers (§4 G7): the export-zip run pushed a GAP about
 * `tests/e2e/workspace-transfer.spec.ts` having never read it — the `toBe(1)`
 * line it claimed to be blocked by never appeared in any tool result. Capture
 * already held the answer; nothing asked it.
 *
 * Reads the LOCAL spool's skeleton snapshot, not the server: the answer must
 * work offline, mid-session, and with TRACE capture off (the MVP default), and
 * the skeleton is content-free metadata collected independently of TRACE.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { EXIT_CODES } from "../errors";
import { UsageError } from "../tool-client";
import { type SessionCommandDeps } from "./deps";
import { reportError } from "./runtime";
import { ownAlignedSessionId } from "./status";

/** The subset of the spooled skeleton this answer needs. */
export interface ContactEvidence {
  paths: string[];
  /** The path list was capped — "never opened" is then not provable. */
  truncated: boolean;
  updatedAt: string | null;
}

export interface ContactVerdict {
  path: string;
  opened: boolean;
}

/** Read `<spool>/<sessionId>/skeleton.json`; absent = nothing observed yet. */
export function readContactEvidence(
  spoolRoot: string,
  sessionId: string,
): ContactEvidence | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      readFileSync(join(spoolRoot, sessionId, "skeleton.json"), "utf8"),
    );
  } catch {
    return null;
  }
  const snapshot = (parsed ?? {}) as {
    skeleton?: {
      filesTouched?: { paths?: unknown; listTruncated?: unknown };
      truncated?: unknown;
    };
    updatedAt?: unknown;
  };
  const raw = snapshot.skeleton?.filesTouched?.paths;
  return {
    paths: Array.isArray(raw)
      ? raw.filter((p): p is string => typeof p === "string")
      : [],
    truncated:
      snapshot.skeleton?.filesTouched?.listTruncated === true ||
      snapshot.skeleton?.truncated === true,
    updatedAt:
      typeof snapshot.updatedAt === "string" ? snapshot.updatedAt : null,
  };
}

/**
 * Does an observed path name the wanted one? The skeleton stores whatever the
 * tool input carried — absolute, repo-relative, or home-prefix scrubbed by the
 * redactor — so the match is on path SUFFIX in both directions, normalized to
 * "/"-separated segments. Suffix, not substring: `a/b.ts` must not be answered
 * by `xa/b.ts`.
 */
export function pathsMatch(observed: string, wanted: string): boolean {
  const norm = (value: string) =>
    value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const a = norm(observed);
  const b = norm(wanted);
  if (a === b) return true;
  const endsWithSegment = (long: string, short: string) =>
    long.length > short.length &&
    long.endsWith(short) &&
    long[long.length - short.length - 1] === "/";
  return endsWithSegment(a, b) || endsWithSegment(b, a);
}

/** The verdict for each wanted path, in the order the caller named them. */
export function contactVerdicts(
  evidence: ContactEvidence | null,
  wanted: string[],
): ContactVerdict[] {
  const observed = evidence?.paths ?? [];
  return wanted.map((path) => ({
    path,
    opened: observed.some((seen) => pathsMatch(seen, path)),
  }));
}

/** Split a `--paths` value: comma or whitespace separated, empties dropped. */
export function parsePathsFlag(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** The printable answer, verdicts first, caveats named. */
export function renderContact(
  evidence: ContactEvidence | null,
  verdicts: ContactVerdict[],
): string {
  const lines = verdicts.map(
    (verdict) =>
      `${verdict.opened ? "opened     " : "never opened"} ${verdict.path}`,
  );
  if (!evidence) {
    lines.push(
      "",
      "no local activity skeleton for this session yet — nothing has been observed, so every answer above is 'never opened' by absence, not by evidence",
    );
    return lines.join("\n");
  }
  lines.push(
    "",
    `from the local activity skeleton (${evidence.paths.length} distinct path(s) observed, updated ${evidence.updatedAt ?? "unknown"})`,
  );
  if (evidence.truncated) {
    lines.push(
      "the observed path list was CAPPED — a 'never opened' here may be a dropped entry, not an unread file",
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/**
 * `jentrix session contact [sessionId] --paths a,b,c`. Resolves the session
 * exactly as `status`, `push` and `end` do — trusted provider context, then
 * this checkout's alignment marker — so a bare invocation answers about the
 * session the operator is in.
 */
export async function runSessionContact(
  sessionId: string | undefined,
  flags: { paths?: string; json?: boolean },
  deps: SessionCommandDeps,
): Promise<number> {
  try {
    const wanted = parsePathsFlag(flags.paths ?? "");
    if (wanted.length === 0) {
      throw new UsageError(
        "--paths <a,b,c> is required: name the files to ask about (comma- or space-separated)",
      );
    }
    const resolved = sessionId ?? (await ownAlignedSessionId(deps));
    if (!resolved) {
      throw new UsageError(
        "no session — pass a session id, or align this checkout first (`jentrix session align --task <id-or-key>`)",
      );
    }
    const evidence = readContactEvidence(deps.spoolRoot, resolved);
    const verdicts = contactVerdicts(evidence, wanted);
    deps.writeOut(
      flags.json === true
        ? JSON.stringify(
            {
              sessionId: resolved,
              observedPathCount: evidence?.paths.length ?? 0,
              observedTruncated: evidence?.truncated ?? false,
              updatedAt: evidence?.updatedAt ?? null,
              paths: verdicts,
            },
            null,
            2,
          )
        : renderContact(evidence, verdicts),
    );
    return EXIT_CODES.OK;
  } catch (error) {
    return reportError(error, deps);
  }
}

// ---------------------------------------------------------------------------
// D11 — the gap refusal
// ---------------------------------------------------------------------------

/**
 * Path-shaped tokens a GAP body names. Same syntactic shape the skeleton's
 * Bash tokenizer accepts, read out of prose instead of a command line: a token
 * containing "/" that ends in a dotted extension. Backticks, quotes and
 * ordinary sentence punctuation are stripped first.
 *
 * ponytail: syntactic, like its sibling. It will miss a file named without its
 * directory ("zip.ts") and will pick up a path inside a fenced block. The
 * caller filters to what actually exists in the checkout, which is the test
 * that makes a false positive harmless.
 */
const PROSE_SPLIT = /[\s`'"()\[\]{}<>,;]+/;
const PROSE_PATH = /^[\w.@~+-][\w./@~+-]*\/[\w./@~+-]*\.[A-Za-z][\w]{0,9}$/;

export function pathsNamedIn(body: string): string[] {
  const seen = new Set<string>();
  for (const raw of body.split(PROSE_SPLIT)) {
    const token = raw.replace(/[.,;:]+$/, "");
    if (!token || token.length > 300) continue;
    if (/[*?$!]/.test(token)) continue;
    if (!PROSE_PATH.test(token)) continue;
    seen.add(token);
  }
  return [...seen];
}

/**
 * D11/AC3.4 — the paths a gap body names that exist in THIS checkout and that
 * the session never opened. Empty means the push may proceed.
 *
 * The in-checkout test is what keeps the syntactic tokenizer honest: a path in
 * an `echo`, a URL fragment, or a file in someone else's tree is not something
 * this session could have read, so it is never held against the author. What
 * remains is exactly the §4 G7 shape — a gap filed about a file in front of
 * the agent that it never opened, whose one-line read is the read that would
 * have shown it the answer.
 */
export function unreadPathsNamedIn(
  body: string,
  evidence: ContactEvidence | null,
  existsInCheckout: (path: string) => boolean,
): string[] {
  const observed = evidence?.paths ?? [];
  return pathsNamedIn(body).filter((named) => {
    if (!existsInCheckout(named)) return false;
    return !observed.some((seen) => pathsMatch(seen, named));
  });
}
