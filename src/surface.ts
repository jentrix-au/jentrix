/**
 * Types + parser for the generated surface manifest (`surface.json`,
 * written only by `pnpm gen:cli-surface` in the app repo).
 *
 * PURE — takes the manifest JSON as a string; no filesystem access here.
 * Inside the dependency firewall. Validation is hand-rolled (zod is not
 * permitted in core modules).
 */

export const TOOL_CLASSES = ["read", "write", "admin"] as const;

/** Scope class a tool's `safe()` wrapper enforces (P2.1). */
export type ToolClass = (typeof TOOL_CLASSES)[number];

/** Spec annotations dumped from `tools/list` (readOnlyHint etc.). */
export type SurfaceAnnotations = Record<string, unknown>;

export interface SurfaceTool {
  name: string;
  description: string;
  toolClass: ToolClass;
  /** JSON Schema for the tool's input (the SDK converts the server's zod). */
  inputSchema: Record<string, unknown>;
  annotations: SurfaceAnnotations;
}

export interface SurfaceManifest {
  generatedForToolCount: number;
  tools: SurfaceTool[];
}

export class SurfaceError extends Error {
  constructor(message: string) {
    super(`Invalid surface manifest: ${message}`);
    this.name = "SurfaceError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolClass(value: unknown): value is ToolClass {
  return (
    typeof value === "string" &&
    (TOOL_CLASSES as readonly string[]).includes(value)
  );
}

/**
 * Parse + validate a manifest JSON string. Throws `SurfaceError` naming the
 * offending tool/field so a truncated or hand-edited manifest fails loudly
 * instead of producing a half-built command tree.
 */
export function loadSurface(json: string): SurfaceManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new SurfaceError(
      `not valid JSON (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  if (!isRecord(parsed)) throw new SurfaceError("root is not an object");
  const { generatedForToolCount, tools } = parsed;
  if (!Array.isArray(tools)) throw new SurfaceError("`tools` is not an array");
  if (typeof generatedForToolCount !== "number") {
    throw new SurfaceError("`generatedForToolCount` is not a number");
  }
  if (generatedForToolCount !== tools.length) {
    throw new SurfaceError(
      `\`generatedForToolCount\` (${generatedForToolCount}) does not match tools.length (${tools.length}) — manifest truncated or stale; run pnpm gen:cli-surface`,
    );
  }
  const seen = new Set<string>();
  const validated = tools.map((tool, index) => {
    const where = (field: string) =>
      isRecord(tool) && typeof tool.name === "string"
        ? `tool "${tool.name}": ${field}`
        : `tools[${index}]: ${field}`;
    if (!isRecord(tool))
      throw new SurfaceError(`tools[${index}] is not an object`);
    if (typeof tool.name !== "string" || tool.name.length === 0) {
      throw new SurfaceError(where("missing or empty `name`"));
    }
    if (seen.has(tool.name)) {
      throw new SurfaceError(`duplicate tool name "${tool.name}"`);
    }
    seen.add(tool.name);
    if (typeof tool.description !== "string") {
      throw new SurfaceError(where("missing `description`"));
    }
    if (!isToolClass(tool.toolClass)) {
      throw new SurfaceError(
        where(
          `\`toolClass\` must be one of ${TOOL_CLASSES.join(" | ")}, got ${JSON.stringify(tool.toolClass)}`,
        ),
      );
    }
    if (!isRecord(tool.inputSchema)) {
      throw new SurfaceError(where("missing `inputSchema` object"));
    }
    if (!isRecord(tool.annotations)) {
      throw new SurfaceError(where("missing `annotations` object"));
    }
    return {
      name: tool.name,
      description: tool.description,
      toolClass: tool.toolClass,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    } satisfies SurfaceTool;
  });
  return { generatedForToolCount, tools: validated };
}
