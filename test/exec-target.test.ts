import assert from "node:assert/strict";
import test from "node:test";

import { browserTarget, execTarget } from "../src/exec-target";

test("posix spawns exactly what it was given", () => {
  const target = execTarget("/usr/local/bin/npm", ["install", "-g"], "linux");
  assert.deepEqual(target, {
    file: "/usr/local/bin/npm",
    args: ["install", "-g"],
    options: {},
  });
  assert.deepEqual(
    execTarget("/opt/homebrew/bin/claude", ["plugin", "list"], "darwin").file,
    "/opt/homebrew/bin/claude",
  );
});

test("posix leaves a .cmd name alone — the shim rule is Windows-only", () => {
  // A file that merely ends in .cmd on Linux is an ordinary executable.
  const target = execTarget("/tmp/weird.cmd", ["--json"], "linux");
  assert.equal(target.file, "/tmp/weird.cmd");
  assert.deepEqual(target.args, ["--json"]);
});

test("windows spawns a real executable directly", () => {
  const target = execTarget(
    "C:\\Program Files\\nodejs\\node.exe",
    ["-v"],
    "win32",
    "C:\\Windows\\system32\\cmd.exe",
  );
  assert.equal(target.file, "C:\\Program Files\\nodejs\\node.exe");
  assert.deepEqual(target.args, ["-v"]);
  assert.deepEqual(target.options, {});
});

test("windows routes a .cmd shim through cmd.exe, quoted", () => {
  // The regression this exists for: `npm`, `claude`, `codex` and the runner all
  // install as .cmd shims, and Node refuses to spawn one directly (EINVAL).
  const target = execTarget(
    "C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\npm.cmd",
    ["install", "-g", "@jentrix/cli"],
    "win32",
    "C:\\Windows\\system32\\cmd.exe",
  );
  assert.equal(target.file, "C:\\Windows\\system32\\cmd.exe");
  assert.deepEqual(target.args, [
    "/d",
    "/s",
    "/c",
    '""C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\npm.cmd" "install" "-g" "@jentrix/cli""',
  ]);
  assert.equal(target.options.windowsVerbatimArguments, true);
});

test("windows quotes .bat the same way, and keeps the space in an argument", () => {
  // `shell: true` would re-split this argument on its space — the whole reason
  // the command line is built here instead.
  const target = execTarget(
    "C:\\tools\\stacks-runner.BAT",
    ["session-run", "--plan-file", "C:\\Users\\Jane Doe\\plan 1.json"],
    "win32",
    "C:\\Windows\\system32\\cmd.exe",
  );
  assert.equal(target.file, "C:\\Windows\\system32\\cmd.exe");
  assert.equal(
    target.args[3],
    '""C:\\tools\\stacks-runner.BAT" "session-run" "--plan-file" "C:\\Users\\Jane Doe\\plan 1.json""',
  );
});

test("windows doubles an embedded quote rather than ending the token", () => {
  const target = execTarget(
    "C:\\tools\\x.cmd",
    ['say "hi"'],
    "win32",
    "C:\\Windows\\system32\\cmd.exe",
  );
  assert.equal(target.args[3], '""C:\\tools\\x.cmd" "say ""hi""""');
});

test("windows falls back to cmd.exe when ComSpec is unset", () => {
  const target = execTarget("C:\\tools\\x.cmd", [], "win32", undefined);
  assert.equal(target.file, "cmd.exe");
});

// --- browserTarget ---------------------------------------------------------
// Regression: `jentrix login` on Windows opened the browser at the authorize
// URL truncated to its first query parameter, and the server answered
// "client_id and redirect_uri are required" for a request that carried both.

const AUTHORIZE_URL =
  "https://stacks-mvp.vercel.app/oauth/authorize?response_type=code" +
  "&client_id=https%3A%2F%2Fstacks-mvp.vercel.app%2Foauth%2Fstacks-cli.json" +
  "&redirect_uri=http%3A%2F%2F127.0.0.1%3A8976%2Fcallback" +
  "&scope=read+write&state=RUTwq9cVqNzOXwnP3BFoEuv4A8PXvFmuQPt2ka5hb84" +
  "&code_challenge=11Nod9ly9MB7TwnsYwRUL3HIp6VElDo8-W_RhEnhTOw" +
  "&code_challenge_method=S256";

test("browser: posix hands the URL to the opener untouched", () => {
  assert.deepEqual(browserTarget(AUTHORIZE_URL, "linux"), {
    file: "xdg-open",
    args: [AUTHORIZE_URL],
    options: {},
  });
  assert.deepEqual(browserTarget(AUTHORIZE_URL, "darwin"), {
    file: "open",
    args: [AUTHORIZE_URL],
    options: {},
  });
});

test("browser: windows quotes the URL so `&` cannot split the command", () => {
  const target = browserTarget(
    AUTHORIZE_URL,
    "win32",
    "C:\\Windows\\system32\\cmd.exe",
  );
  assert.equal(target.file, "C:\\Windows\\system32\\cmd.exe");
  assert.deepEqual(target.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(target.options.windowsVerbatimArguments, true);

  // The whole URL sits inside ONE quoted token — this is the actual fix.
  assert.equal(target.args[3], `"start "" "${AUTHORIZE_URL}""`);

  // And every parameter that used to be eaten is still present.
  for (const param of [
    "client_id",
    "redirect_uri",
    "scope",
    "state",
    "code_challenge",
    "code_challenge_method",
  ]) {
    assert.ok(
      target.args[3].includes(`&${param}=`),
      `${param} must survive cmd quoting`,
    );
  }
});

test("browser: the pre-fix argv is what truncated the URL", () => {
  // Node quotes an argument only when it holds a space, tab or quote. The
  // authorize URL holds none, so the old `["/c", "start", "", url]` reached
  // cmd unquoted and everything from the first `&` on became new commands.
  assert.ok(!/[ \t"]/.test(AUTHORIZE_URL));
  const reachesBrowser = AUTHORIZE_URL.split("&")[0];
  assert.equal(
    reachesBrowser,
    "https://stacks-mvp.vercel.app/oauth/authorize?response_type=code",
  );
});

test("browser: an embedded quote is doubled, not left to break the string", () => {
  const target = browserTarget('https://x.test/?q="hi"', "win32", "cmd.exe");
  assert.equal(target.args[3], '"start "" "https://x.test/?q=""hi""""');
});

test("browser: windows falls back to cmd.exe when ComSpec is unset", () => {
  assert.equal(
    browserTarget("https://x.test/", "win32", undefined).file,
    "cmd.exe",
  );
});
