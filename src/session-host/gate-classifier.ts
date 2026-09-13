/**
 * R03 / F01 — the GATE CLASSIFIER shared by the CLI (the `--from-cmd`
 * verification receipt) and the server (evidence-floor E4). PURE, dependency
 * free and MIRRORED byte for byte: jentrix-au/jentrix
 * `src/session-host/gate-classifier.ts` ↔ task-manager
 * `src/lib/gate-classifier.ts`, pinned by the same corpus test on each side.
 *
 * A command counts as a gate only when it BINDS to a definition:
 *   • a reviewed wrapper — an exact line of the checkout's `.jentrix/gates.json`;
 *   • a package script — `pnpm|npm|yarn|bun [run] <name>` resolved against the
 *     package.json the command ran in. The family comes from the script NAME
 *     (`test:mvp` → test, `typecheck` → typecheck, `test:e2e` → e2e) and the
 *     script's body is recorded (text + sha256) so a verifier can check the
 *     definition at that revision; a body that only echoes, exits or evaluates
 *     inline code (`node -e …`) is refused;
 *   • a known runner binary whose family is fixed by the runner itself —
 *     `vitest`, `jest`, `tsc`, `eslint`, `playwright test`, `node --test`, …
 * Families are NEVER read off arbitrary words of the line.
 *
 * The line is read by a small SHELL LEXER that fails CLOSED (2026-09-13
 * review, F01): quoting and backslashes are honoured; `&&` chains; every other
 * operator — `||`, `|`, `|&`, `;`, `&`, newlines, `(`/`)`/`{`/`}` grouping,
 * `$( )` and backtick substitution, `!` negation, line continuations — refuses
 * the line whether or not it is surrounded by spaces (`… ||true`, `…|cat` were
 * the review's reproductions). Redirections (`2>&1`, `>out.txt`) are dropped:
 * they change no exit status. A command that changes the execution directory
 * (`cd`, `pushd`, `popd`, a package manager's `--prefix`/`-C`/`--filter`) or
 * reaches outside the checkout (an absolute or `..`/`~` path argument) is
 * refused, so a receipt taken in checkout A cannot describe a gate that ran in
 * B (F02a). A help/version/listing invocation (`--help`, `--version`,
 * `--listTests`, `--collect-only`, `--dry-run`, …) runs no gate and is refused.
 * `bash|sh|zsh -c "<one line>"` unwraps one level through the same lexer.
 */

export const GATE_FAMILIES = ["typecheck", "lint", "test", "e2e"] as const;
export type GateFamily = (typeof GATE_FAMILIES)[number];

/** A reviewed wrapper definition from `<checkout>/.jentrix/gates.json`. */
export interface ReviewedGate {
  id: string;
  command: string;
  families: GateFamily[];
}

/**
 * How a caller resolves `<manager> run <name>` to its definition:
 *   `{ body }` — the script exists (its package.json body);
 *   `null`     — the package.json declares no such script (refused);
 *   `undefined`— no package.json could be read at all. Only the server's
 *                LEGACY path (a `$ cmd` LOG with no receipt) uses this: the
 *                name then classifies alone and `scriptResolved` is false —
 *                the evidence floor never lets such a gate cover a known
 *                candidate (it carries no revision either).
 */
export type ScriptResolver = (
  manager: string,
  name: string,
) => { body: string } | null | undefined;

export interface GateContext {
  reviewed?: ReviewedGate[];
  resolveScript?: ScriptResolver;
}

/** One package-script binding the classification rests on. */
export interface GateScriptBinding {
  manager: string;
  name: string;
  /** The script body, when resolved; null on the legacy name-only path. */
  body: string | null;
}

