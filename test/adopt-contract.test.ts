import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import {
  BUNDLE_NOTICE,
  SURFACE_NOTICE,
  digestOf,
  serialize,
} from "../scripts/adopt-contract.mjs";

// The adoption script (open-client S2 row 7): the ONLY writer of surface.json,
// contract-vectors.json and contract.json. A file source is adopted as-is; a
// manifest URL is adopted only when the bundle it names hashes to the digest
// it promises — a mismatch writes nothing and exits 1.

const SCRIPT = fileURLToPath(
  new URL("../scripts/adopt-contract.mjs", import.meta.url),
);

const BUNDLE = {
  _generated: BUNDLE_NOTICE,
  apiRelease: "1.2.3",
  generatedForToolCount: 1,
  surface: "mvp",
  tools: [
    {
      annotations: { readOnlyHint: true },
      description: "List things",
      inputSchema: { type: "object", properties: {} },
      name: "list_things",
      toolClass: "read",
    },
  ],
  vectors: {
    connectionKey: [],
    redaction: [
      {
        expected: "‹redacted›",
        input: "tm_0123456789abcdefTOKEN",
        name: "pat",
      },
    ],
  },
};
const BYTES = serialize(BUNDLE);
const DIGEST = digestOf(BYTES);

/**
 * Spawn the script ASYNCHRONOUSLY: the URL tests serve the manifest from this
 * very process, so a synchronous spawn would block the event loop that has to
 * answer the child's fetch.
 */
function run(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { encoding: "utf8", timeout: 30_000 },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

describe("adopt-contract — from a file", () => {
  it("writes the three projections and records the digest", async () => {
    const work = mkdtempSync(join(tmpdir(), "adopt-"));
    try {
      const file = join(work, "mvp.json");
      writeFileSync(file, BYTES);
      const out = join(work, "out");
      const result = await run([file, "--out", out]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(
        result.stdout,
        /Adopted mvp contract 1\.2\.3 \(digest [0-9a-f]{64}, 1 tools\)/,
      );
      const surface = JSON.parse(
        readFileSync(join(out, "surface.json"), "utf8"),
      );
      assert.equal(surface._generated, SURFACE_NOTICE);
      assert.equal(surface.generatedForToolCount, 1);
      assert.deepEqual(surface.tools, BUNDLE.tools);
      assert.deepEqual(
        JSON.parse(readFileSync(join(out, "contract-vectors.json"), "utf8")),
        BUNDLE.vectors,
      );
      assert.deepEqual(
        JSON.parse(readFileSync(join(out, "contract.json"), "utf8")),
        {
          surface: "mvp",
          apiRelease: "1.2.3",
          digest: DIGEST,
        },
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("refuses a bundle for another surface (D11)", async () => {
    const work = mkdtempSync(join(tmpdir(), "adopt-"));
    try {
      const file = join(work, "ops.json");
      writeFileSync(file, serialize({ ...BUNDLE, surface: "ops" }));
      const result = await run([file, "--out", join(work, "out")]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /SURFACE_REFUSED/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("usage without a source is exit 2", async () => {
    assert.equal((await run([])).code, 2);
  });
});

describe("adopt-contract — from a manifest URL", () => {
  // One tiny server, two manifests: an honest one and one whose digest lies.
  let origin = "";
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", origin);
    const manifest = (digest: string) => ({
      surface: "mvp",
      apiRelease: "1.2.3",
      digest,
      publicationState: "preview",
      supportedReleases: ["1.x"],
      bundleUrl: `${origin}/api/mcp/contract/bundle`,
    });
    if (url.pathname === "/api/mcp/contract") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(manifest(DIGEST)));
    } else if (url.pathname === "/lying/api/mcp/contract") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(manifest("0".repeat(64))));
    } else if (url.pathname === "/api/mcp/contract/bundle") {
      res.setHeader("content-type", "application/json");
      res.end(BYTES);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  before(async () => {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });
  after(() => server.close());

  it("adopts when the bundle hashes to the promised digest", async () => {
    const work = mkdtempSync(join(tmpdir(), "adopt-"));
    try {
      const result = await run([`${origin}/api/mcp/contract`, "--out", work]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /preview/);
      assert.equal(
        JSON.parse(readFileSync(join(work, "contract.json"), "utf8")).digest,
        DIGEST,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("refuses, and writes nothing, when the manifest's digest does not match the bundle", async () => {
    const work = mkdtempSync(join(tmpdir(), "adopt-"));
    try {
      const result = await run([
        `${origin}/lying/api/mcp/contract`,
        "--out",
        join(work, "out"),
      ]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /DIGEST_MISMATCH/);
      assert.equal(existsSync(join(work, "out", "contract.json")), false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
