import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { buildToolFlags } from "../src/commands/flags";
import { loadSurface } from "../src/surface";

/**
 * Whole-manifest round-trip property test (stage C2.1 test 3): every tool in
 * the REAL surface.json maps without throwing, with structural invariants
 * that must hold for C2.2 to mount the descriptors on commander safely.
 */
const manifest = loadSurface(
  readFileSync(new URL("../surface.json", import.meta.url), "utf8"),
);

const PRIMARY_ROLES = new Set(["value", "json"]);

describe("flags — whole-manifest sweep", () => {
  it("covers the full checked-in surface", () => {
    assert.ok(
      manifest.tools.length >= 50,
      "expected the product tool surface",
    );
    assert.equal(manifest.tools.length, manifest.generatedForToolCount);
  });

  it("buildToolFlags succeeds for every tool with zero warnings", () => {
    for (const tool of manifest.tools) {
      const { warnings } = buildToolFlags(tool); // must not throw
      assert.deepEqual(
        warnings,
        [],
        `${tool.name}: the real surface should map without degradation warnings — ` +
          `a new schema construct needs an explicit mapping rule (or a deliberate ` +
          `acknowledgement here)`,
      );
    }
  });

  it("every schema property yields exactly one primary descriptor; names and optionKeys are unique per tool", () => {
    for (const tool of manifest.tools) {
      const { descriptors } = buildToolFlags(tool);
      const properties = Object.keys(
        (tool.inputSchema.properties as Record<string, unknown> | undefined) ??
          {},
      );
      for (const property of properties) {
        const group = descriptors.filter((d) => d.property === property);
        assert.ok(group.length >= 1, `${tool.name}.${property}: no flag`);
        const primaries = group.filter((d) => PRIMARY_ROLES.has(d.role));
        assert.equal(
          primaries.length,
          1,
          `${tool.name}.${property}: expected exactly one primary (value|json) descriptor, got ${primaries.length}`,
        );
      }
      const names = descriptors.map((d) => d.name);
      assert.equal(
        new Set(names).size,
        names.length,
        `${tool.name}: duplicate flag names: ${names.join(", ")}`,
      );
      const keys = descriptors.map((d) => d.optionKey);
      assert.equal(
        new Set(keys).size,
        keys.length,
        `${tool.name}: duplicate optionKeys: ${keys.join(", ")}`,
      );
    }
  });

  it("every required schema prop yields exactly one required (primary) descriptor", () => {
    for (const tool of manifest.tools) {
      const { descriptors } = buildToolFlags(tool);
      const schema = tool.inputSchema;
      const properties =
        (schema.properties as Record<string, unknown> | undefined) ?? {};
      const required = new Set(
        Array.isArray(schema.required)
          ? (schema.required as unknown[]).filter(
              (r): r is string => typeof r === "string",
            )
          : [],
      );
      for (const property of Object.keys(properties)) {
        const group = descriptors.filter((d) => d.property === property);
        const primary = group.find((d) => PRIMARY_ROLES.has(d.role));
        assert.ok(primary, `${tool.name}.${property}: no primary descriptor`);
        if (required.has(property)) {
          assert.ok(
            group.every((d) => d.propertyRequired),
            `${tool.name}.${property}: required prop not marked propertyRequired`,
          );
          // single-flag groups are commander-mandatory; multi-flag groups
          // (required nullable / required JSON) defer to argsFromFlagValues
          assert.equal(
            primary.required,
            group.length === 1,
            `${tool.name}.${property}: commander-level required must equal "group has one flag"`,
          );
        } else {
          assert.ok(
            group.every((d) => !d.propertyRequired && !d.required),
            `${tool.name}.${property}: optional prop marked required`,
          );
        }
      }
    }
  });

  it("a REQUIRED nullable field maps to a value/clear pair", () => {
    // The SVR focus question "is --clear-foo on a REQUIRED nullable field
    // representable?" — frozen here on a synthetic schema: the PRODUCT
    // surface (v2 D8) currently has no scalar required-nullable field
    // (link_contact, the old real instance, is platform-only now).
    const tool = {
      name: "synthetic_link",
      description: "synthetic required-nullable fixture",
      toolClass: "write" as const,
      annotations: {},
      inputSchema: {
        type: "object",
        properties: {
          contactId: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
        required: ["contactId"],
      } as Record<string, unknown>,
    };
    const group = buildToolFlags(tool).descriptors.filter(
      (d) => d.property === "contactId",
    );
    assert.deepEqual(
      group.map((d) => [d.role, d.name, d.required, d.propertyRequired]),
      [
        ["value", "contact-id", false, true],
        ["clear", "clear-contact-id", false, true],
      ],
    );
  });
});