export interface GateClassification {
  /** The executable of the first segment (env prefixes skipped). */
  executable: string | null;
  allowlisted: boolean;
  /** Families the command covers — empty unless allowlisted. */
  families: GateFamily[];
  /** The reviewed wrapper id, when that route matched. */
  gateId: string | null;
  /** Which definition(s) the verdict rests on. */
  source: "reviewed" | "script" | "runner" | "mixed" | null;
  scripts: GateScriptBinding[];
  /** False when a script route ran with no package.json to resolve against. */
  scriptResolved: boolean;
  /** Why the command is NOT allowlisted; null when it is. */
  reason: string | null;
}

// ---------------------------------------------------------------------------
// Shell lexer — fail closed
// ---------------------------------------------------------------------------

type ShellToken =
  | { kind: "word"; text: string; quoted: boolean }
  | { kind: "and" }
  | { kind: "redirect"; takesTarget: boolean };

interface LexResult {
  tokens: ShellToken[];
  /** The construct that refuses the line, or null. */
  refusal: string | null;
}

/**
 * Tokenize one shell line. Anything the classifier cannot reason about
 * refuses the whole line here — never "best effort": a construct the lexer
 * skipped would be a construct the exit status could hide behind.
 */
export function lexShellLine(line: string): LexResult {
  const tokens: ShellToken[] = [];
  let word = "";
  let quoted = false;
  let open = false;
  const refuse = (what: string): LexResult => ({ tokens: [], refusal: what });
  const flush = (): void => {
    if (open) tokens.push({ kind: "word", text: word, quoted });
    word = "";
    quoted = false;
    open = false;
  };
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return refuse("an unterminated single quote");
      word += line.slice(i + 1, end);
      quoted = true;
      open = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      i += 1;
      let closed = false;
      while (i < line.length) {
        const d = line[i]!;
        if (d === '"') {
          closed = true;
          i += 1;
          break;
        }
        if (d === "\\" && i + 1 < line.length) {
          word += line[i + 1];
          i += 2;
          continue;
        }
        if (d === "`") return refuse("command substitution (`…`)");
        if (d === "$" && line[i + 1] === "(") return refuse("command substitution ($(…))");
        word += d;
        i += 1;
      }
      if (!closed) return refuse("an unterminated double quote");
      quoted = true;
      open = true;
      continue;
    }
    if (c === "\\") {
      if (i + 1 >= line.length) return refuse("a trailing backslash");
      if (line[i + 1] === "\n") return refuse("a line continuation");
      word += line[i + 1];
      open = true;
      i += 2;
      continue;
    }
    if (c === "`") return refuse("command substitution (`…`)");
    if (c === "$" && line[i + 1] === "(") return refuse("command substitution ($(…))");
    if (c === "(" || c === ")") return refuse("a subshell (parentheses)");
    if (c === "{" || c === "}") return refuse("brace grouping or expansion");
    if (c === "\n" || c === "\r") return refuse("a newline (a second command)");
    if (c === ";") return refuse("`;`");
    if (c === "&") {
      if (line[i + 1] === "&") {
        flush();
        tokens.push({ kind: "and" });
        i += 2;
        continue;
      }
      if (line[i + 1] === ">") {
        flush();
        i += line[i + 2] === ">" ? 3 : 2;
        tokens.push({ kind: "redirect", takesTarget: true });
        continue;
      }
      return refuse("`&` (a background job)");
    }
    if (c === "|") {
      if (line[i + 1] === "|") return refuse("`||`");
      if (line[i + 1] === "&") return refuse("`|&`");
      return refuse("`|` (a pipe)");
    }
    if (c === "<" || c === ">") {
      // A glued file descriptor (`2>&1`) belongs to the redirection, not to
      // the argument list.
      if (open && !quoted && /^\d+$/.test(word)) {
        word = "";
        open = false;
      } else {
        flush();
      }
      let j = i;
      while (j < line.length && (line[j] === "<" || line[j] === ">")) j += 1;
      let takesTarget = true;
      if (line[j] === "&") {
        j += 1;
        const dup = /^(\d+|-)/.exec(line.slice(j));
        if (dup) {
          j += dup[0].length;
          takesTarget = false;
        }
      } else if (line[j] === "|") {
        j += 1;
      }
      tokens.push({ kind: "redirect", takesTarget });
      i = j;
      continue;
    }
    if (c === " " || c === "\t") {
      flush();
      i += 1;
      continue;
    }
    if (c === "#" && !open) break; // a comment runs to the end of the line
    if (c === "!" && !open) return refuse("`!` (exit-status negation)");
    word += c;
    open = true;
    i += 1;
  }
  flush();
  return { tokens, refusal: null };
}

