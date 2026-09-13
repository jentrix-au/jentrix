#!/usr/bin/env node
/**
 * `pnpm check:plugin-sync` — the permanent plugin synchronization guard
 * (prds/opencode-pi-plugins-prd.md §5.1, G01–G07). It COMPOSES the existing
 * generator/parity/package checks with executable behaviour checks and fails
 * with actionable diagnostics; it never rewrites fixtures, never approves an
 * exception and never blesses its own output.
 *
 *   node scripts/check-plugin-sync.mjs [--base <ref>] [--changed <a,b,c>]
 *                                      [--packed <dir>] [--root <dir>]
 *                                      [--skip-tests] [--json]
 *
 * G01 registry   — one authoritative host/workflow/behaviour registry; every
 *                  enrolled host has a manifest, hooks, entry, package and
 *                  generated entrypoints; versions agree; no duplicate host or
 *                  package; planned hosts have no package on disk.
 * G02 impact     — every record in plugins/changes/ is well formed and gives
 *                  every official host an explicit disposition; unaffected
 *                  needs evidence; not-applicable needs reviewed applicability.
 * G03 conformance— the shared semantic scenarios run through every enrolled
 *                  adapter (test/plugin-sync-conformance.test.ts) plus the
 *                  parity and generation tests.
 * G04 candidate  — merge-base→candidate diff: a shared, adapter, workflow or
 *                  plugin path changed ⇒ a record was added/modified in the
 *                  same diff and names the change's behaviours; unmapped
 *                  plugin-related paths are refused; the required checks are
 *                  still present in ci.yml/release.yml.
 * G05 packages   — each package embeds the common behaviour revision and the
 *                  digest of its generated resources; in --packed mode the
 *                  exact tarballs are inspected: no missing host package, no
 *                  stale resource, no mixed revision.
 * G07            — exercised by test/plugin-sync.test.ts, which runs this
 *                  script over mutated fixtures and proves each failure.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { satisfies } from "./semver-range.mjs";

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(name);
const ROOT = resolve(flag("--root") ?? fileURLToPath(new URL("../", import.meta.url)));
const JSON_OUT = has("--json");
const SKIP_TESTS = has("--skip-tests");
const PACKED = flag("--packed");

const DISPOSITIONS_ENROLLED = new Set([
  "shared-fix-applied",
  "adapter-fix-applied",
  "verified-unaffected",
  "not-applicable",
]);

const problems = [];
const notes = [];
const fail = (gate, message) => problems.push({ gate, message });
const note = (gate, message) => notes.push({ gate, message });

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const readJson = (rel) => JSON.parse(read(rel));
const exists = (rel) => existsSync(join(ROOT, rel));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(p);
      } else out.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

// ---------------------------------------------------------------------------
// G01 — the registry
// ---------------------------------------------------------------------------

let registry;
try {
  registry = readJson("plugins/registry.json");
} catch (error) {
  fail("G01", `plugins/registry.json unreadable: ${error.message}`);
}

const hosts = registry?.hosts ?? {};
const enrolled = Object.entries(hosts).filter(([, h]) => h.status === "enrolled");
const planned = Object.entries(hosts).filter(([, h]) => h.status === "planned");
const workflows = Array.isArray(registry?.workflows) ? registry.workflows : [];

if (registry) {
  if (typeof registry.behaviorRevision !== "string" || !registry.behaviorRevision)
    fail("G01", "registry.behaviorRevision must be a non-empty string");
  if (workflows.length !== 7)
    fail("G01", `registry lists ${workflows.length} workflows; the seven official workflows are required`);
  const behaviourIds = Object.keys(registry.behaviors ?? {});
  for (const id of [...Array.from({ length: 17 }, (_, i) => `P${String(i + 1).padStart(2, "0")}`), ...Array.from({ length: 8 }, (_, i) => `R${String(i + 1).padStart(2, "0")}`)]) {
    if (!behaviourIds.includes(id)) fail("G01", `registry.behaviors is missing ${id}`);
  }
  const packages = new Set();
  for (const [name, host] of Object.entries(hosts)) {
    if (!["enrolled", "planned"].includes(host.status))
      fail("G01", `host ${name}: unknown status ${JSON.stringify(host.status)}`);
    if (!host.package) fail("G01", `host ${name}: no package name`);
    if (packages.has(host.package)) fail("G01", `duplicate package ${host.package}`);
    packages.add(host.package);
  }
  for (const [name, host] of enrolled) {
    for (const key of ["packageDir", "manifest", "hooks", "entry", "workflowPath", "prefix"]) {
      if (!host[key]) fail("G01", `enrolled host ${name}: missing ${key}`);
    }
    for (const rel of [host.manifest, host.hooks, host.entry, join(host.packageDir ?? "", "package.json")]) {
      if (rel && !exists(rel)) fail("G01", `enrolled host ${name}: ${rel} does not exist`);
    }
    for (const rel of host.adapterPaths ?? []) {
      if (!exists(rel)) fail("G01", `enrolled host ${name}: adapter ${rel} does not exist`);
    }
    // Every workflow has a generated entrypoint for this host.
    for (const wf of workflows) {
      const rel = join(host.packageDir ?? "", (host.workflowPath ?? "").replaceAll("{name}", wf));
      if (!exists(rel)) fail("G01", `enrolled host ${name}: generated entrypoint ${rel} is missing`);
    }
    // entrypoints.json carries this host × every workflow.
    try {
      const entrypoints = readJson("plugins/workflows/entrypoints.json");
      for (const wf of workflows) {
        if (typeof entrypoints?.[name]?.[wf] !== "string")
          fail("G01", `plugins/workflows/entrypoints.json lacks ${name}.${wf}`);
      }
    } catch (error) {
      fail("G01", `entrypoints.json unreadable: ${error.message}`);
    }
    // Manifest and package.json agree on version and name.
    try {
      const pkg = readJson(join(host.packageDir, "package.json"));
      const manifest = readJson(host.manifest);
      if (pkg.name !== host.package)
        fail("G01", `${host.packageDir}/package.json names ${pkg.name}, registry says ${host.package}`);
      if (pkg.version !== manifest.version)
        fail("G01", `${host.package}: package.json ${pkg.version} != manifest ${manifest.version}`);
    } catch (error) {
      fail("G01", `host ${name}: cannot compare package/manifest: ${error.message}`);
    }
  }
  for (const [name, host] of planned) {
    if (!host.plannedIn) fail("G01", `planned host ${name}: plannedIn (task key) is required`);
    if (host.packageDir && exists(join(host.packageDir, "package.json")))
      fail("G01", `planned host ${name} has a package on disk (${host.packageDir}) — enroll it in the registry with its adapter, resources and evidence, or remove the package`);
  }
  // check-version.mjs must enumerate every enrolled package (release inventory).
  try {
    const checkVersion = read("scripts/check-version.mjs");
    for (const [name, host] of enrolled) {
      if (!checkVersion.includes(host.package))
        fail("G01", `scripts/check-version.mjs does not enumerate ${host.package} (host ${name})`);
    }
  } catch {
    fail("G01", "scripts/check-version.mjs missing");
  }
  // Release enumeration: release.yml names every enrolled package's publish.
  try {
    const release = read(".github/workflows/release.yml");
    for (const [name, host] of enrolled) {
      if (!release.includes(host.package))
        fail("G01", `.github/workflows/release.yml never names ${host.package} (host ${name}) — the release train would silently drop it`);
    }
    // The CLI must depend on every enrolled plugin package.
    const cli = readJson("package.json");
    for (const [name, host] of enrolled) {
      if (!cli.dependencies?.[host.package])
        fail("G01", `package.json does not depend on ${host.package} (host ${name})`);
    }
  } catch (error) {
    fail("G01", `release enumeration unreadable: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// G02 — impact records
// ---------------------------------------------------------------------------

const changesDir = join(ROOT, "plugins/changes");
const records = [];
for (const file of listFiles(changesDir).filter((f) => f.endsWith(".json"))) {
  const rel = relative(ROOT, file);
  let record;
  try {
    record = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail("G02", `${rel}: not JSON (${error.message})`);
    continue;
  }
  records.push({ rel, record });
  if (record.recordVersion !== 1) fail("G02", `${rel}: recordVersion must be 1`);
  for (const key of ["id", "issue", "title"]) {
    if (typeof record[key] !== "string" || !record[key]) fail("G02", `${rel}: ${key} is required`);
  }
  if (!Array.isArray(record.behaviors) || record.behaviors.length === 0)
    fail("G02", `${rel}: behaviors[] must name at least one behaviour id`);
  else
    for (const id of record.behaviors)
      if (!registry?.behaviors?.[id]) fail("G02", `${rel}: unknown behaviour id ${id}`);
  if (!Array.isArray(record.paths) || record.paths.length === 0)
    fail("G02", `${rel}: paths[] must name the changed paths`);
  if (!record.base?.revision) fail("G02", `${rel}: base.revision is required`);
  if (!record.candidate?.revision) fail("G02", `${rel}: candidate.revision is required`);
  const dispositions = record.hosts ?? {};
  for (const hostName of Object.keys(hosts)) {
    const d = dispositions[hostName];
    const host = hosts[hostName];
    if (!d || typeof d.disposition !== "string") {
      fail("G02", `${rel}: host ${hostName} has no disposition — every official host needs one (${host.status})`);
      continue;
    }
    if (host.status === "planned") {
      if (d.disposition !== "planned")
        fail("G02", `${rel}: planned host ${hostName} must carry disposition "planned" (got ${d.disposition}) — a planned entry is not passing evidence`);
      if (!d.plannedIn) fail("G02", `${rel}: planned host ${hostName} needs plannedIn`);
      continue;
    }
    if (!DISPOSITIONS_ENROLLED.has(d.disposition))
      fail("G02", `${rel}: host ${hostName}: unknown disposition ${d.disposition}`);
    if (d.disposition === "verified-unaffected") {
      if (!Array.isArray(d.evidence) || d.evidence.length === 0)
        fail("G02", `${rel}: host ${hostName} is verified-unaffected with no executable evidence — a label is not a test`);
      if (typeof d.rationale !== "string" || !d.rationale)
        fail("G02", `${rel}: host ${hostName} is verified-unaffected with no rationale`);
    }
    if (d.disposition === "not-applicable") {
      const a = d.applicability ?? {};
      for (const key of ["host", "version", "source", "reviewedBy"])
        if (!a[key]) fail("G02", `${rel}: host ${hostName} not-applicable needs applicability.${key}`);
    }
    if ((d.disposition === "shared-fix-applied" || d.disposition === "adapter-fix-applied") && (!Array.isArray(d.evidence) || d.evidence.length === 0))
      fail("G02", `${rel}: host ${hostName} claims ${d.disposition} with no evidence`);
    for (const ev of d.evidence ?? []) {
      if (typeof ev === "string" && /\.(test|spec)\.[cm]?[jt]sx?$/.test(ev) && !exists(ev))
        fail("G02", `${rel}: host ${hostName} cites evidence ${ev} which does not exist`);
    }
  }
  for (const hostName of Object.keys(dispositions)) {
    if (!hosts[hostName]) fail("G02", `${rel}: names unknown host ${hostName}`);
  }
}
const ids = new Set();
for (const { rel, record } of records) {
  if (ids.has(record.id)) fail("G02", `${rel}: duplicate record id ${record.id}`);
  ids.add(record.id);
}

// ---------------------------------------------------------------------------
// G04 — merge-base → candidate
// ---------------------------------------------------------------------------

function changedPaths() {
  const explicit = flag("--changed");
  if (explicit !== undefined) {
    return { source: "--changed", paths: explicit.split(",").map((p) => p.trim()).filter(Boolean) };
  }
  const base = flag("--base") ?? "origin/main";
  try {
    const mergeBase = execFileSync("git", ["merge-base", base, "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
    const committed = execFileSync("git", ["diff", "--name-only", `${mergeBase}..HEAD`], { cwd: ROOT, encoding: "utf8" });
    const working = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: ROOT, encoding: "utf8" });
    const paths = new Set(committed.split("\n").map((l) => l.trim()).filter(Boolean));
    for (const line of working.split("\n")) {
      const p = line.slice(3).trim();
      if (p) paths.add(p.includes(" -> ") ? p.split(" -> ")[1] : p);
    }
    return { source: `git merge-base ${base}=${mergeBase.slice(0, 12)}`, paths: [...paths] };
  } catch (error) {
    return { source: "unavailable", paths: null, error: error.message };
  }
}

const changed = changedPaths();
if (changed.paths === null) {
  fail("G04", `cannot derive the merge-base→candidate diff (${changed.error}); pass --base <ref> (with a fetched base) or --changed <paths> — path filters and skipped diffs are not accepted`);
} else {
  const sharedPrefixes = registry?.sharedPaths ?? [];
  const pluginPrefix = "plugins/";
  const isShared = (p) => sharedPrefixes.some((s) => (s.endsWith("/") ? p.startsWith(s) : p === s));
  const isRecord = (p) => p.startsWith("plugins/changes/") && p.endsWith(".json");
  const hostOf = (p) => Object.entries(hosts).find(([, h]) => (h.ownedPaths ?? []).some((o) => p.startsWith(o)) || (h.adapterPaths ?? []).includes(p))?.[0] ?? null;
  const relevant = changed.paths.filter((p) => isShared(p) || p.startsWith(pluginPrefix) || hostOf(p));
  const recordsInDiff = changed.paths.filter(isRecord);
  const relevantNonRecord = relevant.filter((p) => !isRecord(p) && p !== "plugins/changes/README.md");
  note("G04", `${changed.paths.length} changed path(s) from ${changed.source}; ${relevantNonRecord.length} plugin-relevant; ${recordsInDiff.length} impact record(s) in the diff`);
  if (relevantNonRecord.length > 0 && recordsInDiff.length === 0) {
    fail("G04", `plugin-relevant paths changed with NO impact record added or modified in the same diff: ${relevantNonRecord.slice(0, 8).join(", ")}${relevantNonRecord.length > 8 ? ", …" : ""} — add plugins/changes/<date>-<issue>-<slug>.json with a disposition for every official host`);
  }
  // Every relevant changed path must be covered by a record in the diff (by
  // prefix or exact), and unmapped plugin-related paths are refused.
  const diffRecords = records.filter((r) => recordsInDiff.includes(r.rel));
  const covered = (p) => diffRecords.some((r) => (r.record.paths ?? []).some((rp) => (rp.endsWith("/") ? p.startsWith(rp) : p === rp)));
  for (const p of relevantNonRecord) {
    if (!covered(p)) fail("G04", `changed path ${p} is not named by any impact record in this diff (paths[] may use a trailing "/" prefix)`);
    if (p.startsWith(pluginPrefix) && !p.startsWith("plugins/workflows/") && p !== "plugins/registry.json" && !hostOf(p) && !isRecord(p) && p !== "plugins/changes/README.md")
      fail("G04", `plugin-related path ${p} maps to no official host — register it under a host's ownedPaths or move it`);
  }
  // A host-specific change (adapter or owned path) must be assessed for the
  // OTHER enrolled hosts too: the record's disposition for them cannot be
  // omitted (G02 already enforces presence) — here we refuse a record that
  // marks a host adapter-fix-applied while the diff never touched that host.
  for (const r of diffRecords) {
    for (const [hostName, host] of enrolled) {
      const d = r.record.hosts?.[hostName];
      if (d?.disposition === "adapter-fix-applied") {
        const touched = changed.paths.some((p) => (host.ownedPaths ?? []).some((o) => p.startsWith(o)) || (host.adapterPaths ?? []).includes(p));
        if (!touched) fail("G04", `${r.rel}: host ${hostName} is adapter-fix-applied but the diff touched none of its adapter/owned paths`);
      }
    }
    // Shared change ⇒ every enrolled host must be shared-fix-applied or
    // carry executable unaffected/not-applicable evidence; a shared fix that
    // names only one host is exactly the drift the guard exists for.
    const sharedTouched = changed.paths.some(isShared);
    if (sharedTouched) {
      for (const [hostName] of enrolled) {
        const d = r.record.hosts?.[hostName];
        if (!d) continue; // G02 reported it
        if (d.disposition === "adapter-fix-applied") {
          const alsoShared = (r.record.behaviors ?? []).length > 0;
          if (!alsoShared) fail("G04", `${r.rel}: shared paths changed but ${hostName} is only adapter-fix-applied`);
        }
      }
    }
  }
  // Required checks still present in CI/release.
  try {
    const ci = read(".github/workflows/ci.yml");
    for (const check of registry?.requiredChecks?.ci ?? []) {
      const needle = check.replace(/^scripts\//, "scripts/");
      if (!ci.includes(needle)) fail("G04", `.github/workflows/ci.yml no longer runs required check ${JSON.stringify(check)}`);
    }
    const release = read(".github/workflows/release.yml");
    for (const check of registry?.requiredChecks?.release ?? []) {
      if (!release.includes(check)) fail("G04", `.github/workflows/release.yml no longer runs required check ${JSON.stringify(check)}`);
    }
  } catch (error) {
    fail("G04", `workflow files unreadable: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// G05 — package metadata and generated-resource digests
// ---------------------------------------------------------------------------

/** sha256 over every generated resource of one host, path-sorted. */
export function resourceDigest(root, host) {
  const files = [];
  for (const wf of workflows) files.push(join(host.packageDir, host.workflowPath.replaceAll("{name}", wf)));
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

/**
 * The package TRAIN a G05 pass validates against: the CLI's own version and
 * the server API release its contract pins. Set when the CLI package is
 * checked (source tree or its tarball), read when each plugin is — so a
 * plugin's `cliRange` is measured against the CLI actually shipping beside
 * it, not against whatever the source tree says. The 2026-09-12 review found
 * G05 accepting any string here (F06).
 */
let train = null;

function checkPackageMeta(pkg, rel, hostName, host, root) {
  const meta = pkg.jentrix;
  if (!meta || typeof meta !== "object") return fail("G05", `${rel}: missing "jentrix" metadata (behaviorRevision, resourceDigest)`);
  if (meta.behaviorRevision !== registry.behaviorRevision)
    fail("G05", `${rel}: behaviorRevision ${JSON.stringify(meta.behaviorRevision)} != registry ${registry.behaviorRevision} — regenerate/repack (mixed behaviour revisions are refused)`);
  // F06 — the semantic-header schema every package writes/reads must be the
  // registry's ONE revision; a package on another revision would emit or
  // parse headers the rest of the train does not.
  if (meta.semanticSchemaRevision !== registry.semanticSchemaRevision)
    fail("G05", `${rel}: semanticSchemaRevision ${JSON.stringify(meta.semanticSchemaRevision)} != registry ${JSON.stringify(registry.semanticSchemaRevision)} — run pnpm sync:plugin-meta and repack`);
  if (hostName) {
    const digest = resourceDigest(root, host);
    if (meta.resourceDigest !== digest)
      fail("G05", `${rel}: resourceDigest ${String(meta.resourceDigest).slice(0, 12)}… != generated resources ${digest.slice(0, 12)}… — stale generated resources; run pnpm gen:workflows and pnpm sync:plugin-meta`);
    if (meta.host !== hostName) fail("G05", `${rel}: jentrix.host must be ${hostName}`);
    if (typeof meta.cliRange !== "string") fail("G05", `${rel}: jentrix.cliRange (supported @jentrix/cli range) is required`);
    else if (!train) fail("G05", `${rel}: cliRange ${JSON.stringify(meta.cliRange)} cannot be validated — the CLI package of this train was not read first`);
    else if (!satisfies(train.cliVersion, meta.cliRange))
      fail("G05", `${rel}: cliRange ${JSON.stringify(meta.cliRange)} does not include @jentrix/cli ${train.cliVersion} of this train (or is not a range this guard understands: >=A <B, ^A, ~A, A)`);
  } else {
    const cliVersion = typeof pkg.version === "string" ? pkg.version : null;
    let apiRelease = null;
    try {
      apiRelease = JSON.parse(readFileSync(join(root, "contract.json"), "utf8")).apiRelease ?? null;
    } catch (error) {
      fail("G05", `${rel}: contract.json beside the CLI is unreadable (${error.message}) — serverApiRange cannot be validated`);
    }
    train = { cliVersion, apiRelease };
    if (typeof meta.serverApiRange !== "string") fail("G05", `${rel}: jentrix.serverApiRange is required on the CLI`);
    else if (apiRelease && !satisfies(apiRelease, meta.serverApiRange))
      fail("G05", `${rel}: serverApiRange ${JSON.stringify(meta.serverApiRange)} does not include the API release the CLI's contract pins (${apiRelease}) — or is not a range this guard understands`);
    // Source tree only: the header module's constant IS the schema revision.
    const headerModule = join(root, "src/session-host/semantic-header.ts");
    if (existsSync(headerModule)) {
      const declared = /SEMANTIC_SCHEMA_VERSION\s*=\s*(\d+)/.exec(readFileSync(headerModule, "utf8"));
      if (!declared) fail("G05", `${rel}: src/session-host/semantic-header.ts declares no SEMANTIC_SCHEMA_VERSION`);
      else if (Number(declared[1]) !== registry.semanticSchemaRevision)
        fail("G05", `${rel}: src/session-host/semantic-header.ts declares schema ${declared[1]} but the registry says ${JSON.stringify(registry.semanticSchemaRevision)} — the registry and the header module drifted`);
    }
    for (const [name, h] of enrolled) if (!meta.hosts?.includes(name)) fail("G05", `${rel}: jentrix.hosts must list enrolled host ${name} (${h.package})`);
    for (const [name] of planned) if (meta.hosts?.includes(name)) fail("G05", `${rel}: jentrix.hosts lists PLANNED host ${name} as shipped`);
  }
}

if (registry) {
  try {
    checkPackageMeta(readJson("package.json"), "package.json", null, null, ROOT);
    for (const [name, host] of enrolled)
      checkPackageMeta(readJson(join(host.packageDir, "package.json")), `${host.packageDir}/package.json`, name, host, ROOT);
  } catch (error) {
    fail("G05", `package metadata unreadable: ${error.message}`);
  }
}

if (PACKED && registry) {
  const dir = resolve(PACKED);
  const tarballs = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".tgz")) : [];
  const expect = [["cli", "jentrix-cli-", null, null], ...enrolled.map(([name, host]) => [name, `${host.package.replace("@", "").replace("/", "-")}-`, name, host])];
  const revisions = new Map();
  // F06: the packed set is its own train — plugins are measured against the
  // packed CLI's version, never the source tree's.
  train = null;
  for (const [label, prefix, hostName, host] of expect) {
    const file = tarballs.find((f) => f.startsWith(prefix));
    if (!file) {
      fail("G05", `--packed ${dir}: no tarball for ${label} (${prefix}*.tgz) — a release set missing a host package is refused`);
      continue;
    }
    const scratch = mkdtempSync(join(tmpdir(), "plugin-sync-pack-"));
    try {
      execFileSync("tar", ["-xzf", join(dir, file), "-C", scratch]);
      // A plugin tarball's root IS the plugin directory (each package is
      // packed from its own dir), while every registry path is REPO-relative
      // (`plugins/claude/…`). Re-home the extracted package at its packageDir
      // under the scratch root so the same digest/manifest readers apply
      // unchanged — the M1 gate's first real `--packed` run (JEN-536) found
      // this reading `package/plugins/claude/…` and failing on every tarball.
      let pkgRoot = join(scratch, "package");
      let treeRoot = pkgRoot;
      if (hostName) {
        const rehomed = join(scratch, "tree", host.packageDir);
        mkdirSync(dirname(rehomed), { recursive: true });
        renameSync(pkgRoot, rehomed);
        pkgRoot = rehomed;
        treeRoot = join(scratch, "tree");
      }
      const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
      if (JSON.stringify(pkg).includes("workspace:")) fail("G05", `${file}: a workspace: range survived packing`);
      checkPackageMeta(pkg, file, hostName, host, treeRoot);
      revisions.set(file, pkg.jentrix?.behaviorRevision ?? null);
      if (hostName) {
        for (const wf of workflows) {
          const rel = host.workflowPath.replaceAll("{name}", wf);
          if (!existsSync(join(pkgRoot, rel))) fail("G05", `${file}: packed package lacks ${rel}`);
        }
      }
    } catch (error) {
      fail("G05", `${file}: cannot inspect tarball (${error.message})`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  const distinct = new Set([...revisions.values()]);
  if (distinct.size > 1) fail("G05", `mixed behaviour revisions in the packed set: ${[...revisions.entries()].map(([f, r]) => `${f}=${r}`).join(", ")}`);
}

// ---------------------------------------------------------------------------
// G03 — executable equivalence: generation, parity and conformance suites
// ---------------------------------------------------------------------------

if (!SKIP_TESTS && registry) {
  const suites = ["test/plugin-parity.test.ts", registry.conformanceSuite].filter((s) => s && exists(s));
  if (!exists(registry.conformanceSuite ?? "")) fail("G03", `conformance suite ${registry.conformanceSuite} is missing`);
  for (const suite of suites) {
    try {
      execFileSync(process.execPath, ["--import", "tsx", "--test", suite], { cwd: ROOT, stdio: "pipe", encoding: "utf8" });
      note("G03", `${suite} passed`);
    } catch (error) {
      const out = `${error.stdout ?? ""}${error.stderr ?? ""}`;
      const failing = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
      fail("G03", `${suite} failed${failing.length ? `: ${failing.slice(0, 6).join(" | ")}` : ""}`);
    }
  }
  try {
    execFileSync(process.execPath, ["scripts/generate-workflows.mjs", "--check"], { cwd: ROOT, stdio: "pipe" });
  } catch (error) {
    fail("G03", `generated entrypoints are stale: ${String(error.stderr ?? error.message).trim().split("\n").pop()}`);
  }
}

// ---------------------------------------------------------------------------
// verdict
// ---------------------------------------------------------------------------

const summary = {
  ok: problems.length === 0,
  behaviorRevision: registry?.behaviorRevision ?? null,
  hosts: Object.fromEntries(Object.entries(hosts).map(([n, h]) => [n, h.status])),
  records: records.length,
  problems,
  notes,
};
if (JSON_OUT) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} else {
  for (const n of notes) process.stdout.write(`  · ${n.gate} ${n.message}\n`);
  for (const p of problems) process.stdout.write(`  ✗ ${p.gate} ${p.message}\n`);
  process.stdout.write(
    problems.length === 0
      ? `plugin-sync OK — behaviour revision ${registry?.behaviorRevision}; hosts ${Object.entries(hosts).map(([n, h]) => `${n}:${h.status}`).join(" ")}; ${records.length} impact record(s)\n`
      : `plugin-sync FAILED — ${problems.length} problem(s)\n`,
  );
}
process.exit(problems.length === 0 ? 0 : 1);
