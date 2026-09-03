# Writing a Claude Code plugin for Jentrix

This guide builds a minimal plugin named **`acme-jentrix`** — one command
and one hook over the Jentrix CLI — installs it beside the official
`jentrix` plugin, tests it, distributes it, updates it and removes it.
The finished plugin is [`examples/acme-claude`](../examples/acme-claude).
Nothing in it touches authentication, scopes, workspace restriction or
anything else the service enforces; a plugin changes what the agent is
asked to do, not what the server will allow.

Prerequisites: Claude Code, Node ≥ 20, the Jentrix CLI installed and signed
in (`npx --yes --package @jentrix/cli@latest jentrix setup`, or `npm i -g
@jentrix/cli && jentrix login`), and `jentrix session doctor` green.

## 1. The minimal plugin

A Claude Code plugin is a directory. A marketplace is a directory that lists
plugins; the simplest marketplace is the plugin's own directory listing
itself. Pick a name you control — `acme` for the marketplace, `acme-jentrix`
for the plugin. `jentrix` is reserved ([TRADEMARKS.md](../TRADEMARKS.md)).

```
acme-claude/
├── .claude-plugin/
│   ├── marketplace.json     the marketplace "acme", one plugin: acme-jentrix, source "./"
│   └── plugin.json          { name, description, version }
├── commands/
│   └── acme-standup.md      the /acme-standup command (a prompt)
├── hooks/
│   └── hooks.json           optional: lifecycle hooks
├── package.json             the CLI range you tested against
└── README.md
```

`.claude-plugin/plugin.json`:

```json
{
  "name": "acme-jentrix",
  "description": "Acme's workflow for Jentrix: /acme-standup summarises what moved on our boards.",
  "version": "0.1.0"
}
```

`.claude-plugin/marketplace.json`:

```json
{
  "name": "acme",
  "owner": { "name": "Acme" },
  "plugins": [
    { "name": "acme-jentrix", "source": "./", "description": "Acme's standup over the Jentrix CLI." }
  ]
}
```

The `version` is what Claude Code caches by: it copies the plugin into
`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` at install, and
an edit under an unchanged version is invisible to anyone who already
installed it. Bump it with every change.

## 2. A command that calls the CLI

`commands/acme-standup.md` is a prompt with front matter. `allowed-tools`
lets the command run the CLI without a permission prompt for each call;
scope it to `jentrix` and nothing wider.

```markdown
---
description: Acme standup — what moved on our Jentrix boards in the last day
allowed-tools: Bash(jentrix:*)
---

Produce Acme's standup from Jentrix, using ONLY the `jentrix` CLI.
1. `jentrix workspace list --json` — pick the workspace bound to this folder.
2. `jentrix board list --workspace-id <id> --json` — keep TASKS boards.
3. `jentrix task list --board-id <id> --json` per board (follow nextCursor).
4. Group tasks updated in the last 24 h by columnName and print them.
Relay any {"error":{"code":…}} envelope verbatim and stop.
```

Everything the CLI can do is a documented MCP tool: `jentrix --help` lists
the noun–verb tree generated from the contract, `jentrix <noun> <verb>
--help` the flags, and `jentrix tool <name> --args '<json>'` calls any tool
by its contract name. The catalog with every schema is served at
`https://tm.jentrix.ai/api/mcp/contract/bundle` and rendered at
https://tm.jentrix.ai/docs/mcp-tools. Prefer `--json`: the output is stable
and the error envelope (`FORBIDDEN | NOT_FOUND | INVALID_INPUT |
RATE_LIMITED | CONFLICT | INTERNAL`) is machine-readable.

Calling the contract directly instead of the CLI is also supported — the
resource is `https://tm.jentrix.ai/api/mcp` with a bearer token
([docs/contract/oauth.md](./contract/oauth.md)) — but the CLI already does
idempotency keys, `expectedUpdatedAt` freshness, rate-limit waits and
redaction for you, so a plugin normally shells out.

### Failure handling

- The CLI exits non-zero and prints `{"error":{"code","message","hint"}}`.
  Tell the model to relay it and stop; a guessed retry with different ids
  is how a workflow does the wrong thing confidently.
- `RATE_LIMITED` carries `retryAfterSeconds`; the CLI already waits up to
  60 s (`--max-wait`), so a second retry in the prompt is rarely right.
- `CONFLICT` on an update embeds the entity's current state under
  `error.current`; a workflow that updates should read it and merge rather
  than overwrite.