/** Split lexed tokens into `&&` segments, dropping redirections and their targets. */
function segmentsOf(tokens: ShellToken[]): Array<Array<{ text: string; quoted: boolean }>> {
  const segments: Array<Array<{ text: string; quoted: boolean }>> = [[]];
  let dropNext = false;
  for (const token of tokens) {
    if (token.kind === "and") {
      segments.push([]);
      dropNext = false;
      continue;
    }
    if (token.kind === "redirect") {
      dropNext = token.takesTarget;
      continue;
    }
    if (dropNext) {
      dropNext = false;
      continue;
    }
    segments[segments.length - 1]!.push({ text: token.text, quoted: token.quoted });
  }
  return segments.filter((segment) => segment.length > 0);
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);
const EXEC_SHIMS = new Set(["npx", "bunx", "pnpx"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);
const DIRECTORY_CHANGERS = new Set(["cd", "pushd", "popd", "chdir"]);

/** Runner binaries and the family each invocation names (null = not a gate). */
const RUNNERS: Partial<Record<string, (args: string[]) => GateFamily | null>> = {
  vitest: () => "test",
  jest: () => "test",
  mocha: () => "test",
  ava: () => "test",
  pytest: () => "test",
  rspec: () => "test",
  tsc: () => "typecheck",
  mypy: () => "typecheck",
  pyright: () => "typecheck",
  eslint: () => "lint",
  node: (args) => (args.includes("--test") ? "test" : null),
  playwright: (args) => (args[0] === "test" ? "e2e" : null),
  cypress: (args) => (args[0] === "run" ? "e2e" : null),
  ruff: (args) => (args[0] === "check" ? "lint" : null),
  biome: (args) => (args[0] === "check" || args[0] === "lint" ? "lint" : null),
  prettier: (args) => (args.includes("--check") ? "lint" : null),
  go: (args) => (args[0] === "test" ? "test" : args[0] === "vet" ? "lint" : null),
  cargo: (args) =>
    args[0] === "test" ? "test" : args[0] === "clippy" ? "lint" : args[0] === "check" ? "typecheck" : null,
  deno: (args) =>
    args[0] === "test" ? "test" : args[0] === "lint" ? "lint" : args[0] === "check" ? "typecheck" : null,
  bun: (args) => (args[0] === "test" ? "test" : null),
  dotnet: (args) => (args[0] === "test" ? "test" : null),
  mix: (args) => (args[0] === "test" ? "test" : null),
  swift: (args) => (args[0] === "test" ? "test" : null),
  python: (args) => (args[0] === "-m" && args[1] ? (RUNNERS[args[1]]?.(args.slice(2)) ?? null) : null),
  python3: (args) => (args[0] === "-m" && args[1] ? (RUNNERS[args[1]]?.(args.slice(2)) ?? null) : null),
  uv: (args) => (args[0] === "run" && args[1] ? (RUNNERS[args[1]]?.(args.slice(2)) ?? null) : null),
};

/** Executables where `-v` means verbose, not version. */
const VERBOSE_V = new Set(["pytest", "go", "cargo", "python", "python3", "uv", "mypy"]);
/** Flags/subcommands under which a runner or script prints and exits — no gate ran. */
const NON_EXECUTING = new Set([
  "-h", "--help", "-?", "help", "--version", "version", "-V",
  "--list", "--listTests", "--list-tests", "--collect-only", "--co", "--dry-run", "--dryRun",
  "--showConfig", "--show-config", "--print-config", "--init", "--info", "--debug-check",
]);
/** Package-manager flags that move execution to another directory or package. */
const SCOPE_CHANGERS = new Set([
  "--prefix", "-C", "--dir", "--cwd", "-w", "--workspace", "--workspaces", "-ws", "--filter", "-r",
  "--recursive", "--parallel", "-F", "--stream", "--if-present",
]);

/** Script bodies that prove nothing on their own. */
const TRIVIAL_EXECUTABLES = new Set(["echo", "true", "false", "exit", ":", "printf", "cat", "test", "[", "sleep"]);
/** Executables whose inline-evaluation flag turns the body into arbitrary code. */
const INLINE_EVAL: Record<string, RegExp> = {
  node: /^(-e|--eval|-p|--print)$/,
  deno: /^eval$/,
  python: /^-c$/,
  python3: /^-c$/,
  ruby: /^-e$/,
  perl: /^-e$/,
  php: /^-r$/,
  bash: /^-c$/,
  sh: /^-c$/,
  zsh: /^-c$/,
};

/** Strip `ENV=val` prefixes; return the executable + args. */
function commandWords(words: Array<{ text: string; quoted: boolean }>): {
  executable: string | null;
  args: string[];
} {
  let i = 0;
  while (i < words.length && !words[i]!.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!.text)) i += 1;
  const head = words[i];
  if (!head) return { executable: null, args: [] };
  return { executable: head.text.split("/").pop() ?? head.text, args: words.slice(i + 1).map((w) => w.text) };
}

