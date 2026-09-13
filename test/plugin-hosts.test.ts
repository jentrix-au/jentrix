/**
 * M2 (JEN-537) — `jentrix plugin install|remove opencode|pi` and the doctor's
 * view of both, over fake deps: the managed loader is the ONLY thing written
 * for OpenCode (and never over a file this CLI did not write); Pi goes
 * through `pi install` / `pi remove` / `pi list` and nothing else.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { EXIT_CODES } from "../src/errors.js";
import type { PluginCommandDeps, PluginInvocation } from "../src/commands/plugin.js";
import { runPluginInstall } from "../src/commands/plugin.js";
import {
  hostPluginState,
  openCodeConfigDir,
  openCodeLoaderPath,
  parseManagedLoader,
  piListNames,
  removeHostPlugin,
  renderOpenCodeLoader,
  stageHostPlugin,
} from "../src/commands/plugin-hosts.js";

const OC = "/npm/node_modules/@jentrix/plugin-opencode";
const PI = "/npm/node_modules/@jentrix/plugin-pi";
const HOME = "/home/u";

function files(dir: string, host: "opencode" | "pi"): Record<string, string> {
  const out: Record<string, string> = {
    [join(dir, "manifest.json")]: JSON.stringify({ name: "jentrix", version: "0.1.0", host }),
    [join(dir, "src", "index.js")]: "export const x = 1;\n",
    [join(dir, "package.json")]: JSON.stringify({ name: `@jentrix/plugin-${host}`, version: "0.1.0", jentrix: { behaviorRevision: "rev-1" } }),
  };
  for (const w of ["connect", "align", "plan", "checkpoint", "review", "status", "end"]) {
    out[join(dir, "commands", `jentrix-${w}.md`)] = `---\ndescription: ${w}\n---\nbody\n`;
  }
  return out;
}

interface Fake {
  deps: PluginCommandDeps;
  out: string[];
  err: string[];
  fs: Record<string, string>;
  calls: string[][];
  deleted: string[];
}

function fake(options: {
  fs?: Record<string, string>;
  opencode?: string | null;
  pi?: string | null;
  invoke?: (file: string, args: string[]) => PluginInvocation;
  env?: Record<string, string | undefined>;
} = {}): Fake {
  const fs = { ...(options.fs ?? {}) };
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[][] = [];
  const deleted: string[] = [];
  const deps: PluginCommandDeps = {
    resolvePluginDir: () => null,
    resolveCodexPluginDir: () => null,
    resolveOpenCodePluginDir: () => (fs[join(OC, "manifest.json")] ? OC : null),
    resolvePiPluginDir: () => (fs[join(PI, "manifest.json")] ? PI : null),
    resolveClaude: async () => null,
    resolveCodex: async () => null,
    resolveOpenCode: async () => ("opencode" in options ? options.opencode! : "/bin/opencode"),
    resolvePi: async () => ("pi" in options ? options.pi! : "/bin/pi"),
    env: () => options.env ?? {},
    homeDir: () => HOME,
    ensureDir: () => {},
    deleteFile: (path) => {
      deleted.push(path);
      delete fs[path];
    },
    cliPackageRoot: () => "/npm/node_modules/@jentrix/cli",
    resolveSessionHostBin: async () => "/bin/jentrix-session-host",
    nodeExecPath: () => "/bin/node",
    fileExists: (path) => path in fs,
    readTextFile: (path) => fs[path] ?? null,
    writeTextFile: (path, text) => {
      fs[path] = text;
    },
    invoke: async (file, args) => {
      calls.push([file, ...args]);
      return options.invoke?.(file, args) ?? { code: 0, stdout: "", stderr: "" };
    },
    writeOut: (t) => out.push(t),
    writeErr: (t) => err.push(t),
    hasCredential: () => true,
    login: async () => 0,
    isInteractive: false,
  };
  return { deps, out, err, fs, calls, deleted };
}

test("OpenCode config dir follows XDG_CONFIG_HOME, the loader lives under its plugins folder, and the marker round-trips", () => {
  assert.equal(openCodeConfigDir({}, HOME), join(HOME, ".config", "opencode"));
  assert.equal(openCodeConfigDir({ XDG_CONFIG_HOME: "/x" }, HOME), join("/x", "opencode"));
  assert.equal(openCodeLoaderPath({}, HOME), join(HOME, ".config", "opencode", "plugins", "jentrix.js"));
  const loader = renderOpenCodeLoader(OC, "0.1.0");
  assert.match(loader, /^\/\/ jentrix-managed:\{/);
  assert.match(loader, /export \{ JentrixOpenCodePlugin \} from "file:\/\/\/npm\/node_modules\/@jentrix\/plugin-opencode\/src\/index\.js";/);
  assert.deepEqual(parseManagedLoader(loader), { package: "@jentrix/plugin-opencode", version: "0.1.0", dir: OC, cli: parseManagedLoader(loader)!.cli });
  assert.equal(parseManagedLoader("export default 1;\n"), null);
  assert.equal(parseManagedLoader(null), null);
  assert.equal(piListNames(`Installed packages:\n  ${PI}  (local)\n`, PI), true);
  assert.equal(piListNames("Installed packages:\n  npm:@foo/bar\n", PI), false);
});

test("staging: a complete package passes; a wrong host, a missing entry or a missing command is named", () => {
  const ok = fake({ fs: files(OC, "opencode") });
  assert.deepEqual(stageHostPlugin(ok.deps, "opencode", OC), { version: "0.1.0", commands: 7, problems: [] });
  const wrong = fake({ fs: { ...files(OC, "pi") } });
  const staged = stageHostPlugin(wrong.deps, "opencode", OC);
  assert.match(staged.problems.join(";"), /is for "pi", expected "opencode"/);
  const partial = fake({ fs: files(PI, "pi") });
  delete partial.fs[join(PI, "commands", "jentrix-end.md")];
  delete partial.fs[join(PI, "src", "index.js")];
  const p = stageHostPlugin(partial.deps, "pi", PI).problems;
  assert.ok(p.some((x) => /src\/index\.js/.test(x)) && p.some((x) => /jentrix-end\.md/.test(x)));
});

test("install opencode: writes ONE managed loader, is idempotent, repoints its own stale loader, refuses a foreign file, and dry-run writes nothing", async () => {
  const f = fake({ fs: files(OC, "opencode") });
  const loaderPath = openCodeLoaderPath({}, HOME);
  assert.equal(await runPluginInstall(f.deps, "opencode", { dryRun: true }), EXIT_CODES.OK);
  assert.match(f.out[0]!, /dry run: would write the managed loader .*plugins\/jentrix\.js → \/npm\/node_modules\/@jentrix\/plugin-opencode \(plugin 0\.1\.0, 7 commands/);
  assert.equal(f.fs[loaderPath], undefined);
  assert.equal(await runPluginInstall(f.deps, "opencode"), EXIT_CODES.OK);
  assert.equal(f.fs[loaderPath], renderOpenCodeLoader(OC, "0.1.0"));
  assert.match(f.out.join("\n"), /Managed loader written: .*jentrix\.js → \/npm\/node_modules\/@jentrix\/plugin-opencode \(plugin 0\.1\.0\)/);
  assert.match(f.out.join("\n"), /ready for OpenCode: \/jentrix-connect/);
  assert.match(f.out.join("\n"), /restart OpenCode/);
  assert.deepEqual(f.calls, [], "no process is invoked for OpenCode");
  // Same again: current, nothing rewritten.
  f.out.length = 0;
  assert.equal(await runPluginInstall(f.deps, "opencode"), EXIT_CODES.OK);
  assert.match(f.out[0]!, /Managed loader already current/);
  // A stale loader of this CLI's own (an earlier install path) is repointed.
  f.fs[loaderPath] = renderOpenCodeLoader("/old/node_modules/@jentrix/plugin-opencode", "0.0.9");
  f.out.length = 0;
  assert.equal(await runPluginInstall(f.deps, "opencode"), EXIT_CODES.OK);
  assert.match(f.out[0]!, /Managed loader repointed: .* pointed at \/old\/node_modules\/@jentrix\/plugin-opencode \(an earlier copy\) → \/npm/);
  assert.equal(f.fs[loaderPath], renderOpenCodeLoader(OC, "0.1.0"));
  // A file this CLI did not write is never overwritten.
  f.fs[loaderPath] = "export const mine = true;\n";
  assert.equal(await runPluginInstall(f.deps, "opencode"), EXIT_CODES.INVALID_INPUT);
  assert.match(f.err.at(-1)!, /PLUGIN_LOADER_CONFLICT/);
  assert.equal(f.fs[loaderPath], "export const mine = true;\n");
  // No opencode binary: refused, nothing written.
  const none = fake({ fs: files(OC, "opencode"), opencode: null });
  assert.equal(await runPluginInstall(none.deps, "opencode"), 2);
  assert.match(none.err[0]!, /OPENCODE_NOT_INSTALLED/);
  assert.equal(none.fs[loaderPath], undefined);
  // XDG_CONFIG_HOME moves the loader with the config dir.
  const xdg = fake({ fs: files(OC, "opencode"), env: { XDG_CONFIG_HOME: "/xdg" } });
  assert.equal(await runPluginInstall(xdg.deps, "opencode"), EXIT_CODES.OK);
  assert.ok(xdg.fs[join("/xdg", "opencode", "plugins", "jentrix.js")]);
});

test("remove opencode: deletes only the managed loader; a foreign file is left; nothing is fine", async () => {
  const f = fake({ fs: files(OC, "opencode") });
  const loaderPath = openCodeLoaderPath({}, HOME);
  assert.equal(await removeHostPlugin(f.deps, "opencode"), EXIT_CODES.OK);
  assert.match(f.out[0]!, /Nothing to remove/);
  f.fs[loaderPath] = renderOpenCodeLoader(OC, "0.1.0");
  assert.equal(await removeHostPlugin(f.deps, "opencode"), EXIT_CODES.OK);
  assert.deepEqual(f.deleted, [loaderPath]);
  assert.match(f.out[1]!, /Managed loader removed/);
  f.fs[loaderPath] = "export const mine = true;\n";
  assert.equal(await removeHostPlugin(f.deps, "opencode"), EXIT_CODES.INVALID_INPUT);
  assert.match(f.err[0]!, /PLUGIN_LOADER_CONFLICT/);
  assert.equal(f.fs[loaderPath], "export const mine = true;\n");
});

test("install pi: `pi install <dir>` then `pi list` as the activation proof; already-listed skips; a failed install or an unproven activation is refused", async () => {
  let listed = false;
  const f = fake({
    fs: files(PI, "pi"),
    invoke: (_file, args) => {
      if (args[0] === "list") return { code: 0, stdout: listed ? `Installed packages:\n  ${PI}\n` : "Installed packages:\n  (none)\n", stderr: "" };
      if (args[0] === "install") {
        listed = true;
        return { code: 0, stdout: "Installed\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    },
  });
  assert.equal(await runPluginInstall(f.deps, "pi", { dryRun: true }), EXIT_CODES.OK);
  assert.match(f.out[0]!, /dry run: would run `pi install \/npm\/node_modules\/@jentrix\/plugin-pi` \(plugin 0\.1\.0, 7 commands/);
  assert.deepEqual(f.calls, []);
  assert.equal(await runPluginInstall(f.deps, "pi"), EXIT_CODES.OK);
  assert.deepEqual(f.calls, [["/bin/pi", "list"], ["/bin/pi", "install", PI], ["/bin/pi", "list"]]);
  assert.match(f.out.join("\n"), /Pi package registered: \/npm\/node_modules\/@jentrix\/plugin-pi \(plugin 0\.1\.0\)/);
  assert.match(f.out.join("\n"), /ready for Pi: \/jentrix-connect/);
  f.calls.length = 0;
  f.out.length = 0;
  assert.equal(await runPluginInstall(f.deps, "pi"), EXIT_CODES.OK);
  assert.deepEqual(f.calls, [["/bin/pi", "list"]]);
  assert.match(f.out[0]!, /already registered/);
  const failing = fake({ fs: files(PI, "pi"), invoke: (_f, args) => (args[0] === "install" ? { code: 1, stdout: "", stderr: "boom: bad path\nmore" } : { code: 0, stdout: "", stderr: "" }) });
  assert.equal(await runPluginInstall(failing.deps, "pi"), EXIT_CODES.INTERNAL);
  assert.match(failing.err[0]!, /PLUGIN_INSTALL_FAILED: `pi install .*` exited 1: boom: bad path$/);
  const unproven = fake({ fs: files(PI, "pi"), invoke: () => ({ code: 0, stdout: "", stderr: "" }) });
  assert.equal(await runPluginInstall(unproven.deps, "pi"), EXIT_CODES.INTERNAL);
  assert.match(unproven.err[0]!, /activation not proven/);
  const none = fake({ fs: files(PI, "pi"), pi: null });
  assert.equal(await runPluginInstall(none.deps, "pi"), 2);
  assert.match(none.err[0]!, /PI_NOT_INSTALLED/);
});

test("remove pi: `pi remove <dir>` only when listed", async () => {
  let listed = true;
  const f = fake({
    fs: files(PI, "pi"),
    invoke: (_file, args) => {
      if (args[0] === "list") return { code: 0, stdout: listed ? `  ${PI}\n` : "", stderr: "" };
      if (args[0] === "remove") {
        listed = false;
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    },
  });
  assert.equal(await removeHostPlugin(f.deps, "pi"), EXIT_CODES.OK);
  assert.deepEqual(f.calls, [["/bin/pi", "list"], ["/bin/pi", "remove", PI]]);
  f.calls.length = 0;
  assert.equal(await removeHostPlugin(f.deps, "pi"), EXIT_CODES.OK);
  assert.deepEqual(f.calls, [["/bin/pi", "list"]]);
  assert.match(f.out.at(-1)!, /Nothing to remove/);
});

test("the doctor's host state names the copy the host would LOAD", async () => {
  const f = fake({ fs: files(OC, "opencode") });
  const loaderPath = openCodeLoaderPath({}, HOME);
  let state = await hostPluginState(f.deps as never, "opencode", OC);
  assert.deepEqual(state.registration, { kind: "loader", path: loaderPath, state: "absent", target: null });
  assert.equal(state.loadedPackageJson, null);
  f.fs[loaderPath] = renderOpenCodeLoader("/old/plugin-opencode", "0.0.9");
  state = await hostPluginState(f.deps as never, "opencode", OC);
  assert.deepEqual(state.registration, { kind: "loader", path: loaderPath, state: "managed", target: "/old/plugin-opencode" });
  assert.equal(state.loadedPackageJson, join("/old/plugin-opencode", "package.json"));
  f.fs[loaderPath] = "not ours";
  assert.equal((await hostPluginState(f.deps as never, "opencode", OC)).registration.state, "foreign");
  const p = fake({ fs: files(PI, "pi"), invoke: () => ({ code: 0, stdout: `  ${PI}\n`, stderr: "" }) });
  const ps = await hostPluginState(p.deps as never, "pi", PI);
  assert.equal(ps.registration.state, "present");
  assert.equal(ps.loadedPackageJson, join(PI, "package.json"));
  const absent = fake({ fs: files(PI, "pi"), pi: null });
  assert.equal((await hostPluginState(absent.deps as never, "pi", PI)).registration.state, "unavailable");
});
