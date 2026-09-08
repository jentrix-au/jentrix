/** Session doctor. */
import {
  type SessionCommandDeps,
  type DoctorCheck,
  type SessionDoctorFlags,
} from "./deps";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type ProviderHookContext,
  readCurrentProviderHookContext,
  telemetrySourceFor,
} from "./provider-context";
import { refuseProjectScope } from "./runtime";
import { EXIT_CODES } from "../errors";
import { clientChecks, doctorBundle } from "../commands/doctor-client";
import { inspectRepository } from "../repo";
import { readFolderBinding, requireFolderBinding } from "../binding";
import { callStructured as call } from "../tool-client";

/** Check the bundled host and spool before any connected-session operation. */
export async function doctorLocalChecks(
  deps: Pick<SessionCommandDeps, "resolveSessionHost" | "spoolRoot">,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  // Client-runtime v2 (G6): the session host ships INSIDE this package — the
  // check is the bundled entry's presence, never a runner install.
  const host = deps.resolveSessionHost();
  checks.push(
    host
      ? { name: "session host", status: "ok", detail: host }
      : {
          name: "session host",
          status: "fail",
          detail:
            "SESSION_HOST_MISSING: this install carries no dist/session-host-main.js",
          fix: "reinstall @jentrix/cli (or `pnpm build` in a source checkout)",
        },
  );
  try {
    mkdirSync(deps.spoolRoot, { recursive: true, mode: 0o700 });
    const probe = join(deps.spoolRoot, `.doctor-${process.pid}`);
    writeFileSync(probe, "ok", { mode: 0o600 });
    unlinkSync(probe);
    checks.push({
      name: "spool",
      status: "ok",
      detail: `${deps.spoolRoot} writable`,
    });
  } catch (error) {
    checks.push({
      name: "spool",
      status: "fail",
      detail: `spool root is not writable: ${error instanceof Error ? error.message : String(error)}`,
      fix: `fix permissions on ${deps.spoolRoot}`,
    });
  }
  return checks;
}

/**
 * W2/C2.4 — what a session started HERE would actually record, from the same
 * `telemetrySourceFact` align and `session status` read. A preflight that
 * reports "Ready" while the hooks have never fired is the JEN-163 failure one
 * step earlier: the operator learns at `end` that four of five capabilities
 * were never observed.
 *
 * Local and read-only: the CURRENT provider context plus the hook ledger. No
 * session exists yet, so there is no server row to ask.
 */
export function telemetrySourceCheck(
  deps: Pick<SessionCommandDeps, "env" | "cwd">,
): DoctorCheck {
  let context: ProviderHookContext | null;
  try {
    context = readCurrentProviderHookContext(deps);
  } catch (error) {
    return {
      name: "telemetry",
      status: "warn",
      detail: error instanceof Error ? error.message : String(error),
      fix: "run this inside the target provider task, or pass --provider-session <id> to align",
    };
  }
  if (!context) {
    return {
      name: "telemetry",
      status: "skip",
      detail:
        "no provider session is identified here — a session started from this shell records nothing until one is",
      fix: "run this from inside a Claude Code or Codex task with the Jentrix plugin installed",
    };
  }
  const fact = telemetrySourceFor(
    deps,
    context.provider,
    context.sessionId,
    context.transcriptPath,
  );
  return fact.missing.length === 0
    ? { name: "telemetry", status: "ok", detail: fact.detail }
    : {
        name: "telemetry",
        status: "warn",
        detail: `${fact.detail} — NOT recorded: ${fact.missing.join(", ")}`,
        ...(fact.remedy ? { fix: fact.remedy } : {}),
      };
}

/**
 * Slice 6 — the single preflight. Runs EVERY connected-session precondition
 * (credential + pin, session host present, spool root writable, repository
 * identity and folder workspace binding) and reports all failures at once,
 * instead of surfacing one blocker per session-start round trip. Read-only:
 * creates no session, adds no link, invokes no model.
 */
