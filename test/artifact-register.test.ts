import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  MAX_MANIFEST_ENTRIES,
  parsePaths,
  renderManifest,
  runArtifactRegister,
} from "../src/commands/artifact-register";
import type { PushDeps } from "../src/commands/push";
import { parseSemanticHeader, headerNumber, headerString } from "../src/session-host/semantic-header";
import { writeAlignmentMarker } from "../src/session/state";

// R04 — the bounded output manifest: every declared file goes through the
// upload-grant core (bytes, MIME, sha256), then ONE attested REPORT names
// what landed and what did not. A missing path refuses before any upload.

function scene(opts: { failPut?: (filename: string) => boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "jentrix-register-"));
  const out: string[] = [];
  const err: string[] = [];
  const grants: Array<Record<string, unknown>> = [];
  const puts: Array<{ url: string; bytes: number }> = [];
  const attaches: Array<Record<string, unknown>> = [];
  const pushes: Array<Record<string, unknown>> = [];
  let grantNo = 0;
  const deps: PushDeps = {
    env: { CODEX_THREAD_ID: "thread-1" },
    cwd: () => dir,
    configPath: join(dir, "config.json"),
    resolveTarget: () => ({ token: "tm_test_token_abcdefghijklmnop", url: "http://localhost:3000/api/mcp" }),
    ensureInstallationId: () => "install-1",
    connect: async () => ({
      caller: {
        async callTool({ name, arguments: args }) {
          if (name === "get_agent_session") {
            return { structuredContent: { id: (args as { sessionId: string }).sessionId, workspaceId: "ws_1", taskId: "task_from_session" } };
          }
          assert.equal(name, "attach_artifact");
          attaches.push(args as Record<string, unknown>);
          return { structuredContent: { artifact: { id: `art_${attaches.length}`, title: (args as { title: string }).title } } };
        },
      },
      close: async () => undefined,
    }),
    git: async (args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { code: 0, stdout: `${dir}\n` };
      if (args[0] === "remote") return { code: 0, stdout: "git@github.com:acme/app.git\n" };
      if (args[0] === "symbolic-ref") return { code: 0, stdout: "main\n" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "abc123abc123\n" };
      if (args[0] === "status") return { code: 0, stdout: "" };
      return { code: 0, stdout: "" };
    },
    writeOut: (t) => out.push(t),
    writeErr: (t) => err.push(t),
    isInteractive: false,
    readLine: async () => "",
    runSessionHost: async () => 0,
    spawnSessionHostDetached: () => -1,
    spoolRoot: join(dir, "spool"),
    resolveSessionHost: () => null,
    fetchImpl: (async (url: URL | string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/api/artifacts/upload-grant")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        grants.push(body);
        grantNo += 1;
        return new Response(JSON.stringify({ uploadGrantId: `grant_${grantNo}`, uploadUrl: `http://store.test/put/${body.filename}`, workspaceId: "ws_1" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u.startsWith("http://store.test/put/")) {
        const filename = u.split("/").pop()!;
        puts.push({ url: u, bytes: (init?.body as Uint8Array).byteLength });
        return new Response("", { status: opts.failPut?.(filename) ? 500 : 200 });
      }
      if (u.includes("/artifacts")) {
        pushes.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ artifactId: "art_manifest", type: "REPORT", deduped: false }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${u}`);
    }) as typeof fetch,
  };
  writeAlignmentMarker(deps.configPath, dir, { sessionId: "ses_r", workspaceId: "ws_1", projectId: "proj_1", taskId: "task_1", capture: "off", alignedAt: new Date().toISOString() }, "thread-1");
  writeFileSync(join(dir, "report.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0xfe]));
  writeFileSync(join(dir, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  return { dir, deps, out, err, grants, puts, attaches, pushes };
}

describe("jentrix artifact register (R04 output manifest)", () => {
  it("uploads each file byte-for-byte through the grant path and pushes ONE attested manifest naming every entry", async () => {
    const s = scene();
    const code = await runArtifactRegister({ paths: "report.pdf, shot.png" }, s.deps);
    assert.equal(code, 0);
    assert.equal(s.grants.length, 2);
    assert.deepEqual(s.grants.map((g) => g.mimeType), ["application/pdf", "image/png"]);
    assert.deepEqual(s.puts.map((p) => p.bytes), [8, 6], "the raw bytes went up, not a Markdown rendering");
    assert.equal(s.attaches.length, 2);
    assert.equal(s.attaches[0]!.taskId, "task_1");
    assert.equal(s.attaches[0]!.sessionId, "ses_r");
    assert.equal(s.attaches[0]!.type, "PDF");
    assert.equal(s.attaches[1]!.type, "SCREENSHOT");
    assert.equal(s.pushes.length, 1);
    const push = s.pushes[0]!;
    assert.equal(push.kind, "report");
    assert.equal(push.attested, true, "the manifest is CLI-generated evidence");
    const header = parseSemanticHeader(String(push.body));
    assert.equal(headerString(header, "kind"), "output-manifest");
    assert.equal(headerNumber(header, "count"), 2);
    assert.equal(headerNumber(header, "uploaded"), 2);
    assert.equal(headerString(header, "revision"), "abc123abc123");
    const entries = header!.entries as Array<Record<string, unknown>>;
    assert.equal(entries[0]!.path, "report.pdf");
    assert.equal(entries[0]!.checksum, createHash("sha256").update(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0xfe])).digest("hex"));
    assert.equal(entries[0]!.artifactId, "art_1");
    assert.equal(entries[1]!.artifactId, "art_2");
    assert.match(String(push.body), /\| `shot\.png` \| image\/png \| 6 \|/);
    assert.match(s.out.join("\n"), /registered report\.pdf → artifact art_1 \(PDF, 8 bytes/);
    assert.match(s.out.join("\n"), /Pushed report → artifact art_manifest/);
  });

  it("refuses a missing path BEFORE uploading anything, and refuses more than the bound", async () => {
    const s = scene();
    assert.equal(await runArtifactRegister({ paths: "report.pdf,nope.bin" }, s.deps), 2);
    assert.match(s.err.join("\n"), /nope\.bin is not a readable file/);
    assert.equal(s.grants.length, 0);
    const many = Array.from({ length: MAX_MANIFEST_ENTRIES + 1 }, (_, i) => `f${i}.txt`).join(",");
    assert.equal(await runArtifactRegister({ paths: many }, s.deps), 2);
    assert.match(s.err.join("\n"), /bounded at 50/);
    assert.equal(await runArtifactRegister({ paths: "" }, s.deps), 2);
  });

  it("a failed upload is RECORDED in the manifest as failed (never dropped) and the command exits non-zero", async () => {
    const s = scene({ failPut: (f) => f === "shot.png" });
    const code = await runArtifactRegister({ paths: "report.pdf,shot.png" }, s.deps);
    assert.notEqual(code, 0);
    const header = parseSemanticHeader(String(s.pushes[0]!.body));
    assert.equal(headerNumber(header, "uploaded"), 1);
    assert.equal(headerNumber(header, "failed"), 1);
    const entries = header!.entries as Array<Record<string, unknown>>;
    assert.equal(entries[1]!.uploadStatus, "failed");
    assert.match(String(entries[1]!.error), /upload failed \(HTTP 500\)/);
    assert.match(String(s.pushes[0]!.body), /1 declared output\(s\) did NOT upload/);
    assert.match(s.err.join("\n"), /shot\.png did NOT upload/);
  });

  it("--session alone reads the session's aligned task from the server and places the uploads there", async () => {
    const s = scene();
    assert.equal(await runArtifactRegister({ paths: "shot.png", session: "ses_x" }, s.deps), 0);
    assert.equal(s.attaches[0]!.taskId, "task_from_session");
    assert.equal(s.attaches[0]!.sessionId, "ses_x");
    const header = parseSemanticHeader(String(s.pushes[0]!.body));
    assert.equal(headerString(header, "sessionId"), "ses_x");
    assert.equal(headerString(header, "taskId"), "task_from_session");
  });

  it("parsePaths de-duplicates and renderManifest keeps the header first", () => {
    assert.deepEqual(parsePaths(" a.txt, b.txt,a.txt\nc.txt,, "), ["a.txt", "b.txt", "c.txt"]);
    const body = renderManifest({ entries: [], sessionId: null, taskId: "t", revision: null, dirtyDigest: null, generatedAt: "2026-09-12T00:00:00.000Z" });
    assert.match(body, /^```jentrix\nschema: 1\nkind: output-manifest\n/);
  });
});
