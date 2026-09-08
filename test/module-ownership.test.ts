import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(dir, entry.name))
      : entry.name.endsWith(".ts")
        ? [join(dir, entry.name)]
        : [],
  );
}

test("runtime module graph has no import cycles and session registration owns no shared utilities", () => {
  const files = walk(sourceRoot);
  const graph = new Map<string, Set<string>>();
  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const edges = new Set<string>();
    const add = (specifier: string) => {
      if (!specifier.startsWith(".")) return;
      const target =
        resolve(dirname(file), specifier).replace(/\.(js|ts)$/, "") + ".ts";
      if (files.includes(target)) edges.add(target);
    };
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        if (clause?.isTypeOnly) continue;
        const named = clause?.namedBindings;
        if (
          named &&
          ts.isNamedImports(named) &&
          named.elements.every((e) => e.isTypeOnly)
        )
          continue;
        add((statement.moduleSpecifier as ts.StringLiteral).text);
        if (
          (statement.moduleSpecifier as ts.StringLiteral).text.endsWith(
            "commands/session",
          ) ||
          (file.includes(`${sep}commands${sep}`) &&
            (statement.moduleSpecifier as ts.StringLiteral).text ===
              "./session")
        ) {
          assert.ok(named && ts.isNamedImports(named));
          assert.deepEqual(
            named.elements.map((e) => (e.propertyName ?? e.name).text),
            ["registerSessionCommand"],
          );
        }
      }
      if (
        ts.isExportDeclaration(statement) &&
        !statement.isTypeOnly &&
        statement.moduleSpecifier
      )
        add((statement.moduleSpecifier as ts.StringLiteral).text);
    }
    graph.set(file, edges);
  }
  const done = new Set<string>();
  const active: string[] = [];
  function visit(file: string) {
    assert.ok(
      !active.includes(file),
      `Import cycle: ${[...active, file].join(" → ")}`,
    );
    if (done.has(file)) return;
    active.push(file);
    for (const next of graph.get(file) ?? []) visit(next);
    active.pop();
    done.add(file);
  }
  files.forEach(visit);
  assert.ok(graph.size > 40, "empty/vacuous graph");
});
