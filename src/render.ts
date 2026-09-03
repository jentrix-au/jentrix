/**
 * Result rendering: `structuredContent` → output string.
 *
 * PURE — no process, no I/O. Inside the dependency firewall.
 *
 * `--json` mode is the machine contract: a STABLE stringify (recursively
 * sorted keys) of `structuredContent`, which the server's P2.2 outputSchema
 * contract guarantees on every success. Human mode is cosmetic sugar: list
 * shapes (`{ <plural>: [...] }` with scalar metadata next to the array)
 * render as a compact table; everything else falls back to the same stable
 * JSON.
 */

export interface RenderOptions {
  json: boolean;
}

const MAX_CELL_WIDTH = 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deterministic JSON: object keys sorted recursively, 2-space indent. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeys(value[key]);
    }
    return sorted;
  }
  return value;
}

export function renderResult(
  structuredContent: unknown,
  options: RenderOptions,
): string {
  if (options.json) return stableStringify(structuredContent);
  const list = detectListShape(structuredContent);
  if (list) return renderListShape(list);
  return stableStringify(structuredContent);
}

interface ListShape {
  /** The plural property name, e.g. "tasks". */
  label: string;
  rows: Record<string, unknown>[];
  /** Scalar siblings (boardName, totalCount, notice, …) in original order. */
  meta: [string, unknown][];
}

/**
 * A list shape is a plain object with EXACTLY ONE array property whose
 * elements are all plain objects; the remaining properties must be scalars
 * (they render as metadata lines). Anything else → JSON fallback.
 */
function detectListShape(value: unknown): ListShape | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  const arrays = entries.filter(([, v]) => Array.isArray(v));
  if (arrays.length !== 1) return null;
  const [label, rowsUnknown] = arrays[0];
  const rows = rowsUnknown as unknown[];
  if (!rows.every(isRecord)) return null;
  const meta = entries.filter(
    ([key, v]) => key !== label && (v === null || typeof v !== "object"),
  );
  // Non-scalar siblings (nested objects) → not a simple list; fall back.
  if (meta.length !== entries.length - 1) return null;
  return { label, rows, meta };
}

function renderListShape({ label, rows, meta }: ListShape): string {
  const lines: string[] = [];
  if (rows.length === 0) {
    lines.push(`${label}: (none)`);
  } else {
    lines.push(...renderTable(rows));
  }
  for (const [key, value] of meta) {
    lines.push(`${key}: ${cellText(value)}`);
  }
  return lines.join("\n");
}

function renderTable(rows: Record<string, unknown>[]): string[] {
  // Columns: union of keys, in first-seen order.
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }
  const cells = rows.map((row) => columns.map((col) => cellText(row[col])));
  const widths = columns.map((col, i) =>
    Math.max(col.length, ...cells.map((row) => row[i].length)),
  );
  const formatRow = (values: string[]) =>
    values
      .map((text, i) => text.padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  return [formatRow(columns), ...cells.map(formatRow)];
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text =
    typeof value === "object" ? JSON.stringify(value) : String(value);
  if (text.length > MAX_CELL_WIDTH) {
    return `${text.slice(0, MAX_CELL_WIDTH - 1)}…`;
  }
  return text;
}
