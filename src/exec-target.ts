/**
 * How to actually spawn an executable this CLI resolved off PATH.
 *
 * On macOS/Linux the answer is "as given" and this module is a passthrough.
 * On Windows it is not: every tool the CLI shells out to — `npm`, `claude`,
 * `codex`, `jentrix-runner` — installs as a `.cmd` shim, and since the fix for
 * CVE-2024-27980 (Node 18.20.2 / 20.12.2) `spawn`/`execFile` REFUSE a `.cmd`
 * or `.bat` target with EINVAL unless a shell is involved. The failure is
 * worse than loud: `execFile` reports a spawn error with a STRING `code`
 * (`"EINVAL"`), and a caller reading `typeof code === "number" ? code : 0`
 * scores it as exit 0 — so `jentrix plugin install` on Windows "succeeds"
 * having run nothing at all.
 *
 * `{ shell: true }` is not the fix. Node then builds the command line by
 * joining the arguments with spaces and quoting NOTHING, so the bundled plugin
 * directory under `C:\Users\Jane Doe\AppData\…` arrives as two arguments. The
 * quoting has to happen here, with the line handed to cmd.exe verbatim.
 *
 * Known limit: cmd expands `%NAME%` inside a quoted string and there is no
 * escape for `%` on a command line (`%%` is a batch-file-only convention). No
 * argument this CLI constructs contains one, and a path that does would need
 * the surrounding text to name a real variable to be affected.
 */

/** Extensions Windows can only run through a command interpreter. */
const INTERPRETED = /\.(cmd|bat)$/i;

export interface ExecTarget {
  file: string;
  args: string[];
  /** Spread into the `spawn` / `execFile` options. */
  options: { windowsVerbatimArguments?: true };
}

/**
 * cmd's own escape inside a quoted string is a DOUBLED quote; spaces, `&`,
 * `|`, `^` and friends are already literal there, so quoting is all it takes.
 */
export function quoteForCmd(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

/**
 * Resolve `file`/`args` into what should actually be handed to `spawn` or
 * `execFile`. `platform` and `comSpec` are parameters so the Windows branch is
 * testable from any host.
 */
export function execTarget(
  file: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  comSpec: string | undefined = process.env.ComSpec,
): ExecTarget {
  if (platform !== "win32" || !INTERPRETED.test(file)) {
    return { file, args: [...args], options: {} };
  }
  const line = [file, ...args].map(quoteForCmd).join(" ");
  return {
    file: comSpec || "cmd.exe",
    // `/d` skips any AutoRun command the machine has registered; `/s` makes cmd
    // strip exactly the outer quote pair and take the rest verbatim, which is
    // the only form that survives a quoted program path.
    args: ["/d", "/s", "/c", `"${line}"`],
    options: { windowsVerbatimArguments: true },
  };
}

/**
 * How to hand a URL to the platform's default browser.
 *
 * Windows has no browser-opening executable — the opener is `start`, a cmd
 * BUILTIN, so cmd parses the URL no matter what. That is the whole bug this
 * exists for: `spawn("cmd", ["/c", "start", "", url])` looks safe, but Node
 * only quotes an argument containing a space, tab or quote, and an OAuth
 * authorize URL contains none of those — it contains `&`. The URL therefore
 * reaches cmd bare, cmd reads `&` as a command separator, and the browser gets
 * only the text before the FIRST `&`. For `jentrix login` that is
 * `?response_type=code` alone: every other parameter is parsed as a separate
 * command and discarded, and the server answers "client_id and redirect_uri
 * are required" for a request that had both.
 *
 * Quoting the URL fixes it — inside a cmd quoted string `&` is literal.
 *
 * The `""` before the URL is `start`'s title argument, which is not optional
 * here: `start` treats a leading QUOTED token as the window title, so without
 * it the quoted URL would be consumed as a title and nothing would open.
 *
 * On `%`: cmd expands `%NAME%` inside quoted strings, and percent-encoded URLs
 * are full of `%`. This is safe because an UNDEFINED variable is left literal
 * on a command line (unlike inside a batch file, where it expands to empty),
 * and `%3A`-style encodings do not name real variables.
 */
export function browserTarget(
  url: string,
  platform: NodeJS.Platform = process.platform,
  comSpec: string | undefined = process.env.ComSpec,
): ExecTarget {
  if (platform === "darwin") return { file: "open", args: [url], options: {} };
  if (platform !== "win32") {
    return { file: "xdg-open", args: [url], options: {} };
  }
  return {
    file: comSpec || "cmd.exe",
    args: ["/d", "/s", "/c", `"start "" ${quoteForCmd(url)}"`],
    options: { windowsVerbatimArguments: true },
  };
}
