/**
 * The versioned SEMANTIC HEADER a typed artifact body opens with (R08 of
 * prds/opencode-pi-plugins-prd.md §4.1): one fenced block, machine-parseable
 * and human-readable from the SAME bytes, so a reader never has to infer
 * truth from prose headings and a renderer never has to invent it.
 *
 *     ```jentrix
 *     schema: 1
 *     kind: final-output
 *     attemptId: 4d2c…
 *     ```
 *
 * Small on purpose: `key: value` lines, JSON for anything that is not a
 * plain string. The server keeps a MIRROR of this module
 * (`src/lib/semantic-header.ts` in the application repository — the
 * dependency firewall forbids an import); the pinned corpus in
 * test/semantic-header.test.ts is what keeps the two in lockstep.
 */

export const SEMANTIC_SCHEMA_VERSION = 1 as const;
export const SEMANTIC_FENCE = "jentrix";

/** The kinds the client writes today; unknown kinds parse but are not typed. */
export type SemanticKind =
  | "final-output"
  | "verification-receipt"
  | "output-manifest"
  | "checkpoint"
  | "coverage"
  | "uncommitted-patch";

export type SemanticValue =
  | string
  | number
  | boolean
  | null
  | SemanticValue[]
  | { [key: string]: SemanticValue };

export interface SemanticHeader {
  schema: number;
  kind: string;
  [key: string]: SemanticValue | undefined;
}

const FENCE_OPEN = "```" + SEMANTIC_FENCE;
const FENCE_CLOSE = "```";

function renderValue(value: SemanticValue): string {
  if (typeof value === "string") {
    // A string that would parse as JSON must be quoted so it round-trips.
    try {
      JSON.parse(value);
      return JSON.stringify(value);
    } catch {
      return /^\s|\s$|\n/.test(value) ? JSON.stringify(value) : value;
    }
  }
  return JSON.stringify(value);
}

function parseValue(raw: string): SemanticValue {
  const text = raw.trim();
  if (text === "") return "";
  try {
    return JSON.parse(text) as SemanticValue;
  } catch {
    return text;
  }
}

/** Render a header block. `schema` and `kind` always lead; keys otherwise in insertion order. */
export function renderSemanticHeader(
  header: { kind: string } & Record<string, SemanticValue | undefined>,
): string {
  const lines = [`schema: ${SEMANTIC_SCHEMA_VERSION}`, `kind: ${header.kind}`];
  for (const [key, value] of Object.entries(header)) {
    if (key === "kind" || key === "schema" || value === undefined) continue;
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`semantic header key ${JSON.stringify(key)} is not a plain identifier`);
    }
    lines.push(`${key}: ${renderValue(value)}`);
  }
  return `${FENCE_OPEN}\n${lines.join("\n")}\n${FENCE_CLOSE}`;
}

/** Prepend a header to a Markdown body. */
export function withSemanticHeader(
  header: { kind: string } & Record<string, SemanticValue | undefined>,
  body: string,
): string {
  return `${renderSemanticHeader(header)}\n\n${body}`;
}

/**
 * How many leading lines may precede the fence. A verification receipt keeps
 * the legacy `$ <command>` / `exit code: N` opener FIRST so a server that
 * predates headers still reads the command off line one; the header follows.
 */
export const HEADER_WITHIN_LINES = 16;

/**
 * Parse the header at the TOP of a body — the first fence within
 * {@link HEADER_WITHIN_LINES} lines (leading legacy opener lines tolerated).
 * Null when the body carries none, when the fence never closes, or when
 * `schema`/`kind` are missing — a malformed header is no header, never a
 * partial one.
 */
export function parseSemanticHeader(text: string | null | undefined): SemanticHeader | null {
  if (!text) return null;
  const lines = text.split("\n");
  let i = 0;
  while (
    i < lines.length &&
    i < HEADER_WITHIN_LINES &&
    lines[i]!.trim() !== FENCE_OPEN
  )
    i += 1;
  if (lines[i]?.trim() !== FENCE_OPEN) return null;
  const out: Record<string, SemanticValue> = {};
  for (i += 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === FENCE_CLOSE) {
      if (typeof out.schema !== "number" || typeof out.kind !== "string") return null;
      return out as SemanticHeader;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = parseValue(line.slice(colon + 1));
  }
  return null;
}

/** The body with its leading header removed (for excerpts and rendering). */
export function stripSemanticHeader(text: string): string {
  const header = parseSemanticHeader(text);
  if (!header) return text;
  const open = text.indexOf(FENCE_OPEN);
  const end = text.indexOf(`\n${FENCE_CLOSE}`, open);
  const before = text.slice(0, open).replace(/\s+$/, "");
  const after = text.slice(end + FENCE_CLOSE.length + 1).replace(/^\s*\n/, "");
  return before ? `${before}\n\n${after}` : after;
}

/** Typed accessors — string-or-null, never a coerced value. */
export function headerString(header: SemanticHeader | null, key: string): string | null {
  const value = header?.[key];
  return typeof value === "string" && value !== "" ? value : null;
}
export function headerNumber(header: SemanticHeader | null, key: string): number | null {
  const value = header?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
export function headerBoolean(header: SemanticHeader | null, key: string): boolean | null {
  const value = header?.[key];
  return typeof value === "boolean" ? value : null;
}
export function headerStrings(header: SemanticHeader | null, key: string): string[] {
  const value = header?.[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