export async function runSessionDoctor(
  flags: SessionDoctorFlags,
  deps: SessionCommandDeps,
): Promise<number> {
  if (refuseProjectScope(flags.project, deps)) return EXIT_CODES.INVALID_INPUT;
  const checks: DoctorCheck[] = [];

  // — local checks (no server round trip) —
  checks.push(...(await doctorLocalChecks(deps)));
  checks.push(telemetrySourceCheck(deps));
  // — the client itself (open-client S5): what is installed, who owns the
  // marketplaces, whether the hooks are pinned, and the adopted contract
  // against the endpoint's (one unauthenticated GET) —
  checks.push(...(await clientChecks(deps)));

  let repo: string | null = null;
  const inspection = await inspectRepository(deps.cwd(), deps.git);
  if (!inspection) {
    checks.push({
      name: "repository",
      status: "fail",
      detail: "the current directory is not inside a git work tree",
      fix: "run from your project checkout",
    });
  } else {
    repo = inspection.repoOwnerName;
    const state = `branch ${inspection.branch ?? "detached"}, ${inspection.dirty ? "dirty" : "clean"}`;
    checks.push({
      name: "repository",
      status: "ok",
      // A remote-less checkout is supported, not a failure — but say WHERE
      // the identity came from, since it is the folder name and it moves
      // with a rename.
      detail: inspection.syntheticRepoIdentity
        ? `${repo} (${state}) — no usable origin remote, so this checkout is identified by its directory name`
        : `${repo} (${state})`,
    });
    // Client-runtime v2 §11: the folder binding is what scopes a session —
    // THE first-run precondition, checked where the old flow checked
    // project links.
    let binding = null;
    try {
      binding = readFolderBinding(inspection.root);
    } catch (error) {
      checks.push({
        name: "folder binding",
        status: "fail",
        detail: error instanceof Error ? error.message : String(error),
        fix: "jentrix folder align",
      });
    }
    checks.push(
      binding
        ? {
            name: "folder binding",
            status: "ok",
            detail: `workspace ${binding.workspaceSlug} @ ${binding.endpoint}`,
          }
        : {
            name: "folder binding",
            status: "fail",
            detail:
              "FOLDER_NOT_ALIGNED: this checkout has no workspace binding",
            fix: "jentrix folder align --workspace <slug> (setup normally does this)",
          },
    );
  }

  // — server checks (one connection, every check still reported) —
  let target: { token: string; url: string } | null = null;
  try {
    target = deps.resolveTarget();
  } catch (error) {
    checks.push({
      name: "credential",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      fix: "jentrix login (or set STACKS_TOKEN)",
    });
  }
  if (target) {
    try {
      const { caller, close } = await deps.connect(target);
      try {
        let pinnedWorkspaceId: string | null = null;
        try {
          const context = await call(caller, "get_token_context", {});
          const scopes = (context.scopes as string[]) ?? [];
          const pinned = context.workspacePinned === true;
          pinnedWorkspaceId =
            pinned && typeof context.workspaceId === "string"
              ? context.workspaceId
              : null;
          const missing = ["read", "write"].filter(
            (scope) => !scopes.includes(scope),
          );
          checks.push(
            missing.length > 0
              ? {
                  name: "credential",
                  status: "fail",
                  detail: `token lacks the ${missing.join(" + ")} scope${missing.length > 1 ? "s" : ""} a session needs`,
                  fix: "jentrix login (or mint a read+write token)",
                }
              : {
                  name: "credential",
                  status: "ok",
                  detail: `scopes ${scopes.join(", ")} · ${pinned ? `pinned to workspace ${pinnedWorkspaceId}` : "unpinned"}`,
                },
          );
        } catch (error) {
          checks.push({
            name: "credential",
            status: "fail",
            detail: `token verification failed: ${error instanceof Error ? error.message : String(error)}`,
            fix: "jentrix login",
          });
        }

        // Projects label tasks; repository/project links are not session gates.
        checks.push({
          name: "project labels",
          status: "ok",
          detail:
            "Projects are optional task labels (jentrix task project add); they do not scope sessions.",
        });
        if (inspection) {
          try {
            const binding = requireFolderBinding(inspection.root, {
              endpoint: target.url,
              repoOwnerName: inspection.repoOwnerName,
            });
            if (
              pinnedWorkspaceId &&
              binding.workspaceId !== pinnedWorkspaceId
            ) {
              checks.push({
                name: "workspace pin",
                status: "fail",
                detail:
                  "FOLDER_WORKSPACE_MISMATCH: the credential is pinned to a different workspace",
                fix: "use a credential for the folder workspace, or explicitly re-align the folder",
              });
            }
          } catch (error) {
            // Missing binding was already reported locally; drift is an additional failure.
            if (
              !(error instanceof Error) ||
              !error.message.includes("FOLDER_NOT_ALIGNED")
            )
              checks.push({
                name: "folder scope",
                status: "fail",
                detail: error instanceof Error ? error.message : String(error),
                fix: "jentrix folder align",
              });
          }
        }
      } finally {
        await close().catch(() => undefined);
      }
    } catch (error) {
      checks.push({
        name: "credential",
        status: "fail",
        detail: `cannot reach ${target.url}: ${error instanceof Error ? error.message : String(error)}`,
        fix: "check STACKS_MCP_URL / network, or jentrix login",
      });
    }
  }

  const failed = checks.filter((check) => check.status === "fail");
  const warned = checks.filter((check) => check.status === "warn");
  // Open-client R2 S2 (PRD §8 Phase 5): the redacted support bundle. Built
  // from the checks above and nothing else; the resolved bearer (if any) is
  // scrubbed as a literal on top of the redactor's patterns. Written with
  // owner-only permissions; the user previews and shares it by hand.
  let bundlePath: string | null = null;
  if (flags.bundle) {
    const bundle = doctorBundle(checks, {
      env: deps.env,
      homedir: deps.client?.homeDir() ?? deps.env.HOME ?? null,
      literals: target ? [target.token] : [],
    });
    bundlePath =
      typeof flags.bundle === "string"
        ? resolve(deps.cwd(), flags.bundle)
        : join(
            deps.cwd(),
            `jentrix-doctor-${bundle.generatedAt.slice(0, 19).replace(/[:T]/g, "-")}.json`,
          );
    writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, {
      mode: 0o600,
    });
  }
  if (flags.json) {
    deps.writeOut(
      JSON.stringify({
        ok: failed.length === 0,
        checks,
        ...(bundlePath ? { bundle: bundlePath } : {}),
      }),
    );
    return failed.length === 0 ? 0 : 1;
  }
  deps.writeOut(
    `Connected-session preflight: ${failed.length} failed, ${warned.length} warning(s), ${checks.filter((c) => c.status === "ok").length} ok`,
  );
  const ICONS = { ok: "✓", warn: "⚠", fail: "✗", skip: "-" } as const;
  for (const check of checks) {
    deps.writeOut(
      `  ${ICONS[check.status]} ${check.name.padEnd(12)} ${check.detail}`,
    );
    if (check.fix) deps.writeOut(`      fix: ${check.fix}`);
  }
  if (bundlePath) {
    deps.writeOut(
      `Support bundle written: ${bundlePath} — redacted (no tokens, no transcript content, no hook bodies, no file contents). Preview it, then attach it to your report by hand; nothing uploads it.`,
    );
  }
  deps.writeOut(
    failed.length === 0
      ? "Ready — start with: jentrix session connect --provider claude|codex, then jentrix session align --task <id-or-key>"
      : `${failed.length} blocker(s) — fix everything above in one pass, then re-run.`,
  );
  return failed.length === 0 ? 0 : 1;
}