- A token without the needed scope is `FORBIDDEN`. Never ask the user to
  paste a token into the conversation; `jentrix login` is the fix.

## 3. A hook — and the provider's trust step

Hooks are optional. When you add one, keep it read-only, quick, quiet, and
free of credentials ([docs/hooks-security.md](./hooks-security.md)):

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ {
        "type": "command",
        "command": "sh -c 'command -v jentrix >/dev/null 2>&1 || exit 0; jentrix session status 2>/dev/null || true'",
        "timeout": 10
      } ] }
    ]
  }
}
```

Two things to know:

- **Your hooks resolve `jentrix` through PATH.** The absolute-path pin the
  official installer applies is for the official plugin packages only. A
  session launched from a desktop app may not have your shell's PATH, so
  guard with `command -v` and degrade to "no context line" rather than an
  error. (A self-locating hook launcher is a future capability of the
  official client, not something your plugin can borrow today.)
- **Claude Code asks before it runs a plugin's hooks.** When a plugin with
  hooks is installed or updated, Claude Code shows the hook commands and asks
  you to confirm them; Jentrix never pre-trusts them for you. Treat that
  prompt as the moment to read the commands — your users will.

## 4. Local testing

Validate the directory (the same check this repository's CI runs on the
examples; it needs no provider binary), then let Claude Code validate it too:

```bash
node scripts/validate-examples.mjs ./acme-claude          # from a clone of jentrix-au/jentrix
claude plugin validate ./acme-claude
```

Install from the directory as a **second** marketplace and try the command:

```bash
claude plugin marketplace add "$(pwd)/acme-claude"
claude plugin install acme-jentrix@acme
claude plugin list                    # jentrix@jentrix AND acme-jentrix@acme
claude                                # then /acme-standup
```

Both plugins are installed side by side; the official one is untouched and
`jentrix session doctor` still reports its marketplace as Official.
[docs/forks.md](./forks.md) records, per OS, what the provider does about a
command that has the same name in both plugins — give yours a distinct
prefix (`/acme-…`) and the question does not arise.

Iterate: edit, bump `version` in `plugin.json`, `claude plugin marketplace
update acme`, `claude plugin update acme-jentrix@acme`, restart Claude Code.

## 5. Declare the CLI range you tested against

`package.json` at the plugin root, read by `validate-examples.mjs` and by
nothing in the provider:

```json
{
  "name": "acme-jentrix-claude",
  "version": "0.1.0",
  "private": true,
  "peerDependencies": { "@jentrix/cli": ">=0.7.0 <1.0.0" }
}
```

The range is the CLI major you wrote the prompts against. The CLI's own
compatibility with the service is decided at connect time in a fixed order
([docs/compatibility.md](./compatibility.md)); your plugin inherits it and
adds only "which `jentrix` commands and flags I rely on".

## 6. Distribution

Any channel Claude Code's marketplace command accepts:

- **A git repository** — `claude plugin marketplace add acme/claude-plugins`
  (a GitHub `owner/repo`) or any HTTPS git URL. Tag releases
  (`claude plugin tag` creates `acme-jentrix--v0.1.0` from `plugin.json`).
- **A directory** on a shared drive or an internal package your tooling
  unpacks — `claude plugin marketplace add /path`.
- **npm** — publish the directory under your own scope (`@acme/jentrix-plugin`)
  and have your installer unpack it; the provider itself does not install
  from npm.

Whatever the channel, the plugin is installed under **your** marketplace
name, and users trust its hooks at install. Never distribute it as
`jentrix@jentrix`, and say "for Jentrix", not "official Jentrix".

## 7. Update and removal

Update: bump `version` in `plugin.json` (and in `package.json` if you
publish it), push or re-tag, then on each machine
`claude plugin marketplace update acme && claude plugin update acme-jentrix@acme`.
An official update (`npm i -g @jentrix/cli && jentrix plugin install claude`)
never touches your plugin — it repoints only the `jentrix` marketplace.

Removal:

```bash
claude plugin uninstall acme-jentrix@acme
claude plugin marketplace remove acme
```

leaves the official plugin exactly as it was.

## 8. Support boundary

Jentrix supports whether the documented CLI and contract behave; you support
the plugin. When something goes wrong, run the CLI command the plugin runs by
hand with `--json`: a wrong error envelope or a contract mismatch is a Jentrix
bug (file it with `jentrix session doctor` output); a wrong prompt is yours.
