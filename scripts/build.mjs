/**
 * Build the three ESM bundles — `dist/main.js` (the `jentrix` bin),
 * `dist/session-host-main.js` (the `jentrix-session-host` bin, client-runtime
 * v2 D10: the connected-session host ships INSIDE this package) and
 * `dist/core.js` (the `@jentrix/cli/core` package entry, open-client S2 — the
 * firewalled core the application repository tests through the package
 * boundary, with `dist/core.d.ts` emitted beside it by tsc). A script rather
 * than a one-liner only because the banner needs newlines: the CJS deps
 * (commander) call `require("node:events")` at init, and ESM output has no
 * `require` unless we hand it one via `createRequire`.
 *
 * The provider plugins are NOT part of this build. Since open-client S3 they
 * are their own workspace packages (`@jentrix/plugin-claude` in
 * plugins/claude, `@jentrix/plugin-codex` in plugins/codex) that this package
 * depends on with exact pins; `main.ts` resolves their directories through
 * module resolution at run time, never by a path next to dist/. Nothing is
 * copied anywhere (the old `cpSync` from `../agents` went with v2 §18).
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const banner = {
  js: [
    "#!/usr/bin/env node",
    'import { createRequire as __stacksCreateRequire } from "node:module";',
    "const require = __stacksCreateRequire(import.meta.url);",
  ].join("\n"),
};

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/main.js",
  banner,
  logLevel: "info",
});

await build({
  entryPoints: ["src/session-host-main.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/session-host-main.js",
  banner,
  logLevel: "info",
  // G6: no provider SDK ships with the CLI. The Codex LAUNCH arm's dynamic
  // import stays external — and unreachable, refused by the dispatch guard.
  external: ["@openai/codex-sdk"],
});

// The core entry: no banner (nothing in it is CJS), no external — the core
// imports the MCP SDK for TYPES only, so the bundle is self-contained. The
// declarations come from tsc over the same entry (tsconfig.core.json), so the
// `.d.ts` files describe exactly what `src/core.ts` re-exports.
await build({
  entryPoints: ["src/core.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/core.js",
  logLevel: "info",
});
execFileSync(
  process.execPath,
  [
    fileURLToPath(
      new URL("../node_modules/typescript/bin/tsc", import.meta.url),
    ),
    "-p",
    "tsconfig.core.json",
  ],
  { stdio: "inherit" },
);
