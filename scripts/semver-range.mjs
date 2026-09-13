/**
 * Minimal semver-range matcher shared by the repo's guards
 * (`validate-examples.mjs`, `check-plugin-sync.mjs` G05). Understands the
 * forms the packages actually declare — `>=A <B`, `>=A`, `^A`, `~A`, `A` —
 * and nothing else: an unparseable range never satisfies anything, so a
 * typo fails the guard instead of passing it.
 */

export const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Does `version` satisfy a range of the forms `>=A <B`, `>=A`, `^A`, `~A`, `A`? */
export function satisfies(version, range) {
  if (typeof version !== "string" || typeof range !== "string") return false;
  const parse = (v) => v.split("-")[0].split(".").map(Number);
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  if (!SEMVER.test(version)) return false;
  const v = parse(version);
  const clauses = range.trim().split(/\s+/);
  if (clauses.length === 0 || clauses[0] === "") return false;
  return clauses.every((clause) => {
    const m = /^(>=|<=|>|<|\^|~|=)?(\d+\.\d+\.\d+)$/.exec(clause);
    if (!m) return false;
    const [, op = "=", bound] = m;
    const b = parse(bound);
    switch (op) {
      case ">=": return cmp(v, b) >= 0;
      case ">": return cmp(v, b) > 0;
      case "<=": return cmp(v, b) <= 0;
      case "<": return cmp(v, b) < 0;
      case "^": return cmp(v, b) >= 0 && (b[0] > 0 ? v[0] === b[0] : b[1] > 0 ? v[0] === 0 && v[1] === b[1] : cmp(v, b) === 0);
      case "~": return cmp(v, b) >= 0 && v[0] === b[0] && v[1] === b[1];
      default: return cmp(v, b) === 0;
    }
  });
}
