/**
 * F-6/AGE-932 — `jentrix artifact attach <file>`: the CLI wrapper over the
 * REST-only upload-grant flow (sha256 → POST /api/artifacts/upload-grant →
 * PUT presigned → attach_artifact with the consumed grant). The grant design
 * stays server-chosen-key + single-use; this command is reachability, not a
 * second path. All deps injected — no sockets, no fs beyond the temp file.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  runArtifactAttach,
  type ArtifactCommandDeps,
} from "../src/commands/artifact";

function tempFile(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "stacks-artifact-"));
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

interface HttpCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | Uint8Array | null;
}

function fakeDeps(opts: {
  grantResponse?: { status: number; body: unknown };
  putResponse?: { status: number };
  attachResult?: unknown;
}) {
  const out: string[] = [];
  const err: string[] = [];
  const http: HttpCall[] = [];
  const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const deps: ArtifactCommandDeps & {
    out: string[];
    err: string[];
    http: HttpCall[];
    toolCalls: typeof toolCalls;
  } = {
    out,
    err,
    http,
    toolCalls,
    resolveTarget: () => ({
      token: "tm_secret",
      url: "https://stacks.example/api/mcp",
    }),
    connect: async () => ({
      caller: {
        async callTool({ name, arguments: args }) {
          toolCalls.push({ name, args });
          return {
            structuredContent: opts.attachResult ?? {
              artifact: { id: "art_1", title: "t", downloadUrl: null },
            },
          };
        },
      },
      close: async () => undefined,
    }),
    fetchImpl: (async (url: URL | string, init?: RequestInit) => {
      const call: HttpCall = {
        url: String(url),
        method: init?.method ?? "GET",
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: (init?.body as string | Uint8Array | undefined) ?? null,
      };
      http.push(call);
      if (String(url).includes("/api/artifacts/upload-grant")) {
        const grant = opts.grantResponse ?? {
          status: 200,
          body: {
            uploadGrantId: "grant_1",
            uploadUrl: "https://r2.example/put/abc",
            expiresAt: "2026-08-07T01:00:00.000Z",
          },
        };
        return {
          ok: grant.status < 400,
          status: grant.status,
          json: async () => grant.body,
          text: async () => JSON.stringify(grant.body),
        } as unknown as Response;
      }
      const put = opts.putResponse ?? { status: 200 };
      return {
        ok: put.status < 400,
        status: put.status,
        json: async () => ({}),
        text: async () => "",
      } as unknown as Response;
    }) as typeof fetch,
    writeOut: (text) => out.push(text),
    writeErr: (text) => err.push(text),
  };
  return deps;
}

test("artifact attach: sha256 → grant → PUT → attach_artifact with the grant id", async () => {
  const body = "<!doctype html><title>report</title>";
  const path = tempFile("report.html", body);
  const d = fakeDeps({});
  const code = await runArtifactAttach(
    path,
    { workspace: "ws_1", project: "proj_1", task: "task_1" },
    d,
  );
  assert.equal(code, 0);

  const grantCall = d.http.find((c) => c.url.includes("/upload-grant"))!;
  assert.equal(grantCall.method, "POST");
  assert.equal(grantCall.headers.authorization, "Bearer tm_secret");
  const grantBody = JSON.parse(String(grantCall.body)) as Record<
    string,
    unknown
  >;
  assert.equal(grantBody.workspaceId, "ws_1");
  assert.equal(grantBody.filename, "report.html");
  assert.equal(grantBody.mimeType, "text/html");
  assert.equal(grantBody.byteSize, Buffer.byteLength(body));
  assert.equal(
    grantBody.checksum,
    createHash("sha256").update(body).digest("hex"),
  );

  const put = d.http.find((c) => c.url === "https://r2.example/put/abc")!;
  assert.equal(put.method, "PUT");
  assert.equal(Buffer.from(put.body as Uint8Array).toString(), body);

  const attach = d.toolCalls.find((c) => c.name === "attach_artifact")!;
  assert.equal(attach.args.storage, "R2_OBJECT");
  assert.equal(attach.args.uploadGrantId, "grant_1");
  assert.equal(attach.args.workspaceId, "ws_1");
  assert.equal(attach.args.projectId, "proj_1");
  assert.equal(attach.args.taskId, "task_1");
  assert.equal(attach.args.title, "report.html");
  assert.equal(attach.args.type, "DOC");
  assert.match(d.out.join("\n"), /art_1/);
});

test("artifact attach: type inferred from extension, --type wins", async () => {
  const logPath = tempFile("build.log", "line1\n");
  const d = fakeDeps({});
  assert.equal(await runArtifactAttach(logPath, { workspace: "ws_1" }, d), 0);
  assert.equal(
    d.toolCalls.find((c) => c.name === "attach_artifact")!.args.type,
    "LOG",
  );

  const d2 = fakeDeps({});
  assert.equal(
    await runArtifactAttach(logPath, { workspace: "ws_1", type: "TRACE" }, d2),
    0,
  );
  assert.equal(
    d2.toolCalls.find((c) => c.name === "attach_artifact")!.args.type,
    "TRACE",
  );
});

test("artifact attach: unconfigured object storage is an honest refusal, not a stack trace", async () => {
  const path = tempFile("a.txt", "x");
  const d = fakeDeps({
    grantResponse: {
      status: 503,
      body: {
        error: "ARTIFACT_UPLOAD_REFUSED",
        detail: "object storage is not configured",
      },
    },
  });
  const code = await runArtifactAttach(path, { workspace: "ws_1" }, d);
  assert.notEqual(code, 0);
  assert.match(d.err.join("\n"), /object storage is not configured/);
  assert.equal(d.toolCalls.length, 0, "no attach call after a refused grant");
});

test("artifact attach: a failed PUT never attaches a phantom artifact", async () => {
  const path = tempFile("a.txt", "x");
  const d = fakeDeps({ putResponse: { status: 500 } });
  const code = await runArtifactAttach(path, { workspace: "ws_1" }, d);
  assert.notEqual(code, 0);
  assert.match(d.err.join("\n"), /upload failed/i);
  assert.equal(d.toolCalls.length, 0);
});

test("artifact attach: a missing file is INVALID_INPUT with the path named", async () => {
  const d = fakeDeps({});
  const code = await runArtifactAttach(
    "/nonexistent/nope.bin",
    { workspace: "ws_1" },
    d,
  );
  assert.equal(code, 2);
  assert.match(d.err.join("\n"), /nope\.bin/);
});
