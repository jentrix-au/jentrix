/**
 * Schema→flags mapper (Stage C2.1; design.md Phase 2 — those rules are the
 * contract, and each has a named test in test/flags.test.ts).
 *
 * PURE data-in/data-out: a tool's JSON-Schema input properties → flag
 * DESCRIPTORS (name, requiredness, coercion fn, help text) plus the inverse
 * (`argsFromFlagValues`: parsed flag values → the tool-args object). It never
 * touches a live commander program — C2.2 consumes the descriptors — and is
 * deliberately commander-free.
 *
 * PROPERTY → FLAG-GROUP MAPPING (one property yields 1–3 descriptors):
 * - string             → `--foo <value>`
 * - number / integer   → `--foo <number|int>` with validating coercion
 * - boolean            → `--foo` (negatable: C2.2 also mounts `--no-foo`)
 * - enum / const       → `--foo <choice>`, choices in help + validation
 * - array of primitives → repeatable `--foo <v>` (coercion accumulates)
 * - nullable (`anyOf: [T, null]` — the "pass null to clear" idiom) → T's
 *   flag(s) plus a paired `--clear-foo` that sends null; mutually exclusive,
 *   enforced by `argsFromFlagValues`
 * - other `anyOf`/`oneOf` → a union whose branches are ALL primitive and
 *   string-free coerces by trying each branch IN SCHEMA ORDER; the first
 *   branch that coerces wins (deterministic — the order is echoed in the
 *   help text). A union containing a string branch is AMBIGUOUS (a bare flag
 *   value can't say which branch is meant — is "5" the string or the
 *   number?) and degrades to JSON mode, as does any union with a
 *   non-primitive branch.
 * - arrays of objects / object literals → JSON mode only. No flag explosion.
 * - anything unknown/unsupported → JSON mode + a build-time warning in
 *   `ToolFlags.warnings`. `buildToolFlags` NEVER throws.
 *
 * JSON mode = `--foo-json '<json>'` plus `--foo-file <file>` ("-" = stdin);
 * mutually exclusive. File/stdin reading is a process edge, so it is
 * injected into `argsFromFlagValues` via `options.readFile`.
 *
 * REQUIREDNESS: a required property whose group has exactly ONE flag is
 * commander-mandatory (`required: true`). Required multi-flag groups — a
 * required nullable (link_contact.contactId) or a required JSON property
 * (bulk_create_tasks.tasks) — cannot be a single mandatory option, so every
 * descriptor carries `propertyRequired` and `argsFromFlagValues` enforces
 * "exactly one flag of the group was given".
 *
 * DEFAULTS: schema `default` values are never baked into descriptors — the
 * server applies its own defaults; the CLI only sends what was explicitly
 * flagged.
 *
 * Descriptions are VERBATIM from the schema (`.describe()` strings are
 * already agent-grade help); `helpText` appends structural hints (choices,
 * repeatable, null/JSON pairing) in parentheses.
 */

import { EXIT_CODES } from "../errors";
import type { SurfaceTool } from "../surface";

// ---------------------------------------------------------------------------
// Errors — both are usage problems (exit 2 semantics). Consumers print
// `.message` as-is; these never surface as stack traces.
// ---------------------------------------------------------------------------

/** A single flag VALUE failed coercion/validation. */
export class FlagCoercionError extends Error {
  readonly exitCode = EXIT_CODES.INVALID_INPUT;
  constructor(message: string) {
    super(message);
    this.name = "FlagCoercionError";
  }
}

/** A flag COMBINATION is invalid (mutual exclusion, missing required). */
export class FlagUsageError extends Error {
  readonly exitCode = EXIT_CODES.INVALID_INPUT;
  constructor(message: string) {
    super(message);
    this.name = "FlagUsageError";
  }
}

/** True for both mapper error kinds — the C2.2 catch-and-exit-2 seam. */
export function isFlagError(
  e: unknown,
): e is FlagCoercionError | FlagUsageError {
  return e instanceof FlagCoercionError || e instanceof FlagUsageError;
}

// ---------------------------------------------------------------------------
// Descriptor shape
// ---------------------------------------------------------------------------

/**
 * Role within a property's flag group: `value` carries the typed value,
 * `clear` sends null (nullable properties), `json`/`json-file` are the
 * structured fallback pair.
 */
export type FlagRole = "value" | "clear" | "json" | "json-file";

