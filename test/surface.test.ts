import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { SurfaceError, TOOL_CLASSES, loadSurface } from "../src/surface";

const realManifestJson = readFileSync(
  new URL("../surface.json", import.meta.url),
  "utf8",
);

describe("loadSurface — real checked-in manifest", () => {
  const manifest = loadSurface(realManifestJson);

  it("loads every tool with a valid toolClass", () => {
    assert.ok(
      manifest.tools.length >= 50,
      "expected the product tool surface",
    );
    assert.equal(manifest.generatedForToolCount, manifest.tools.length);
    for (const tool of manifest.tools) {
      assert.ok(
        (TOOL_CLASSES as readonly string[]).includes(tool.toolClass),
        `tool ${tool.name} has invalid toolClass ${tool.toolClass}`,
      );
      assert.ok(tool.name.length > 0);
      assert.equal(typeof tool.description, "string");
      assert.equal(typeof tool.inputSchema, "object");
      assert.equal(typeof tool.annotations, "object");
    }
  });

  it("carries known tools with their P2.1 scope classes", () => {
    const byName = new Map(manifest.tools.map((t) => [t.name, t]));
    assert.equal(byName.get("get_task")?.toolClass, "read");
    assert.equal(byName.get("create_task")?.toolClass, "write");
    assert.equal(byName.get("set_member_role")?.toolClass, "admin");
  });
});

function withTools(tools: unknown[]): string {
  return JSON.stringify({ generatedForToolCount: tools.length, tools });
}

const validTool = {
  name: "list_widgets",
  description: "Lists widgets.",
  toolClass: "read",
  inputSchema: { type: "object" },
  annotations: { readOnlyHint: true },
};

describe("loadSurface — validation", () => {
  it("accepts a minimal valid manifest", () => {
    const manifest = loadSurface(withTools([validTool]));
    assert.equal(manifest.tools[0].name, "list_widgets");
  });

  it("rejects a manifest with a missing toolClass", () => {
    const { toolClass: _dropped, ...noClass } = validTool;
    assert.throws(
      () => loadSurface(withTools([noClass])),
      (e: unknown) =>
        e instanceof SurfaceError &&
        /list_widgets/.test(e.message) &&
        /toolClass/.test(e.message),
    );
  });

  it("rejects an invalid toolClass value", () => {
    assert.throws(
      () => loadSurface(withTools([{ ...validTool, toolClass: "root" }])),
      SurfaceError,
    );
  });

  it("rejects a count/tools.length mismatch (truncated manifest)", () => {
    const json = JSON.stringify({
      generatedForToolCount: 2,
      tools: [validTool],
    });
    assert.throws(() => loadSurface(json), /does not match tools.length/);
  });

  it("rejects duplicate tool names", () => {
    assert.throws(
      () => loadSurface(withTools([validTool, { ...validTool }])),
      /duplicate tool name/,
    );
  });

  it("rejects malformed roots and invalid JSON", () => {
    assert.throws(() => loadSurface("not json"), SurfaceError);
    assert.throws(() => loadSurface("[]"), SurfaceError);
    assert.throws(() => loadSurface('{"tools":{}}'), SurfaceError);
    assert.throws(
      () => loadSurface('{"generatedForToolCount":"1","tools":[]}'),
      SurfaceError,
    );
  });

  it("rejects tools missing name/description/inputSchema/annotations", () => {
    for (const field of [
      "name",
      "description",
      "inputSchema",
      "annotations",
    ] as const) {
      const { [field]: _dropped, ...partial } = validTool;
      assert.throws(
        () => loadSurface(withTools([partial])),
        SurfaceError,
        `expected rejection when ${field} is missing`,
      );
    }
  });
});
