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
import { callStructured, type SessionToolCaller } from "../tool-client";

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

/** A failed upload step, with the exit code the CLI surface maps it to. */
export class ArtifactAttachError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
  ) {
    super(message);
    this.name = "ArtifactAttachError";
  }
}

export interface AttachedFile {
  artifactId: string;
  type: string;
  title: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  checksum: string;
}

/**
 * R04 — the upload core as a FUNCTION (grant → PUT → attach_artifact), so the
 * output manifest can register many files through the SAME path the single
 * `artifact upload` command uses: bytes preserved, sha256-bound, MIME from
 * the extension, never a UTF-8 Markdown coercion. Throws
 * {@link ArtifactAttachError}; prints nothing.
 */
export async function attachFile(
  filePath: string,
  flags: ArtifactAttachFlags,
  deps: ArtifactCommandDeps,
): Promise<AttachedFile> {
  if (!flags.workspace && !flags.task) {
    throw new ArtifactAttachError(
      "--workspace <id> is required (or --task <id> to resolve it)",
      EXIT_CODES.INVALID_INPUT,
    );
  }
  if (flags.kind && !(PUSH_KINDS as readonly string[]).includes(flags.kind)) {
    throw new ArtifactAttachError(
      `unknown kind "${flags.kind}" — expected one of: ${PUSH_KINDS.join(", ")}`,
      EXIT_CODES.INVALID_INPUT,
    );
  }
  let body: Buffer;
  try {
    body = readFileSync(filePath);
  } catch {
    throw new ArtifactAttachError(
      `cannot read ${filePath} — pass a readable file path`,
      EXIT_CODES.INVALID_INPUT,
    );
  }
  const ext = extname(filePath).toLowerCase();
  const filename = basename(filePath);
  const mimeType = MIME_BY_EXT[ext] ?? "application/octet-stream";
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
    throw new ArtifactAttachError(
      error instanceof Error ? error.message : String(error),
      EXIT_CODES.TRANSPORT,
    );
  }
  const origin = new URL(target.url).origin;

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
      throw new ArtifactAttachError(
        `upload grant refused (HTTP ${response.status}): ${detail.detail ?? detail.error ?? "unknown error"}`,
        statusToExit(response.status),
      );
    }
    const parsed = (await response.json()) as {
      uploadGrantId?: string;
      uploadUrl?: string;
      workspaceId?: string;
    };
    const workspaceId = flags.workspace ?? parsed.workspaceId;
    if (!parsed.uploadGrantId || !parsed.uploadUrl || !workspaceId) {
      throw new ArtifactAttachError(
        "upload grant response is missing uploadGrantId/uploadUrl/workspaceId",
        EXIT_CODES.INTERNAL,
      );
    }
    grant = {
      uploadGrantId: parsed.uploadGrantId,
      uploadUrl: parsed.uploadUrl,
      workspaceId,
    };
  } catch (error) {
    if (error instanceof ArtifactAttachError) throw error;
    throw new ArtifactAttachError(
      `upload grant request failed: ${error instanceof Error ? error.message : String(error)}`,
      EXIT_CODES.TRANSPORT,
    );
  }

  try {
    const put = await fetchImpl(grant.uploadUrl, {
      method: "PUT",
      headers: { "content-type": mimeType },
      body: new Uint8Array(body),
    });
    if (!put.ok) {
      throw new ArtifactAttachError(
        `upload failed (HTTP ${put.status}) — the grant expires unused; retry the command`,
        EXIT_CODES.INTERNAL,
      );
    }
  } catch (error) {
    if (error instanceof ArtifactAttachError) throw error;
    throw new ArtifactAttachError(
      `upload failed: ${error instanceof Error ? error.message : String(error)} — the grant expires unused; retry the command`,
      EXIT_CODES.TRANSPORT,
    );
  }

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
        ...(flags.session ? { sessionId: flags.session } : {}),
        idempotencyKey: `cli-artifact:${grant.uploadGrantId}`,
      });
      const artifact = (result.artifact ?? {}) as Record<string, unknown>;
      return {
        artifactId: String(artifact.id ?? ""),
        type,
        title: String(artifact.title ?? flags.title ?? filename),
        filename,
        mimeType,
        byteSize: body.byteLength,
        checksum,
      };
    } finally {
      await close().catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof ArtifactAttachError) throw error;
    throw new ArtifactAttachError(
      `attach_artifact failed: ${error instanceof Error ? error.message : String(error)} — the uploaded object is unreferenced until the grant expires`,
      EXIT_CODES.INTERNAL,
    );
  }
}

export async function runArtifactAttach(
  filePath: string,
  flags: ArtifactAttachFlags,
  deps: ArtifactCommandDeps,
): Promise<number> {
  try {
    const attached = await attachFile(filePath, flags, deps);
    deps.writeOut(
      flags.json
        ? JSON.stringify({ artifactId: attached.artifactId || null, artifact: attached })
        : `Attached artifact ${attached.artifactId || "?"} · ${attached.title} (${attached.type}, ${attached.byteSize} bytes)`,
    );
    return 0;
  } catch (error) {
    if (error instanceof ArtifactAttachError) {
      deps.writeErr(error.message);
      return error.exitCode;
    }
    throw error;
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