/** Expected top-level JSON type for `json`/`json-file` flags. */
export type JsonTop = "object" | "array";

export interface FlagDescriptor {
  /** Schema property this flag feeds (a group shares one property). */
  property: string;
  role: FlagRole;
  /** Long flag name without leading dashes, e.g. `board-id`. */
  name: string;
  /** Full commander-style definition, e.g. `--board-id <value>`. */
  flag: string;
  /** camelCase key commander stores the parsed value under. */
  optionKey: string;
  /** Commander-level mandatory — single-flag groups only (see header). */
  required: boolean;
  /** The schema property is in `required` (group-level; see header). */
  propertyRequired: boolean;
  /** The property's schema `description`, verbatim ("" when absent). */
  description: string;
  /** `description` + composed hints — what C2.2 mounts as option help. */
  helpText: string;
  /** Enum choices, stringified for help + matching. */
  choices?: readonly string[];
  /** Repeatable flag — the coercion accumulates values into an array. */
  repeatable: boolean;
  /** False for boolean `--foo` and for `--clear-foo`. */
  takesValue: boolean;
  /** Boolean property: C2.2 mounts `--foo` AND `--no-foo`. */
  negatable: boolean;
  /** JSON mode: expected top-level JSON type (absent = any JSON). */
  jsonTop?: JsonTop;
  /**
   * Value coercion, commander argParser-compatible
   * (`(raw, previous) => value`). Throws `FlagCoercionError` with a
   * usage-style message on bad input. Absent for plain strings/booleans.
   */
  coerce?: (raw: string, previous?: unknown) => unknown;
}

export interface ToolFlags {
  toolName: string;
  descriptors: FlagDescriptor[];
  /**
   * Build-time degradations (unknown constructs) and flag-name collisions.
   * Surfaced, never thrown — C2.2 snapshots these.
   */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Schema classification
// ---------------------------------------------------------------------------

type Primitive =
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "integer" }
  | { kind: "boolean" }
  | { kind: "enum"; values: readonly unknown[] };

type Classified =
  | Primitive
  | { kind: "array"; items: Primitive }
  | { kind: "union"; branches: Primitive[] }
  | { kind: "json"; top?: JsonTop };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPrimitive(c: Classified): c is Primitive {
  return (
    c.kind === "string" ||
    c.kind === "number" ||
    c.kind === "integer" ||
    c.kind === "boolean" ||
    c.kind === "enum"
  );
}

function branchesOf(schema: Record<string, unknown>): unknown[] | null {
  if (Array.isArray(schema.anyOf)) return schema.anyOf;
  if (Array.isArray(schema.oneOf)) return schema.oneOf;
  return null;
}

/**
 * Classify a schema node into a flag strategy. Defined degradations (object
 * literals, string-bearing or non-primitive unions, arrays of objects) go to
 * JSON mode silently — they are rules, not surprises. Genuinely unknown
 * constructs also go to JSON mode but push a warning.
 */
