/**
 * `--version` string composer (C4.3). PURE — no fs, no clock, no imports.
 *
 * `jentrix --version` prints more than a bare semver: it also states how many
 * MCP tools this CLI build carries (the manifest's `generatedForToolCount`) and
 * the DATE OF the bundled `surface.json` file, so an agent or a human can tell
 * at a glance roughly how fresh a build's surface is relative to the server it
 * talks to.
 *
 * Honesty note on the date: the manifest is deliberately timestamp-FREE — it is
 * byte-stable across regenerations (a baked-in timestamp would break the C0.2
 * sync test's byte-equality), so there is no true "generated at" instant INSIDE
 * it. The only date available is the on-disk `surface.json` file's mtime, which
 * `main.ts` reads and passes here. That mtime is honestly the date the surface
 * file was WRITTEN in this install (by `pnpm gen:cli-surface`, or the time it
 * was packed/extracted) — NOT a cryptographic proof of when the tool surface
 * was generated. The output wording says "surface file dated" precisely so it
 * does not over-claim; a missing/unreadable manifest omits count + date rather
 * than guessing.
 *
 * This module lives OUTSIDE the dependency firewall (it is not one of the five
 * core files) and imports nothing, so it is trivially unit-testable and reading
 * the manifest count stays on the existing surface/loader seam — no new
 * dependency enters a core file.
 */

/** Inputs for the version line — all already resolved by the caller. */
export interface VersionInfo {
  /** The CLI package semver (client.ts `CLI_VERSION`). */
  version: string;
  /**
   * The manifest's `generatedForToolCount`. `null` when `surface.json` is
   * missing/unreadable — the count is then omitted from the line.
   */
  toolCount: number | null;
  /**
   * The bundled `surface.json` file's mtime, as an ISO-8601 string (the honest
   * "when this surface file was last written" signal — see the module note).
   * `null` when unavailable — the date is then omitted.
   */
  surfaceFileMtime: string | null;
}

/**
 * Format the multi-part version line. Commander's `.version()` takes a plain
 * string, so this returns exactly what `jentrix --version` prints:
 *
 *   0.1.0 (surface: 134 tools, file dated 2026-07-06)
 *
 * with the parenthetical trimmed to whatever parts are known:
 *   - count only:  `0.1.0 (surface: 134 tools)`
 *   - date only:   `0.1.0 (surface file dated 2026-07-06)`
 *   - neither:     `0.1.0`
 *
 * The date is rendered as a bare `YYYY-MM-DD` (the day is the meaningful unit
 * for "how fresh is this surface"); a malformed mtime is dropped rather than
 * echoed.
 */
export function formatVersion(info: VersionInfo): string {
  const parts: string[] = [];
  if (typeof info.toolCount === "number" && Number.isFinite(info.toolCount)) {
    parts.push(`${info.toolCount} tools`);
  }
  const day = toDay(info.surfaceFileMtime);
  if (day) parts.push(`file dated ${day}`);

  if (parts.length === 0) return info.version;
  return `${info.version} (surface: ${parts.join(", ")})`;
}

/** ISO string → `YYYY-MM-DD`, or null if it is not a parseable date. */
function toDay(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  // Use the UTC calendar day so the label is stable regardless of the machine
  // timezone (the mtime is an absolute instant either way).
  return new Date(ms).toISOString().slice(0, 10);
}
