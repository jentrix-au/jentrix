/**
 * `jentrix artifact` — F-6/AGE-932: the CLI wrapper over the M20.1 §12.4
 * upload-grant flow, which is deliberately REST-only (server-chosen object
 * key, single-use, checksum-bound; the grant id never rides an MCP result).
 * Nothing here weakens that design — this command is the missing
 * reachability: sha256 the file, mint the grant, PUT the bytes, then
 * `attach_artifact` consumes the grant and links the record.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

import { Command } from "commander";

import { EXIT_CODES } from "../errors";
import { ARTIFACT_TYPE_BY_PUSH_KIND, PUSH_KINDS, type PushKind } from "./push";
import { callStructured, type SessionToolCaller } from "./session";

export interface ArtifactCommandDeps {
  /** Resolve {token, url} or throw ConfigError (exit 7 when no token). */
  resolveTarget(): { token: string; url: string };
  connect(target: {
    token: string;
    url: string;
  }): Promise<{ caller: SessionToolCaller; close(): Promise<void> }>;
  fetchImpl?: typeof fetch;
  writeOut(text: string): void;
  writeErr(text: string): void;
}

export interface ArtifactAttachFlags {
  workspace?: string;
  project?: string;
  task?: string;
  run?: string;
  workOrder?: string;
  decision?: string;
  type?: string;
  /** mvp-hardening Slice 7: a push kind, mapped through the shared table. */
  kind?: string;
  title?: string;
  session?: string;
  json?: boolean;
}

/** Extension → MIME for the grant request; unknown shapes stay opaque. */
const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

/** Extension → ArtifactType default; `--type` always wins. */
const TYPE_BY_EXT: Record<string, string> = {
  ".log": "LOG",
  ".csv": "CSV",
  ".pdf": "PDF",
  ".png": "SCREENSHOT",
  ".jpg": "SCREENSHOT",
  ".jpeg": "SCREENSHOT",
  ".gif": "RECORDING",
  ".patch": "PATCH",
  ".diff": "DIFF",
};

function statusToExit(status: number): number {
  if (status === 400) return EXIT_CODES.INVALID_INPUT;
  if (status === 401 || status === 403) return EXIT_CODES.FORBIDDEN;
  if (status === 404) return EXIT_CODES.NOT_FOUND;
  if (status === 409) return EXIT_CODES.CONFLICT;
  if (status === 429) return EXIT_CODES.RATE_LIMITED;
  return EXIT_CODES.INTERNAL;
}

