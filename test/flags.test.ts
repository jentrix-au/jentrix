import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FlagCoercionError,
  FlagUsageError,
  argsFromFlagValues,
  buildToolFlags,
  isFlagError,
  parseJsonFlagValue,
  type FlagDescriptor,
} from "../src/commands/flags";

// ---------------------------------------------------------------------------
// Helpers — synthetic tools mirroring real surface.json shapes (each shape
// cited in the case that uses it).
// ---------------------------------------------------------------------------

function toolWith(
  properties: Record<string, unknown>,
  required: string[] = [],
) {
  return {
    name: "test_tool",
    inputSchema: { type: "object", properties, required },
  };
}

function only(
  descriptors: readonly FlagDescriptor[],
  property: string,
): FlagDescriptor[] {
  return descriptors.filter((d) => d.property === property);
}

const NULLABLE_STRING = {
  anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
  description: "New due date, or null to clear.",
};

// ---------------------------------------------------------------------------
// Mapping rules (design.md Phase 2 / stage file) — one named case per rule.
// ---------------------------------------------------------------------------

describe("flags — mapping rules", () => {
  it("string → `--foo <v>` (optional, no coercion)", () => {
    const { descriptors, warnings } = buildToolFlags(
      toolWith({ boardId: { type: "string", description: "Board id." } }),
    );
    assert.equal(warnings.length, 0);
    assert.equal(descriptors.length, 1);
    const [d] = descriptors;
    assert.equal(d.flag, "--board-id <value>");
    assert.equal(d.name, "board-id");
    assert.equal(d.optionKey, "boardId");
    assert.equal(d.role, "value");
    assert.equal(d.required, false);
    assert.equal(d.takesValue, true);
    assert.equal(d.coerce, undefined);
  });

  it("required schema props → required flags", () => {
    const { descriptors } = buildToolFlags(
      toolWith({ taskId: { type: "string" } }, ["taskId"]),
    );
    assert.equal(descriptors[0].required, true);
    assert.equal(descriptors[0].propertyRequired, true);
    // and the inverse enforces it too
    assert.throws(
      () => argsFromFlagValues(descriptors, {}),
      (e: unknown) =>
        e instanceof FlagUsageError &&
        e.message === "missing required flag --task-id",
    );
  });

  it("number → coerced with validation (failure = usage error, exit-2 semantics)", () => {
    const { descriptors } = buildToolFlags(
      toolWith({ amount: { type: "number" } }),
    );
    const [d] = descriptors;
    assert.equal(d.flag, "--amount <number>");
    assert.equal(d.coerce!("1.5"), 1.5);
    assert.equal(d.coerce!("-3"), -3);
    const failures = ["abc", "", "  ", "1.5x", "NaN", "Infinity"];
    for (const raw of failures) {
      assert.throws(
        () => d.coerce!(raw),
        (e: unknown) =>
          e instanceof FlagCoercionError &&
          e.message ===
            `--amount expects a number, got ${JSON.stringify(raw)}` &&
          e.exitCode === 2 &&
          isFlagError(e),
        `expected usage-style rejection for ${JSON.stringify(raw)}`,
      );
    }
  });

  it("integer → coerced with integer validation", () => {
    const { descriptors } = buildToolFlags(
      toolWith({ take: { type: "integer", minimum: 1, maximum: 100 } }),
    );
    const [d] = descriptors;
    assert.equal(d.flag, "--take <int>");
    assert.equal(d.coerce!("42"), 42);
    for (const raw of ["4.2", "abc", ""]) {
      assert.throws(
        () => d.coerce!(raw),
        (e: unknown) =>
          e instanceof FlagCoercionError &&
          e.message === `--take expects an integer, got ${JSON.stringify(raw)}`,
      );
    }
  });

  it("boolean → `--foo` / `--no-foo` (negatable, takes no value)", () => {
    const { descriptors } = buildToolFlags(
      toolWith({
        includeArchived: { type: "boolean", description: "Include archived." },
      }),
    );
    const [d] = descriptors;
    assert.equal(d.flag, "--include-archived");
    assert.equal(d.takesValue, false);
    assert.equal(d.negatable, true);
    assert.ok(d.helpText.includes("--no-include-archived sets false"));
    // inverse: true, false, and absent all round-trip correctly
    assert.deepEqual(
      argsFromFlagValues(descriptors, { includeArchived: true }),
      {
        includeArchived: true,
      },
    );
    assert.deepEqual(
      argsFromFlagValues(descriptors, { includeArchived: false }),
      { includeArchived: false },
    );
    assert.deepEqual(argsFromFlagValues(descriptors, {}), {});
  });

  it("enum → choices in help + validation with a rejection message listing them", () => {
    const { descriptors } = buildToolFlags(
      toolWith({
        priority: {
          type: "string",
          enum: ["LOW", "MEDIUM", "HIGH", "URGENT"],
          description: "New priority.",
        },
      }),
    );
    const [d] = descriptors;
    assert.equal(d.flag, "--priority <choice>");
    assert.deepEqual(d.choices, ["LOW", "MEDIUM", "HIGH", "URGENT"]);
    assert.equal(
      d.helpText,
      "New priority. (choices: LOW, MEDIUM, HIGH, URGENT)",
    );
    assert.equal(d.coerce!("HIGH"), "HIGH");
    assert.throws(
      () => d.coerce!("high"),
      (e: unknown) =>
        e instanceof FlagCoercionError &&
        e.message ===
          '--priority must be one of: LOW, MEDIUM, HIGH, URGENT (got "high")',
    );
  });

  it("array of primitives → repeatable flag (coercion accumulates)", () => {
    const { descriptors } = buildToolFlags(
      toolWith({
        labelIds: {
          type: "array",
          items: { type: "string", minLength: 1 },
          description: "Label ids.",
        },
      }),
    );
    const [d] = descriptors;
    assert.equal(d.repeatable, true);
    assert.equal(d.flag, "--label-ids <value>");
    assert.ok(d.helpText.includes("repeatable"));
    assert.deepEqual(d.coerce!("a", undefined), ["a"]);
    assert.deepEqual(d.coerce!("b", ["a"]), ["a", "b"]);
  });

  it("array of enums → repeatable with per-item validation (create_webhook.events shape)", () => {
    const { descriptors } = buildToolFlags(
      toolWith({
        events: {
          type: "array",
          items: { type: "string", enum: ["task.created", "task.updated"] },
        },
      }),
    );
    const [d] = descriptors;
    assert.deepEqual(d.choices, ["task.created", "task.updated"]);
    assert.deepEqual(d.coerce!("task.created", undefined), ["task.created"]);
    assert.throws(
      () => d.coerce!("nope", undefined),
      (e: unknown) => e instanceof FlagCoercionError,
    );
  });

  it("nullable anyOf:[T, null] → `--foo <v>` + paired `--clear-foo` sending null", () => {
    const { descriptors } = buildToolFlags(
      toolWith({ dueAt: NULLABLE_STRING }),
    );
    assert.equal(descriptors.length, 2);
    const [value, clear] = descriptors;
    assert.equal(value.role, "value");
    assert.equal(value.flag, "--due-at <value>");
    assert.equal(value.description, "New due date, or null to clear.");
    assert.ok(value.helpText.includes("--clear-due-at sends null"));
    assert.equal(clear.role, "clear");
    assert.equal(clear.flag, "--clear-due-at");
    assert.equal(clear.takesValue, false);
    assert.equal(clear.optionKey, "clearDueAt");
    // inverse: value passes through, clear sends null
    assert.deepEqual(
      argsFromFlagValues(descriptors, { dueAt: "2026-12-31T17:00:00Z" }),
      { dueAt: "2026-12-31T17:00:00Z" },
    );
    assert.deepEqual(argsFromFlagValues(descriptors, { clearDueAt: true }), {
      dueAt: null,
    });
  });

  it("nullable enum keeps its choices on the value flag (update_ticket.severity shape)", () => {
    const { descriptors } = buildToolFlags(
      toolWith({
        severity: {
          anyOf: [
            { type: "string", enum: ["LOW", "NORMAL", "HIGH", "URGENT"] },
            { type: "null" },
          ],
          description: "New severity, or null to clear.",
        },
      }),
    );
    const [value, clear] = descriptors;
    assert.deepEqual(value.choices, ["LOW", "NORMAL", "HIGH", "URGENT"]);
    assert.equal(clear.role, "clear");
    assert.equal(value.coerce!("LOW"), "LOW");
  });

  it("`--foo` + `--clear-foo` are mutually exclusive at parse time", () => {
    const { descriptors } = buildToolFlags(
      toolWith({ dueAt: NULLABLE_STRING }),
    );
    assert.throws(
      () =>
        argsFromFlagValues(descriptors, {
          dueAt: "2026-12-31T17:00:00Z",
          clearDueAt: true,
        }),
      (e: unknown) =>
        e instanceof FlagUsageError &&
        e.message === "use only one of --due-at, --clear-due-at",
    );
  });

  it("REQUIRED nullable (link_contact.contactId shape) → exactly one of value/clear demanded", () => {
    const { descriptors } = buildToolFlags(
      toolWith({ contactId: NULLABLE_STRING }, ["contactId"]),
    );
    // neither flag is commander-mandatory (the requirement is a disjunction)
    assert.ok(descriptors.every((d) => d.required === false));
    assert.ok(descriptors.every((d) => d.propertyRequired === true));
    assert.throws(
      () => argsFromFlagValues(descriptors, {}),
      (e: unknown) =>
        e instanceof FlagUsageError &&
        e.message ===
          "one of --contact-id / --clear-contact-id is required (contactId)",
    );
    assert.deepEqual(
      argsFromFlagValues(descriptors, { clearContactId: true }),
      {
        contactId: null,
      },
    );
    assert.deepEqual(argsFromFlagValues(descriptors, { contactId: "c1" }), {
      contactId: "c1",
    });
  });

  it("anyOf of string-free primitives → deterministic in-schema-order coercion", () => {
    const { descriptors, warnings } = buildToolFlags(
      toolWith({
        limit: { anyOf: [{ type: "integer" }, { type: "boolean" }] },
      }),
    );
    assert.equal(warnings.length, 0);
    const [d] = descriptors;
    assert.equal(d.role, "value");
    assert.ok(
      d.helpText.includes(
        "accepts an integer, then true/false — first match wins",
      ),
      `help documents branch order: ${d.helpText}`,
    );
    assert.equal(d.coerce!("5"), 5);
    assert.equal(d.coerce!("true"), true);
    assert.throws(
      () => d.coerce!("x"),
      (e: unknown) =>
        e instanceof FlagCoercionError &&
        e.message === '--limit expects an integer or true/false, got "x"',
    );
  });

  it("anyOf with a string branch is ambiguous → `--foo-json` fallback", () => {
    // A numeric-looking raw value must never silently bind to the wrong
    // branch — a bare string can't say whether "5" means 5 or "5".
    const { descriptors, warnings } = buildToolFlags(
      toolWith({ ref: { anyOf: [{ type: "string" }, { type: "integer" }] } }),
    );
    assert.equal(warnings.length, 0, "a defined degradation, not a warning");
    assert.deepEqual(
      descriptors.map((d) => d.role),
      ["json", "json-file"],
    );
    assert.equal(descriptors[0].flag, "--ref-json <json>");
    // json mode makes the branch explicit: 5 vs "5"
    assert.equal(descriptors[0].coerce!("5"), 5);
    assert.equal(descriptors[0].coerce!('"5"'), "5");
  });

  it("anyOf/oneOf of objects → `--foo-json` fallback (create_automation.trigger shape)", () => {
    const { descriptors } = buildToolFlags(
      toolWith({
        trigger: {
          oneOf: [
            {
              type: "object",
              properties: { type: { const: "task.created", type: "string" } },
              required: ["type"],
            },
            {
              type: "object",
              properties: { type: { const: "label.added", type: "string" } },
              required: ["type"],
            },
          ],
        },
      }),
    );
    assert.deepEqual(
      descriptors.map((d) => d.role),
      ["json", "json-file"],
    );
  });

  it("arrays of objects / object literals → `--foo-json` / `--foo-file` only (no flag explosion)", () => {
    const { descriptors, warnings } = buildToolFlags(
      toolWith(
        {
          tasks: {
            type: "array",
            items: {
              type: "object",
              properties: { title: { type: "string" } },
            },
            description: "Tasks to create, in order (max 50).",
          },
          conditions: { type: "object", properties: {}, default: {} },
        },
        ["tasks"],
      ),
    );
    assert.equal(warnings.length, 0);
    const tasks = only(descriptors, "tasks");
    assert.equal(tasks.length, 2, "exactly json + file — no per-field flags");
    assert.deepEqual(
      tasks.map((d) => d.flag),
      ["--tasks-json <json>", "--tasks-file <file>"],
    );
    assert.equal(tasks[0].jsonTop, "array");
    assert.equal(tasks[0].description, "Tasks to create, in order (max 50).");
    // top-level JSON type is validated
    assert.deepEqual(tasks[0].coerce!('[{"title":"a"}]'), [{ title: "a" }]);
    assert.throws(
      () => tasks[0].coerce!('{"title":"a"}'),
      (e: unknown) =>
        e instanceof FlagCoercionError &&
        e.message === "--tasks-json expects a JSON array, got an object",
    );
    assert.throws(
      () => tasks[0].coerce!("not json"),
      (e: unknown) =>
        e instanceof FlagCoercionError &&
        e.message.startsWith("--tasks-json is not valid JSON:"),
    );
    const conditions = only(descriptors, "conditions");
    assert.equal(conditions[0].jsonTop, "object");
    assert.throws(
      () => conditions[0].coerce!("[1]"),
      (e: unknown) =>
        e instanceof FlagCoercionError &&
        e.message === "--conditions-json expects a JSON object, got an array",
    );
    // required JSON property: neither flag commander-mandatory, group enforced
    assert.ok(tasks.every((d) => d.required === false));
    assert.throws(
      () => argsFromFlagValues(descriptors, {}),
      (e: unknown) =>
        e instanceof FlagUsageError &&
        e.message === "one of --tasks-json / --tasks-file is required (tasks)",
    );
  });

  it("`--foo-file` reads through the injected reader; json/file are mutually exclusive", () => {
    const { descriptors } = buildToolFlags(
      toolWith({ tasks: { type: "array", items: { type: "object" } } }),
    );
    const readFile = (path: string) => {
      assert.equal(path, "payload.json");
      return '[{"title":"from file"}]';
    };
    assert.deepEqual(
      argsFromFlagValues(
        descriptors,
        { tasksFile: "payload.json" },
        { readFile },
      ),
      { tasks: [{ title: "from file" }] },
    );
    // unreadable file → usage error, not a stack dump
    assert.throws(
      () =>
        argsFromFlagValues(
          descriptors,
          { tasksFile: "missing.json" },
          {
            readFile: () => {
              throw new Error("ENOENT: no such file");
            },
          },
        ),
      (e: unknown) =>
        e instanceof FlagUsageError &&
        e.message ===
          "cannot read --tasks-file missing.json: ENOENT: no such file",
    );
    // file content validated like inline JSON
    assert.throws(
      () =>
        argsFromFlagValues(
          descriptors,
          { tasksFile: "bad.json" },
          { readFile: () => "{}" },
        ),
      (e: unknown) =>
        e instanceof FlagCoercionError &&
        e.message ===
          "--tasks-file bad.json expects a JSON array, got an object",
    );
    // no reader wired → explicit internal-usage error
    assert.throws(
      () => argsFromFlagValues(descriptors, { tasksFile: "x.json" }),
      (e: unknown) => e instanceof FlagUsageError,
    );
    // mutual exclusion
    assert.throws(
      () =>
        argsFromFlagValues(
          descriptors,
          { tasksJson: [], tasksFile: "x.json" },
          { readFile: () => "[]" },
        ),
      (e: unknown) =>
        e instanceof FlagUsageError &&
        e.message === "use only one of --tasks-json, --tasks-file",
    );
  });

  it("nullable object → json fallback + `--clear-foo` (update_initiative.rice shape)", () => {
    const { descriptors } = buildToolFlags(
      toolWith({
        rice: {
          anyOf: [{ type: "object", properties: {} }, { type: "null" }],
          description: "RICE score, or null to clear.",
        },
      }),
    );
    assert.deepEqual(
      descriptors.map((d) => d.role),
      ["json", "json-file", "clear"],
    );
    assert.deepEqual(argsFromFlagValues(descriptors, { clearRice: true }), {
      rice: null,
    });
    assert.throws(
      () => argsFromFlagValues(descriptors, { riceJson: {}, clearRice: true }),
      (e: unknown) => e instanceof FlagUsageError,
    );
  });

  it("unknown/unsupported constructs degrade to `--foo-json` + warning, never throw", () => {
    const { descriptors, warnings } = buildToolFlags(
      toolWith({
        typeless: { description: "no type at all" },
        weird: { type: "banana" },
      }),
    );
    assert.deepEqual(
      descriptors.map((d) => `${d.property}:${d.role}`),
      ["typeless:json", "typeless:json-file", "weird:json", "weird:json-file"],
    );
    assert.equal(warnings.length, 2);
    assert.ok(
      warnings[0].includes("test_tool.typeless") &&
        warnings[0].includes("degraded to JSON mode"),
      warnings[0],
    );
    assert.ok(warnings[1].includes('type: "banana"'), warnings[1]);
    // json-any mode accepts any JSON value
    assert.equal(descriptors[0].coerce!("5"), 5);
    assert.deepEqual(descriptors[0].coerce!("[1]"), [1]);
  });

  it("kebab-case collisions get a deterministic suffix + warning", () => {
    const { descriptors, warnings } = buildToolFlags(
      toolWith({
        boardId: { type: "string" },
        board_id: { type: "string" },
      }),
    );
    assert.deepEqual(
      descriptors.map((d) => d.flag),
      ["--board-id <value>", "--board-id-2 <value>"],
    );
    assert.equal(descriptors[1].optionKey, "boardId2");
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes("renamed to --board-id-2"), warnings[0]);
  });

  it("derived-name collisions (--clear-*/--no-*) are handled the same way", () => {
    const { descriptors, warnings } = buildToolFlags(
      toolWith({
        foo: NULLABLE_STRING, // claims --foo and --clear-foo
        clearFoo: { type: "string" }, // would also kebab to --clear-foo
        wait: { type: "boolean" }, // reserves --no-wait
        noWait: { type: "string" }, // would collide with the reserved name
      }),
    );
    const flags = descriptors.map((d) => d.name);
    assert.deepEqual(flags, [
      "foo",
      "clear-foo",
      "clear-foo-2",
      "wait",
      "no-wait-2",
    ]);
    assert.equal(warnings.length, 2);
  });

  it("optionKey collisions are deduped too (commander stores by camelCase key)", () => {
    // [C2.1-R1-1]: `foo2` and `foo_2` map to DIFFERENT kebab names (--foo2 /
    // --foo-2) but the SAME commander optionKey (foo2) — one flag would
    // silently populate both args. The allocator claims keys as well.
    const { descriptors, warnings } = buildToolFlags(
      toolWith({
        foo2: { type: "string" },
        foo_2: { type: "string" },
      }),
    );
    assert.deepEqual(
      descriptors.map((d) => [d.name, d.optionKey]),
      [
        ["foo2", "foo2"],
        ["foo-2-2", "foo22"],
      ],
    );
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes("renamed to --foo-2-2"), warnings[0]);
    assert.deepEqual(
      argsFromFlagValues(descriptors, { foo2: "X" }),
      { foo2: "X" },
      "one flag must populate exactly one arg",
    );
    assert.deepEqual(argsFromFlagValues(descriptors, { foo22: "Y" }), {
      foo_2: "Y",
    });
  });

  it("descriptions come verbatim from the schema", () => {
    const description =
      "Optimistic concurrency guard: the entity's updatedAt from your last read.";
    const { descriptors } = buildToolFlags(
      toolWith({ expectedUpdatedAt: { type: "string", description } }),
    );
    assert.equal(descriptors[0].description, description);
    assert.equal(descriptors[0].helpText, description);
  });

  it("tools without properties map to zero descriptors", () => {
    const { descriptors, warnings } = buildToolFlags({
      name: "list_workspaces",
      inputSchema: { type: "object" },
    });
    assert.deepEqual(descriptors, []);
    assert.deepEqual(warnings, []);
  });

  it("inverse ignores option keys no descriptor owns (cross-cutting flags)", () => {
    const { descriptors } = buildToolFlags(
      toolWith({ taskId: { type: "string" } }),
    );
    assert.deepEqual(
      argsFromFlagValues(descriptors, {
        taskId: "t1",
        json: true,
        url: "http://x",
        maxWait: "60",
      }),
      { taskId: "t1" },
    );
  });

  it("parseJsonFlagValue is exported with usage-style errors for C2.2 reuse", () => {
    assert.deepEqual(parseJsonFlagValue("--x-json", '{"a":1}', "object"), {
      a: 1,
    });
    assert.throws(
      () => parseJsonFlagValue("--x-json", "null", "object"),
      (e: unknown) =>
        e instanceof FlagCoercionError &&
        e.message === "--x-json expects a JSON object, got null",
    );
  });
});