function classify(
  schema: unknown,
  path: string,
  warnings: string[],
): Classified {
  if (!isRecord(schema)) {
    warnings.push(`${path}: schema is not an object — degraded to JSON mode`);
    return { kind: "json" };
  }
  if (Array.isArray(schema.enum)) return { kind: "enum", values: schema.enum };
  if (schema.const !== undefined) {
    return { kind: "enum", values: [schema.const] };
  }
  const branches = branchesOf(schema);
  if (branches) {
    // Null branches are consumed by the property-level nullable rule; a null
    // branch anywhere deeper has no flag encoding → JSON mode.
    if (branches.some((b) => isRecord(b) && b.type === "null")) {
      return { kind: "json" };
    }
    const classified = branches.map((b, i) =>
      classify(b, `${path}.anyOf[${i}]`, warnings),
    );
    if (classified.every(isPrimitive)) {
      if (classified.length === 1) return classified[0];
      // A string branch swallows every raw value (or is shadowed by earlier
      // branches) — the union is ambiguous from a bare flag string.
      if (classified.some((b) => b.kind === "string")) return { kind: "json" };
      return { kind: "union", branches: classified };
    }
    return { kind: "json" };
  }
  switch (schema.type) {
    case "string":
      return { kind: "string" };
    case "number":
      return { kind: "number" };
    case "integer":
      return { kind: "integer" };
    case "boolean":
      return { kind: "boolean" };
    case "object":
      return { kind: "json", top: "object" };
    case "array": {
      const items = classify(schema.items, `${path}.items`, warnings);
      if (isPrimitive(items)) return { kind: "array", items };
      return { kind: "json", top: "array" };
    }
    default:
      warnings.push(
        `${path}: unsupported schema construct (type: ${JSON.stringify(
          schema.type ?? null,
        )}) — degraded to JSON mode`,
      );
      return { kind: "json" };
  }
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** `boardId` → `board-id`, `response_format` → `response-format`. */
function kebabCase(name: string): string {
  return name
    .replace(/_/g, "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Commander's camelCase storage key: `board-id-2` → `boardId2`. Exported for
 * build.ts (C2.2), which re-keys descriptors when applying flag renames.
 */
export function optionKeyOf(flagName: string): string {
  return flagName
    .split("-")
    .filter((part) => part.length > 0)
    .map((part, i) =>
      i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join("");
}

/**
 * Allocates flag names within one tool. Collisions (two properties kebabbing
 * to the same name, or a property colliding with a derived `--clear-*` /
 * `--*-json` name) get a deterministic `-2`/`-3` suffix plus a warning —
 * never a throw. Both the kebab flag NAME and its camelCase OPTION KEY are
 * claimed: commander stores values by the camelized key, so `--foo2` and
 * `--foo-2` would silently alias each other if only names were deduped.
 */
class NameAllocator {
  private readonly usedNames = new Set<string>();
  private readonly usedKeys = new Set<string>();

  private take(name: string): boolean {
    const key = optionKeyOf(name);
    if (this.usedNames.has(name) || this.usedKeys.has(key)) return false;
    this.usedNames.add(name);
    this.usedKeys.add(key);
    return true;
  }

  claim(base: string, path: string, warnings: string[]): string {
    if (this.take(base)) return base;
    for (let i = 2; ; i += 1) {
      const candidate = `${base}-${i}`;
      if (this.take(candidate)) {
        warnings.push(
          `${path}: flag --${base} collides with an earlier flag — renamed to --${candidate}`,
        );
        return candidate;
      }
    }
  }

  /** Reserve a name that is mounted implicitly (a boolean's `--no-foo`). */
  reserve(name: string): void {
    this.usedNames.add(name);
    this.usedKeys.add(optionKeyOf(name));
  }
}

// ---------------------------------------------------------------------------
// Coercions
// ---------------------------------------------------------------------------

function numberCoercion(flagLabel: string): (raw: string) => number {
  return (raw) => {
    const value = raw.trim() === "" ? Number.NaN : Number(raw);
    if (!Number.isFinite(value)) {
      throw new FlagCoercionError(
        `${flagLabel} expects a number, got ${JSON.stringify(raw)}`,
      );
    }
    return value;
  };
}

function integerCoercion(flagLabel: string): (raw: string) => number {
  return (raw) => {
    const value = raw.trim() === "" ? Number.NaN : Number(raw);
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new FlagCoercionError(
        `${flagLabel} expects an integer, got ${JSON.stringify(raw)}`,
      );
    }
    return value;
  };
}

function booleanCoercion(flagLabel: string): (raw: string) => boolean {
  return (raw) => {
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new FlagCoercionError(
      `${flagLabel} expects true or false, got ${JSON.stringify(raw)}`,
    );
  };
}

function enumCoercion(
  flagLabel: string,
  values: readonly unknown[],
): (raw: string) => unknown {
  return (raw) => {
    for (const value of values) {
      if (String(value) === raw) return value;
    }
    throw new FlagCoercionError(
      `${flagLabel} must be one of: ${values
        .map((v) => String(v))
        .join(", ")} (got ${JSON.stringify(raw)})`,
    );
  };
}

/** Coercion for one primitive; undefined = raw string passes through. */
function primitiveCoercion(
  flagLabel: string,
  primitive: Primitive,
): ((raw: string) => unknown) | undefined {
  switch (primitive.kind) {
    case "string":
      return undefined;
    case "number":
      return numberCoercion(flagLabel);
    case "integer":
      return integerCoercion(flagLabel);
    case "boolean":
      return booleanCoercion(flagLabel);
    case "enum":
      return enumCoercion(flagLabel, primitive.values);
  }
}

/** Repeatable flags accumulate coerced items into an array. */
function arrayCoercion(
  flagLabel: string,
  items: Primitive,
): (raw: string, previous?: unknown) => unknown[] {
  const item = primitiveCoercion(flagLabel, items);
  return (raw, previous) => {
    const value = item ? item(raw) : raw;
    return Array.isArray(previous) ? [...previous, value] : [value];
  };
}

function branchLabel(primitive: Primitive): string {
  switch (primitive.kind) {
    case "string":
      return "a string";
    case "number":
      return "a number";
    case "integer":
      return "an integer";
    case "boolean":
      return "true/false";
    case "enum":
      return `one of ${primitive.values.map((v) => String(v)).join("|")}`;
  }
}

/**
 * Union coercion: try each branch IN SCHEMA ORDER; the first branch whose
 * coercion succeeds wins. Deterministic by construction (branch order comes
 * from the manifest, which preserves the server's zod union order). String
 * branches never reach here — `classify` degrades those unions to JSON mode.
 */
function unionCoercion(
  flagLabel: string,
  branches: readonly Primitive[],
): (raw: string) => unknown {
  const parts = branches.map((branch) => ({
    label: branchLabel(branch),
    coerce: primitiveCoercion(flagLabel, branch) ?? ((raw: string) => raw),
  }));
  return (raw) => {
    for (const part of parts) {
      try {
        return part.coerce(raw);
      } catch {
        // try the next branch
      }
    }
    throw new FlagCoercionError(
      `${flagLabel} expects ${parts
        .map((p) => p.label)
        .join(" or ")}, got ${JSON.stringify(raw)}`,
    );
  };
}

function describeJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  const type = typeof value;
  return type === "object" ? "an object" : `a ${type}`;
}

/**
 * Parse a JSON flag value with a usage-style error (`label` names the flag,
 * e.g. `--tasks-json`). Validates the top-level JSON type when known.
 */
export function parseJsonFlagValue(
  label: string,
  raw: string,
  top?: JsonTop,
): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new FlagCoercionError(
      `${label} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (top === "array" && !Array.isArray(parsed)) {
    throw new FlagCoercionError(
      `${label} expects a JSON array, got ${describeJson(parsed)}`,
    );
  }
  if (top === "object" && !isRecord(parsed)) {
    throw new FlagCoercionError(
      `${label} expects a JSON object, got ${describeJson(parsed)}`,
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Descriptor building
// ---------------------------------------------------------------------------

function placeholderOf(classified: Classified): string {
  switch (classified.kind) {
    case "string":
      return "<value>";
    case "number":
      return "<number>";
    case "integer":
      return "<int>";
    case "enum":
      return "<choice>";
    case "boolean":
      return "";
    case "array":
      return placeholderOf(classified.items);
    case "union":
      return "<value>";
    case "json":
      return "<json>";
  }
}

function joinHelp(description: string, hints: string[]): string {
  const suffix = hints.length > 0 ? `(${hints.join("; ")})` : "";
  return [description, suffix].filter((part) => part.length > 0).join(" ");
}

/** The property's own description wins; a lone nullable branch's is the fallback. */
function descriptionOf(propSchema: unknown, target: unknown): string {
  if (isRecord(propSchema) && typeof propSchema.description === "string") {
    return propSchema.description;
  }
  if (isRecord(target) && typeof target.description === "string") {
    return target.description;
  }
  return "";
}

interface EmitContext {
  property: string;
  path: string;
  description: string;
  classified: Classified;
  nullable: boolean;
  propertyRequired: boolean;
  names: NameAllocator;
  warnings: string[];
  descriptors: FlagDescriptor[];
}

function makeDescriptor(
  base: Omit<
    FlagDescriptor,
    "flag" | "optionKey" | "repeatable" | "takesValue" | "negatable"
  > &
    Partial<Pick<FlagDescriptor, "repeatable" | "takesValue" | "negatable">> & {
      placeholder?: string;
    },
): FlagDescriptor {
  const { placeholder, ...rest } = base;
  const takesValue = rest.takesValue ?? true;
  return {
    ...rest,
    flag: takesValue
      ? `--${rest.name} ${placeholder ?? "<value>"}`
      : `--${rest.name}`,
    optionKey: optionKeyOf(rest.name),
    repeatable: rest.repeatable ?? false,
    takesValue,
    negatable: rest.negatable ?? false,
  };
}

function emitClear(
  ctx: EmitContext,
  clearName: string,
  pairedFlagNames: string[],
): FlagDescriptor {
  return makeDescriptor({
    property: ctx.property,
    role: "clear",
    name: clearName,
    required: false,
    propertyRequired: ctx.propertyRequired,
    description: "",
    helpText: `Send null for ${ctx.property} (mutually exclusive with ${pairedFlagNames
      .map((n) => `--${n}`)
      .join("/")})`,
    takesValue: false,
  });
}

function emitProperty(ctx: EmitContext): void {
  const { classified, nullable, propertyRequired } = ctx;
  const base = kebabCase(ctx.property) || "arg";

  if (classified.kind === "json") {
    const jsonName = ctx.names.claim(`${base}-json`, ctx.path, ctx.warnings);
    const fileName = ctx.names.claim(`${base}-file`, ctx.path, ctx.warnings);
    const clearName = nullable
      ? ctx.names.claim(`clear-${base}`, ctx.path, ctx.warnings)
      : null;
    const jsonHints = [
      classified.top === "array"
        ? "JSON array"
        : classified.top === "object"
          ? "JSON object"
          : "JSON value",
      `or --${fileName} to read from a file`,
    ];
    if (clearName) jsonHints.push(`--${clearName} sends null`);
    ctx.descriptors.push(
      makeDescriptor({
        property: ctx.property,
        role: "json",
        name: jsonName,
        required: false,
        propertyRequired,
        description: ctx.description,
        helpText: joinHelp(ctx.description, jsonHints),
        placeholder: "<json>",
        jsonTop: classified.top,
        coerce: (raw: string) =>
          parseJsonFlagValue(`--${jsonName}`, raw, classified.top),
      }),
    );
    ctx.descriptors.push(
      makeDescriptor({
        property: ctx.property,
        role: "json-file",
        name: fileName,
        required: false,
        propertyRequired,
        description: "",
        helpText: `Read ${ctx.property} as JSON from a file ("-" = stdin; alternative to --${jsonName})`,
        placeholder: "<file>",
        jsonTop: classified.top,
      }),
    );
    if (clearName) {
      ctx.descriptors.push(emitClear(ctx, clearName, [jsonName, fileName]));
    }
    return;
  }

  const name = ctx.names.claim(base, ctx.path, ctx.warnings);
  if (classified.kind === "boolean") ctx.names.reserve(`no-${name}`);
  const clearName = nullable
    ? ctx.names.claim(`clear-${base}`, ctx.path, ctx.warnings)
    : null;
  const flagLabel = `--${name}`;
  const groupSize = nullable ? 2 : 1;

  const hints: string[] = [];
  let choices: readonly string[] | undefined;
  let coerce: FlagDescriptor["coerce"];
  let repeatable = false;

  switch (classified.kind) {
    case "string":
      break;
    case "number":
      coerce = numberCoercion(flagLabel);
      break;
    case "integer":
      coerce = integerCoercion(flagLabel);
      break;
    case "boolean":
      hints.push(`--no-${name} sets false`);
      break;
    case "enum":
      choices = classified.values.map((v) => String(v));
      hints.push(`choices: ${choices.join(", ")}`);
      coerce = enumCoercion(flagLabel, classified.values);
      break;
    case "array": {
      repeatable = true;
      if (classified.items.kind === "enum") {
        choices = classified.items.values.map((v) => String(v));
        hints.push(`choices: ${choices.join(", ")}`);
      }
      hints.push("repeatable");
      coerce = arrayCoercion(flagLabel, classified.items);
      break;
    }
    case "union":
      hints.push(
        `accepts ${classified.branches
          .map(branchLabel)
          .join(", then ")} — first match wins`,
      );
      coerce = unionCoercion(flagLabel, classified.branches);
      break;
  }
  if (clearName) hints.push(`--${clearName} sends null`);

  ctx.descriptors.push(
    makeDescriptor({
      property: ctx.property,
      role: "value",
      name,
      required: propertyRequired && groupSize === 1,
      propertyRequired,
      description: ctx.description,
      helpText: joinHelp(ctx.description, hints),
      placeholder: placeholderOf(classified),
      choices,
      repeatable,
      takesValue: classified.kind !== "boolean",
      negatable: classified.kind === "boolean",
      coerce,
    }),
  );
  if (clearName) {
    ctx.descriptors.push(emitClear(ctx, clearName, [name]));
  }
}

/**
 * Map one tool's input schema to its flag descriptors. NEVER throws on any
 * schema shape — unknown constructs degrade to JSON mode with a warning.
 */
export function buildToolFlags(
  tool: Pick<SurfaceTool, "name" | "inputSchema">,
): ToolFlags {
  const warnings: string[] = [];
  const descriptors: FlagDescriptor[] = [];
  const names = new NameAllocator();
  const schema = isRecord(tool.inputSchema) ? tool.inputSchema : {};
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const requiredList = Array.isArray(schema.required)
    ? schema.required.filter((r): r is string => typeof r === "string")
    : [];
  const required = new Set(requiredList);
  for (const name of requiredList) {
    if (!(name in properties)) {
      warnings.push(
        `${tool.name}: required property "${name}" has no schema — no flag generated`,
      );
    }
  }

  for (const [property, propSchema] of Object.entries(properties)) {
    const path = `${tool.name}.${property}`;

    // Nullable rule: strip `null` branches at the PROPERTY level; the rest
    // is classified normally and a paired `--clear-foo` is added.
    let nullable = false;
    let target: unknown = propSchema;
    if (isRecord(propSchema)) {
      const branches = branchesOf(propSchema);
      if (branches) {
        const rest = branches.filter(
          (b) => !(isRecord(b) && b.type === "null"),
        );
        if (rest.length < branches.length && rest.length > 0) {
          nullable = true;
          target = rest.length === 1 ? rest[0] : { anyOf: rest };
        }
      }
    }

    emitProperty({
      property,
      path,
      description: descriptionOf(propSchema, target),
      classified: classify(target, path, warnings),
      nullable,
      propertyRequired: required.has(property),
      names,
      warnings,
      descriptors,
    });
  }

  return { toolName: tool.name, descriptors, warnings };
}

// ---------------------------------------------------------------------------
// Inverse: parsed flag values → tool args object
// ---------------------------------------------------------------------------

export interface ArgsFromFlagsOptions {
  /**
   * Reads a `--foo-file` path ("-" = stdin is the caller's convention) and
   * returns its content. Injected because file reading is a process edge.
   */
  readFile?: (path: string) => string;
}

/**
 * Build the tool-args object from commander-parsed option values (keyed by
 * `optionKey`, coercions already applied at parse time). Enforces the
 * group rules: mutual exclusion (`--foo` vs `--clear-foo`, `--foo-json` vs
 * `--foo-file`) and requiredness for multi-flag groups. Keys in `values`
 * that no descriptor owns (cross-cutting flags like `--json`) are ignored.
 * Throws `FlagUsageError` / `FlagCoercionError` — both exit-2 semantics.
 */
export function argsFromFlagValues(
  descriptors: readonly FlagDescriptor[],
  values: Readonly<Record<string, unknown>>,
  options: ArgsFromFlagsOptions = {},
): Record<string, unknown> {
  const groups = new Map<string, FlagDescriptor[]>();
  for (const descriptor of descriptors) {
    const group = groups.get(descriptor.property);
    if (group) group.push(descriptor);
    else groups.set(descriptor.property, [descriptor]);
  }

  const args: Record<string, unknown> = {};
  for (const [property, group] of groups) {
    const provided = group.filter((d) => {
      const value = values[d.optionKey];
      return d.role === "clear" ? value === true : value !== undefined;
    });

    if (provided.length > 1) {
      throw new FlagUsageError(
        `use only one of ${provided.map((d) => `--${d.name}`).join(", ")}`,
      );
    }
    if (provided.length === 0) {
      if (group[0].propertyRequired) {
        throw new FlagUsageError(
          group.length === 1
            ? `missing required flag --${group[0].name}`
            : `one of ${group
                .map((d) => `--${d.name}`)
                .join(" / ")} is required (${property})`,
        );
      }
      continue;
    }

    const descriptor = provided[0];
    const value = values[descriptor.optionKey];
    if (descriptor.role === "clear") {
      args[property] = null;
      continue;
    }
    if (descriptor.role === "json-file") {
      if (typeof value !== "string") {
        throw new FlagUsageError(`--${descriptor.name} expects a file path`);
      }
      if (!options.readFile) {
        throw new FlagUsageError(
          `--${descriptor.name} is not wired to a file reader (internal: pass options.readFile to argsFromFlagValues)`,
        );
      }
      let content: string;
      try {
        content = options.readFile(value);
      } catch (e) {
        throw new FlagUsageError(
          `cannot read --${descriptor.name} ${value}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
      args[property] = parseJsonFlagValue(
        `--${descriptor.name} ${value}`,
        content,
        descriptor.jsonTop,
      );
      continue;
    }
    args[property] = value;
  }
  return args;
}
