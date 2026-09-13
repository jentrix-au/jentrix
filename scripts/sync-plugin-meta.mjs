#!/usr/bin/env node
/**
 * `pnpm sync:plugin-meta` — stamp the registry's behaviour revision and each
 * enrolled host's generated-resource digest into the package manifests
 * (plugin-sync G05). Run after `pnpm gen:workflows` or a hooks/manifest edit;
 * `pnpm check:plugin-sync` refuses a stale stamp. Writes ONLY the `jentrix`
 * field; everything else in each package.json is preserved byte-for-byte
 * apart from JSON re-serialization of that one key.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const registry = JSON.parse(readFileSync(join(root, "plugins/registry.json"), "utf8"));
const check = process.argv.includes("--check");

function resourceDigest(host) {
  const files = [];
  for (const wf of registry.workflows)
    files.push(join(host.packageDir, host.workflowPath.replaceAll("{name}", wf)));
  files.push(host.hooks, host.manifest);
  const h = createHash("sha256");
  for (const rel of files.sort()) {
    h.update(rel.split(sep).join("/"));
    h.update("\0");
    h.update(readFileSync(join(root, rel)));
    h.update("\0");
  }
  return h.digest("hex");
}

function stamp(rel, meta) {
  const path = join(root, rel);
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  const next = { ...pkg, jentrix: { ...(pkg.jentrix ?? {}), ...meta } };
  const text = `${JSON.stringify(next, null, 2)}\n`;
  const current = readFileSync(path, "utf8");
  if (current === text) return false;
  if (check) throw new Error(`${rel}: jentrix metadata is stale — run pnpm sync:plugin-meta`);
  writeFileSync(path, text);
  return true;
}

const enrolled = Object.entries(registry.hosts).filter(([, h]) => h.status === "enrolled");
const cli = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
let changed = 0;
for (const [name, host] of enrolled) {
  if (
    stamp(join(host.packageDir, "package.json"), {
      host: name,
      behaviorRevision: registry.behaviorRevision,
      semanticSchemaRevision: registry.semanticSchemaRevision,
      resourceDigest: resourceDigest(host),
      cliRange: `>=${cli.version} <1.0.0`,
    })
  )
    changed += 1;
}
if (
  stamp("package.json", {
    behaviorRevision: registry.behaviorRevision,
    semanticSchemaRevision: registry.semanticSchemaRevision,
    hosts: enrolled.map(([name]) => name),
    plannedHosts: Object.entries(registry.hosts).filter(([, h]) => h.status === "planned").map(([name]) => name),
    serverApiRange: "^1.4.0",
  })
)
  changed += 1;
process.stdout.write(`${changed} manifest(s) ${check ? "would change" : "updated"}; behaviour revision ${registry.behaviorRevision}\n`);