export async function runArtifactAttach(
  filePath: string,
  flags: ArtifactAttachFlags,
  deps: ArtifactCommandDeps,
): Promise<number> {
  // A task names its own workspace — the grant route resolves it and hands it
  // back, so `--task` alone is enough (mvp-hardening Slice 7 / AC7).
  if (!flags.workspace && !flags.task) {
    deps.writeErr(
      "--workspace <id> is required (or --task <id> to resolve it)",
    );
    return EXIT_CODES.INVALID_INPUT;
  }
  if (flags.kind && !(PUSH_KINDS as readonly string[]).includes(flags.kind)) {
    deps.writeErr(
      `unknown kind "${flags.kind}" — expected one of: ${PUSH_KINDS.join(", ")}`,
    );
    return EXIT_CODES.INVALID_INPUT;
  }
  let body: Buffer;
  try {
    body = readFileSync(filePath);
  } catch {
    deps.writeErr(`cannot read ${filePath} — pass a readable file path`);
    return EXIT_CODES.INVALID_INPUT;
  }
  const ext = extname(filePath).toLowerCase();
  const filename = basename(filePath);
  const mimeType = MIME_BY_EXT[ext] ?? "application/octet-stream";
  // --type stays the explicit escape hatch; --kind is the shared push
  // vocabulary; the extension is the fallback.
  const type =
    flags.type ??
    (flags.kind ? ARTIFACT_TYPE_BY_PUSH_KIND[flags.kind as PushKind] : null) ??
    TYPE_BY_EXT[ext] ??
    "DOC";
  const checksum = createHash("sha256").update(body).digest("hex");
  const fetchImpl = deps.fetchImpl ?? fetch;

  let target: { token: string; url: string };
  try {
    target = deps.resolveTarget();
  } catch (error) {
    deps.writeErr(error instanceof Error ? error.message : String(error));
    return EXIT_CODES.TRANSPORT;
  }
  const origin = new URL(target.url).origin;

  // 1. Server-issued grant: the server chooses the object key; the grant is
  //    single-use and bound to workspace + checksum + MIME + size + expiry.
  let grant: { uploadGrantId: string; uploadUrl: string; workspaceId: string };
  try {
    const response = await fetchImpl(
      new URL("/api/artifacts/upload-grant", origin),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${target.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...(flags.workspace ? { workspaceId: flags.workspace } : {}),
          ...(flags.task ? { taskId: flags.task } : {}),
          filename,
          mimeType,
          byteSize: body.byteLength,
          checksum,
        }),
      },
    );
    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as {
        error?: string;
        detail?: string;
      };
      deps.writeErr(
        `upload grant refused (HTTP ${response.status}): ${detail.detail ?? detail.error ?? "unknown error"}`,
      );
      return statusToExit(response.status);
    }
    const parsed = (await response.json()) as {
      uploadGrantId?: string;
      uploadUrl?: string;
      workspaceId?: string;
    };
    const workspaceId = flags.workspace ?? parsed.workspaceId;
    if (!parsed.uploadGrantId || !parsed.uploadUrl || !workspaceId) {
      deps.writeErr(
        "upload grant response is missing uploadGrantId/uploadUrl/workspaceId",
      );
      return EXIT_CODES.INTERNAL;
    }
    grant = {
      uploadGrantId: parsed.uploadGrantId,
      uploadUrl: parsed.uploadUrl,
      workspaceId,
    };
  } catch (error) {
    deps.writeErr(
      `upload grant request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return EXIT_CODES.TRANSPORT;
  }

  // 2. PUT the bytes to the presigned URL. A failed upload attaches nothing.
  try {
    const put = await fetchImpl(grant.uploadUrl, {
      method: "PUT",
      headers: { "content-type": mimeType },
      body: new Uint8Array(body),
    });
    if (!put.ok) {
      deps.writeErr(
        `upload failed (HTTP ${put.status}) — the grant expires unused; retry the command`,
      );
      return EXIT_CODES.INTERNAL;
    }
  } catch (error) {
    deps.writeErr(
      `upload failed: ${error instanceof Error ? error.message : String(error)} — the grant expires unused; retry the command`,
    );
    return EXIT_CODES.TRANSPORT;
  }

  // 3. attach_artifact consumes the grant and creates the linked record.
  try {
    const { caller, close } = await deps.connect(target);
    try {
      const result = await callStructured(caller, "attach_artifact", {
        workspaceId: grant.workspaceId,
        type,
        title: flags.title ?? filename,
        storage: "R2_OBJECT",
        uploadGrantId: grant.uploadGrantId,
        mimeType,
        byteSize: body.byteLength,
        checksum,
        source: "cli",
        ...(flags.project ? { projectId: flags.project } : {}),
        ...(flags.task ? { taskId: flags.task } : {}),
        ...(flags.run ? { runId: flags.run } : {}),
        ...(flags.workOrder ? { workOrderId: flags.workOrder } : {}),
        ...(flags.decision ? { decisionId: flags.decision } : {}),
        // AC13: keep the session attribution when the operator names one.
        ...(flags.session ? { sessionId: flags.session } : {}),
        // Unique per grant: protects a transport retry of THIS invocation
        // without colliding with a deliberate re-attach of the same file.
        idempotencyKey: `cli-artifact:${grant.uploadGrantId}`,
      });
      const artifact = (result.artifact ?? {}) as Record<string, unknown>;
      deps.writeOut(
        flags.json
          ? // The id at the top level: every other artifact-producing command
            // answers `artifactId`, and a caller should not have to know which
            // envelope this one came in.
            JSON.stringify({ artifactId: artifact.id ?? null, ...result })
          : `Attached artifact ${String(artifact.id ?? "?")} · ${String(artifact.title ?? filename)} (${type}, ${body.byteLength} bytes)`,
      );
      return 0;
    } finally {
      await close().catch(() => undefined);
    }
  } catch (error) {
    deps.writeErr(
      `attach_artifact failed: ${error instanceof Error ? error.message : String(error)} — the uploaded object is unreferenced until the grant expires`,
    );
    return EXIT_CODES.INTERNAL;
  }
}

export function registerArtifactCommand(
  program: Command,
  deps: ArtifactCommandDeps,
  onExit: (code: number) => void,
): Command {
  // Named `upload`, not `attach`: the generated tree mounts the raw
  // attach_artifact tool as `artifact attach` into this SAME group (see
  // mountCommandTree's reuse rule), and a duplicate leaf name would shadow
  // whichever registered second.
  const artifact = program
    .command("artifact")
    .description(
      "Store files as first-class artifacts (upload-grant flow) linked to tasks, projects, runs, or Work Orders.",
    );
  artifact
    .command("upload <file>")
    .description(
      "Upload a file through a server-issued grant and attach it as an artifact (sha256-bound; object key chosen server-side).",
    )
    .option(
      "--workspace <id>",
      "workspace to attach into (optional when --task names one)",
    )
    .option("--project <id>", "link to a project")
    .option("--task <id>", "link to a task")
    .option("--run <id>", "link to a run")
    .option("--work-order <id>", "link to a Work Order")
    .option("--decision <id>", "link to a decision")
    .option(
      "--kind <kind>",
      `push kind (${PUSH_KINDS.join("|")}) — files under the same ArtifactType, hence the same work layer, as \`jentrix push\``,
    )
    .option("--session <id>", "attribute the artifact to a connected session")
    .option(
      "--type <type>",
      "ArtifactType (default inferred from --kind, else the extension, else DOC)",
    )
    .option("--title <title>", "artifact title (default: the file name)")
    .option("--json", "stable JSON output")
    .action(async (file: string, flags: ArtifactAttachFlags) =>
      onExit(await runArtifactAttach(file, flags, deps)),
    );
  // Returned so main.ts can mount siblings (`mint-issue` rides the session
  // deps, which this module's REST-only deps deliberately are not).
  return artifact;
}