/** The family a package-script NAME declares; e2e beats test (`test:e2e`). */
export function familyOfScriptName(name: string): GateFamily | null {
  const tokens = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.includes("e2e")) return "e2e";
  if (tokens.includes("typecheck") || tokens.includes("tsc") || tokens.includes("types")) return "typecheck";
  if (tokens.includes("lint")) return "lint";
  if (tokens.includes("test") || tokens.includes("tests")) return "test";
  return null;
}

/**
 * Why a package-script BODY cannot stand as a gate definition, or null. The
 * body is committed code, so composition inside it is the repository's
 * business; what is refused is a body with no substantive command at all —
 * only echoes/exits, or only inline evaluation (`node -e …`).
 */
export function scriptBodyProblem(body: string): string | null {
  const text = body.trim();
  if (!text) return "the script body is empty";
  let substantive = 0;
  for (const segment of text.split(/\s*(?:&&|\|\||;|\|)\s*/)) {
    const words = (segment.match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g) ?? []).map((t) => ({
      text: t.replace(/^["']|["']$/g, ""),
      quoted: /^["']/.test(t),
    }));
    const { executable, args } = commandWords(words);
    if (!executable || TRIVIAL_EXECUTABLES.has(executable)) continue;
    const evalFlag = INLINE_EVAL[executable];
    if (evalFlag && args.some((a) => evalFlag.test(a))) continue;
    substantive += 1;
  }
  return substantive === 0
    ? "the script body only echoes, exits or evaluates inline code — it defines no gate"
    : null;
}

type SegmentVerdict =
  | { skip: true }
  | {
      skip?: false;
      executable: string | null;
      allowlisted: boolean;
      families: GateFamily[];
      source: "script" | "runner" | null;
      script?: GateScriptBinding;
      scriptResolved: boolean;
      reason: string | null;
    };

function refuse(executable: string | null, reason: string): SegmentVerdict {
  return { executable, allowlisted: false, families: [], source: null, scriptResolved: true, reason };
}

/** An argument that reaches outside the checkout the receipt is bound to. */
function escapesCheckout(arg: string): boolean {
  const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg;
  for (const part of [arg, value]) {
    if (part.startsWith("/") || part.startsWith("~")) return true;
    if (/(^|[/\\])\.\.([/\\]|$)/.test(part)) return true;
  }
  return false;
}

/** A flag/subcommand that prints and exits (help, version, listing) — no gate ran. */
function nonExecuting(executable: string, args: string[]): string | null {
  for (const arg of args) {
    if (NON_EXECUTING.has(arg)) return arg;
    if (arg === "-v" && !VERBOSE_V.has(executable)) return arg;
  }
  return null;
}

function runnerVerdict(executable: string, args: string[]): SegmentVerdict {
  const runner = RUNNERS[executable];
  const family = runner ? runner(args) : null;
  if (!family) {
    const shown = [executable, args[0]].filter(Boolean).join(" ");
    return refuse(
      executable,
      runner
        ? `\`${shown}\` is not a gate runner — ${executable} counts only as a test/lint/typecheck/e2e runner`
        : `\`${executable}\` is not a gate runner (a package script or a reviewed wrapper binds it)`,
    );
  }
  return { executable, allowlisted: true, families: [family], source: "runner", scriptResolved: true, reason: null };
}

function scriptVerdict(manager: string, name: string, rest: string[], ctx: GateContext): SegmentVerdict {
  if (name.startsWith("-")) {
    return refuse(manager, `\`${manager} ${name}\` puts a flag before the script name — run the script by name (a reviewed wrapper covers the rest)`);
  }
  const mover = rest.find((arg) => SCOPE_CHANGERS.has(arg) || [...SCOPE_CHANGERS].some((f) => arg.startsWith(`${f}=`)));
  if (mover) {
    return refuse(manager, `\`${manager} ${name} … ${mover}\` runs the script in another directory or package — a receipt binds to the checkout it ran in`);
  }
  const family = familyOfScriptName(name);
  if (!family) {
    return refuse(manager, `script "${name}" names no gate family (typecheck | lint | test | e2e) — a reviewed wrapper in .jentrix/gates.json can declare one`);
  }
  const resolved = ctx.resolveScript ? ctx.resolveScript(manager, name) : undefined;
  if (resolved === null) {
    return refuse(manager, `package.json declares no script "${name}"`);
  }
  if (resolved) {
    const problem = scriptBodyProblem(resolved.body);
    if (problem) return refuse(manager, `script "${name}": ${problem}`);
  }
  return {
    executable: manager,
    allowlisted: true,
    families: [family],
    source: "script",
    script: { manager, name, body: resolved ? resolved.body : null },
    scriptResolved: resolved !== undefined,
    reason: null,
  };
}

function classifySegment(words: Array<{ text: string; quoted: boolean }>, ctx: GateContext): SegmentVerdict {
  const { executable, args } = commandWords(words);
  if (!executable) return { skip: true };
  if (DIRECTORY_CHANGERS.has(executable)) {
    return refuse(executable, `\`${executable}\` changes the execution directory — run the gate from the checkout it verifies`);
  }
  if (executable === "env") {
    // `env [-i] [-u NAME]… [NAME=val]… command…` — the same command, same directory.
    let i = 0;
    while (i < args.length) {
      const a = args[i]!;
      if (a === "-i" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) i += 1;
      else if (a === "-u" && args[i + 1]) i += 2;
      else break;
    }
    const inner = args.slice(i);
    if (inner.length === 0) return refuse("env", "`env` alone runs nothing");
    return classifySegment(inner.map((text) => ({ text, quoted: false })), ctx);
  }
  const printsOnly = nonExecuting(executable, args);
  if (printsOnly) {
    return refuse(executable, `\`${executable} … ${printsOnly}\` prints and exits — no gate ran`);
  }
  const outside = args.find(escapesCheckout);
  if (outside) {
    return refuse(executable, `argument \`${outside}\` reaches outside the checkout — a receipt binds only to the tree it ran in`);
  }
  if (EXEC_SHIMS.has(executable)) {
    const [bin, ...rest] = args;
    return bin ? runnerVerdict(bin.split("/").pop() ?? bin, rest) : refuse(executable, `\`${executable}\` names no binary`);
  }
  if (PACKAGE_MANAGERS.has(executable)) {
    const [first, ...rest] = args;
    if (!first) return refuse(executable, `\`${executable}\` alone runs nothing`);
    if (first === "exec" || first === "dlx" || first === "x") {
      const [bin, ...binArgs] = rest;
      return bin ? runnerVerdict(bin.split("/").pop() ?? bin, binArgs) : refuse(executable, `\`${executable} ${first}\` names no binary`);
    }
    if (first === "run" || first === "run-script") {
      return rest[0] ? scriptVerdict(executable, rest[0], rest.slice(1), ctx) : refuse(executable, `\`${executable} run\` names no script`);
    }
    if (executable === "bun") return first === "test" ? runnerVerdict("bun", args) : refuse(executable, "`bun <name>` is not a script invocation — use `bun run <name>` or `bun test`");
    if (executable === "npm") {
      if (first === "test" || first === "t" || first === "tst") return scriptVerdict("npm", "test", rest, ctx);
      return refuse(executable, `\`npm ${first}\` is not a script invocation — use \`npm run <name>\` or \`npm test\``);
    }
    return scriptVerdict(executable, first, rest, ctx);
  }
  return runnerVerdict(executable, args);
}

/**
 * Classify one command line. See the module comment for the three routes and
 * the lexer's refusals. Deterministic; the receipt AND the server call this
 * with the same inputs and must reach the same verdict.
 */
export function classifyGateCommand(command: string, ctx: GateContext = {}): GateClassification {
  const line = command.trim();
  const none: GateClassification = {
    executable: null,
    allowlisted: false,
    families: [],
    gateId: null,
    source: null,
    scripts: [],
    scriptResolved: true,
    reason: "empty command",
  };
  if (!line) return none;
  const reviewed = (ctx.reviewed ?? []).find((gate) => gate.command.trim() === line);
  if (reviewed) {
    const lexed = lexShellLine(line);
    return {
      executable: lexed.refusal ? null : commandWords(segmentsOf(lexed.tokens)[0] ?? []).executable,
      allowlisted: true,
      families: [...new Set(reviewed.families.filter((f) => (GATE_FAMILIES as readonly string[]).includes(f)))],
      gateId: reviewed.id,
      source: "reviewed",
      scripts: [],
      scriptResolved: true,
      reason: null,
    };
  }
  const lexed = lexShellLine(line);
  if (lexed.refusal) {
    return { ...none, reason: `${lexed.refusal} hides or replaces the gate's exit status — chain gates with \`&&\` only, one plain command per segment` };
  }
  const segments = segmentsOf(lexed.tokens);
  if (segments.length === 0) return { ...none, reason: "the command runs nothing" };
  // `bash -c "<one line>"` — the SAME lexer reads the inner line.
  const head = commandWords(segments[0]!);
  if (segments.length === 1 && head.executable && SHELLS.has(head.executable)) {
    if (head.args.length === 2 && head.args[0] === "-c") return classifyGateCommand(head.args[1]!, ctx);
    return { ...none, executable: head.executable, reason: `\`${head.executable}\` runs only as \`${head.executable} -c "<one line>"\`` };
  }
  const verdicts = segments
    .map((words) => classifySegment(words, ctx))
    .filter((v): v is Exclude<SegmentVerdict, { skip: true }> => !("skip" in v && v.skip));
  if (verdicts.length === 0) return { ...none, reason: "the command runs nothing (only env assignments)" };
  const executable = verdicts[0]!.executable;
  const failed = verdicts.find((v) => !v.allowlisted);
  if (failed) {
    return { ...none, executable, reason: failed.reason };
  }
  const families = [...new Set(verdicts.flatMap((v) => v.families))];
  const sources = new Set(verdicts.map((v) => v.source));
  return {
    executable,
    allowlisted: true,
    families,
    gateId: null,
    source: sources.size === 1 ? ([...sources][0] as "script" | "runner") : "mixed",
    scripts: verdicts.flatMap((v) => (v.script ? [v.script] : [])),
    scriptResolved: verdicts.every((v) => v.scriptResolved),
    reason: null,
  };
}
