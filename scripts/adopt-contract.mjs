#!/usr/bin/env node
/**
 * adopt-contract — adopt an MVP contract bundle into this package
 * (prds/open-client-plugin-ecosystem-prd.md §5.4 "client side"; open-client S2
 * row 7). The CLI is BUILT FROM the contract: its generated command tree, help
 * goldens and version line come from `surface.json`, and its mirror test from
 * `contract-vectors.json`. This script is the only writer of those files.
 *
 *   node scripts/adopt-contract.mjs docs/contract/mvp.json
 *   node scripts/adopt-contract.mjs https://tm.jentrix.ai/api/mcp/contract
 *
 * A URL is a contract MANIFEST: the script reads `bundleUrl`, fetches the
 * bundle, and REFUSES unless sha256(bytes) equals the manifest's `digest` and
 * the bundle's own `surface`/`apiRelease` equal the manifest's. A file path is
 * a bundle; its digest is computed. Either way `surface` must be `mvp` (D11 —
 * the public CLI refuses any other surface).
 *
 * Writes, all byte-stable (sorted keys, 2-space indent, trailing newline):
 *   surface.json           { _generated, generatedForToolCount, tools }
 *   contract-vectors.json  the bundle's `vectors`
 *   contract.json          { surface, apiRelease, digest } — what this build
 *                          was tested against; `jentrix session doctor` reads
 *                          it against the live manifest
 * then regenerates the help goldens. `--out <dir>` redirects the writes (and
 * skips the goldens) for tests; `--no-goldens` skips them alone.
 *
 * Exit 0 adopted; 1 refused (digest, surface, shape); 2 usage.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
/** The notice the projections carry — they are written here, never by hand. */
export const SURFACE_NOTICE = "jentrix adopt-contract — do not edit";
/** The notice the bundle carries (the generator's); part of the format. */
export const BUNDLE_NOTICE = "pnpm gen:contract — do not edit";

function compareCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => compareCodeUnits(a, b))
        .map(([key, child]) => [key, sortKeysDeep(child)]),
    );
  }
  return value;
}

/** The bundle's own serialization: sorted keys, 2 spaces, trailing newline. */
export function serialize(value) {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}

/** Lowercase hex SHA-256 — the manifest's `digest`. */
export function digestOf(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

class Refusal extends Error {}

function assertBundleShape(bundle) {
  if (!bundle || typeof bundle !== "object")
    throw new Refusal("bundle is not an object");
  if (bundle.surface !== "mvp") {
    throw new Refusal(
      `SURFACE_REFUSED: this CLI targets the mvp surface, the bundle says ${JSON.stringify(bundle.surface)} (D11)`,
    );
  }
  if (
    typeof bundle.apiRelease !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(bundle.apiRelease)
  ) {
    throw new Refusal(
      `bundle apiRelease is not a semver: ${JSON.stringify(bundle.apiRelease)}`,
    );
  }
  if (!Array.isArray(bundle.tools) || bundle.tools.length === 0)
    throw new Refusal("bundle has no tools");
  if (
    !bundle.vectors ||
    !Array.isArray(bundle.vectors.redaction) ||
    !Array.isArray(bundle.vectors.connectionKey)
  ) {
    throw new Refusal("bundle has no golden vectors");
  }
}

/**
 * Resolve a source to { bytes, bundle, digest, from }. `fetchImpl` is
 * injectable for tests; the default is the global fetch.
 */
export async function loadContract(source, fetchImpl = fetch) {
  if (/^https?:\/\//.test(source)) {
    const manifestRes = await fetchImpl(source);
    if (!manifestRes.ok)
      throw new Refusal(`manifest ${source} answered ${manifestRes.status}`);
    const manifest = await manifestRes.json();
    for (const key of ["surface", "apiRelease", "digest", "bundleUrl"]) {
      if (typeof manifest[key] !== "string")
        throw new Refusal(`manifest lacks ${key}`);
    }
    const bundleRes = await fetchImpl(manifest.bundleUrl);
    if (!bundleRes.ok)
      throw new Refusal(
        `bundle ${manifest.bundleUrl} answered ${bundleRes.status}`,
      );
    const bytes = new Uint8Array(await bundleRes.arrayBuffer());
    const digest = digestOf(bytes);
    if (digest !== manifest.digest) {
      throw new Refusal(
        `DIGEST_MISMATCH: the manifest at ${source} promises ${manifest.digest} but the bundle at ${manifest.bundleUrl} hashes to ${digest} — nothing written`,
      );
    }
    const bundle = JSON.parse(new TextDecoder().decode(bytes));
    assertBundleShape(bundle);
    if (
      bundle.surface !== manifest.surface ||
      bundle.apiRelease !== manifest.apiRelease
    ) {
      throw new Refusal(
        `MANIFEST_MISMATCH: manifest says ${manifest.surface}@${manifest.apiRelease}, bundle says ${bundle.surface}@${bundle.apiRelease}`,
      );
    }
    return {
      bytes,
      bundle,
      digest,
      from: source,
      publicationState: manifest.publicationState ?? null,
    };
  }
  const bytes = readFileSync(resolve(source));
  const bundle = JSON.parse(bytes.toString("utf8"));
  assertBundleShape(bundle);
  return {
    bytes,
    bundle,
    digest: digestOf(bytes),
    from: resolve(source),
    publicationState: null,
  };
}

/** The three projections, as text. */
export function projections(bundle, digest) {
  return {
    "surface.json": serialize({
      _generated: SURFACE_NOTICE,
      generatedForToolCount: bundle.tools.length,
      tools: bundle.tools,
    }),
    "contract-vectors.json": serialize(bundle.vectors),
    "contract.json": serialize({
      surface: bundle.surface,
      apiRelease: bundle.apiRelease,
      digest,
    }),
  };
}

export function writeProjections(outDir, files) {
  mkdirSync(outDir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(resolve(outDir, name), text);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const source = argv.find((a) => !a.startsWith("--"));
  const outFlag = argv.indexOf("--out");
  const outDir = outFlag >= 0 ? resolve(argv[outFlag + 1] ?? "") : PACKAGE_ROOT;
  const goldens = outFlag < 0 && !argv.includes("--no-goldens");
  if (!source || (outFlag >= 0 && !argv[outFlag + 1])) {
    process.stderr.write(
      "usage: adopt-contract.mjs <bundle-file | manifest-url> [--out <dir>] [--no-goldens]\n",
    );
    process.exit(2);
  }
  const { bundle, digest, from, publicationState } = await loadContract(source);
  writeProjections(outDir, projections(bundle, digest));
  if (goldens) {
    execFileSync(
      process.execPath,
      ["--import", "tsx", "scripts/gen-help-goldens.ts"],
      {
        cwd: PACKAGE_ROOT,
        stdio: "inherit",
      },
    );
  }
  process.stdout.write(
    `Adopted ${bundle.surface} contract ${bundle.apiRelease} (digest ${digest}, ${bundle.tools.length} tools${publicationState ? `, ${publicationState}` : ""}) from ${from} → ${outDir}\n`,
  );
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Refusal ? error.message : String(error?.stack ?? error)}\n`,
    );
    process.exit(1);
  });
}
