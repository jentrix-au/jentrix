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
  /**
   * JEN-495 (D4) — the tool that produced this result, when the caller knows
   * it. Only `search_tasks` reads it: its rows carry thirteen columns, and the
   * generic table wrapped every hit across several terminal lines, so an agent
   * cut the page with `head -30` and never saw the one card that held prior
   * context (§4 G5). Absent = the generic table, unchanged.
   */
  tool?: string;
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
  if (options.tool === "search_tasks") {
    const hits = renderTaskSearch(structuredContent);
    if (hits !== null) return hits;
  }
  const list = detectListShape(structuredContent);
  if (list) return renderListShape(list);
  return stableStringify(structuredContent);
}

/**
 * D4 — ONE LINE PER HIT: `KEY  title · board · column · updated`, then the
 * server's own `total`, then the continuation when the page was cut. The
 * server's ORDER is kept exactly (exact-key hits first, then rank): a client
 * that re-sorts a page disagrees with the query that produced it.
 *
 * Returns null when the payload is not the shape this renderer understands,
 * so an unexpected result falls back to the generic table rather than to a
 * confidently wrong summary.
 */
function renderTaskSearch(value: unknown): string | null {
  if (!isRecord(value) || !Array.isArray(value.results)) return null;
  const rows = value.results;
  if (!rows.every(isRecord)) return null;
  const lines: string[] = [];
  if (rows.length === 0) {
    lines.push("no matching tasks");
  } else {
    const keyWidth = Math.max(
      ...rows.map((row) => String(row.key ?? row.id ?? "").length),
    );
    for (const row of rows) {
      const facets = [row.boardName, row.columnName, row.updatedAt]
        .filter((part) => typeof part === "string" && part)
        .join(" · ");
      lines.push(
        `${String(row.key ?? row.id ?? "").padEnd(keyWidth)}  ${cellText(
          row.title,
        )}${facets ? `  · ${facets}` : ""}`,
      );
    }
  }
  if (typeof value.totalCount === "number") {
    lines.push(`total: ${value.totalCount}`);
  }
  if (typeof value.nextCursor === "string" && value.nextCursor) {
    lines.push(`next: --cursor ${value.nextCursor}`);
  }
  if (typeof value.notice === "string" && value.notice) {
    lines.push(value.notice);
  }
  return lines.join("\n");
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
