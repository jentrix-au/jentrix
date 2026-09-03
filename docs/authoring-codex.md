# Writing a Codex plugin for Jentrix

This guide builds a minimal plugin named **`acme-jentrix`** — one skill and
one hook over the Jentrix CLI — installs it beside the official `jentrix`
plugin, tests it, distributes it, updates it and removes it. The finished
plugin is [`examples/acme-codex`](../examples/acme-codex). Nothing in it
touches authentication, scopes, workspace restriction or anything else the
service enforces; a plugin changes what the agent is asked to do, not what
the server will allow.

Prerequisites: Codex CLI, Node ≥ 20, the Jentrix CLI installed and signed in
(`npx --yes --package @jentrix/cli@latest jentrix setup`, or `npm i -g
@jentrix/cli && jentrix login`), and `jentrix session doctor` green.

## 1. The minimal plugin

A Codex marketplace is a directory with `.agents/plugins/marketplace.json`
listing plugins; each plugin is a directory with `.codex-plugin/plugin.json`
and a `skills/` folder. Pick a name you control — `acme` for the
marketplace, `acme-jentrix` for the plugin. `jentrix` is reserved
([TRADEMARKS.md](../TRADEMARKS.md)).

```
acme-codex/
├── .agents/plugins/
│   └── marketplace.json                 the marketplace "acme", one local plugin
├── plugins/acme-jentrix/
│   ├── .codex-plugin/plugin.json        { name, version, description, skills, interface }
│   ├── skills/acme-standup/SKILL.md     the $acme-standup skill
│   └── hooks/hooks.json                 optional: lifecycle hooks
├── package.json                         the CLI range you tested against
└── README.md
```

`.agents/plugins/marketplace.json`:

```json
{
  "name": "acme",
  "interface": { "displayName": "Acme" },
  "plugins": [
    {
      "name": "acme-jentrix",
      "source": { "source": "local", "path": "./plugins/acme-jentrix" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
      "category": "Productivity"
    }
  ]
}
```

`plugins/acme-jentrix/.codex-plugin/plugin.json`:

```json
{
  "name": "acme-jentrix",
  "version": "0.1.0",
  "description": "Acme's workflow for Jentrix: the $acme-standup skill summarises what moved on our boards.",
  "author": { "name": "Acme" },
  "license": "MIT",
  "skills": "./skills/",
  "interface": { "displayName": "Acme for Jentrix", "shortDescription": "Acme's standup over Jentrix.", "category": "Productivity", "capabilities": ["Interactive"] }
}
```

The `version` is what Codex caches by; an edit under an unchanged version is
invisible to anyone who already installed the plugin. Bump it with every
change.

## 2. A skill that calls the CLI

`skills/acme-standup/SKILL.md` — front matter with `name` (equal to the
directory name) and `description`, then the instructions:

```markdown
---
name: acme-standup
description: Acme standup — what moved on our Jentrix boards in the last day.
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

Codex can also reach the contract directly as an MCP server — `jentrix
setup` writes the `jentrix` entry into Codex's MCP configuration, with OAuth
through dynamic client registration ([docs/contract/oauth.md](./contract/oauth.md))
— so a skill may say "use the jentrix MCP tools" instead of shelling out.
The CLI path adds idempotency keys, `expectedUpdatedAt` freshness,
rate-limit waits and redaction; the MCP path is the raw contract. Pick one
per skill and say which.

### Failure handling

- The CLI exits non-zero and prints `{"error":{"code","message","hint"}}`.
  Tell the model to relay it and stop; a guessed retry with different ids
  is how a workflow does the wrong thing confidently.
- `RATE_LIMITED` carries `retryAfterSeconds`; the CLI already waits up to
  60 s (`--max-wait`).
- `CONFLICT` on an update embeds the entity's current state under
  `error.current`; read it and merge rather than overwrite.
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
  official installer applies is for the official plugin packages only.
  Guard with `command -v` and degrade to "no context line" rather than an
  error. (A self-locating hook launcher is a future capability of the
  official client, not something your plugin can borrow today.)
- **Codex keeps a plugin's hooks inactive until you trust them.** Inside a
  Codex task, `/hooks` lists the hook commands per plugin and lets you
  enable them; Jentrix never pre-trusts them for you. Treat that list as the
  moment to read the commands — your users will.

## 4. Local testing

Validate the directory (the same check this repository's CI runs on the
examples; it needs no provider binary):

```bash
node scripts/validate-examples.mjs ./acme-codex          # from a clone of jentrix-au/jentrix
```

Install from the directory as a **second** marketplace and try the skill:

```bash
codex plugin marketplace add "$(pwd)/acme-codex"
codex plugin add acme-jentrix@acme
codex plugin list --json              # jentrix@jentrix AND acme-jentrix@acme
codex                                 # /hooks to trust the hook, then $acme-standup
```

Both plugins are installed side by side; the official one is untouched and
`jentrix session doctor` still reports its marketplace as Official.
[docs/forks.md](./forks.md) records, per OS, what Codex does about a skill
that has the same name in both plugins — give yours a distinct prefix
(`acme-…`) and the question does not arise.

Iterate: edit, bump `version` in `plugin.json`, `codex plugin remove
acme-jentrix && codex plugin add acme-jentrix@acme` (a local marketplace is
re-read on add; a git one needs `codex plugin marketplace upgrade` first).

## 5. Declare the CLI range you tested against

`package.json` at the marketplace root, read by `validate-examples.mjs` and
by nothing in the provider:

```json
{
  "name": "acme-jentrix-codex",
  "version": "0.1.0",
  "private": true,
  "peerDependencies": { "@jentrix/cli": ">=0.7.0 <1.0.0" }
}
```

The range is the CLI major you wrote the skills against. The CLI's own
compatibility with the service is decided at connect time in a fixed order
([docs/compatibility.md](./compatibility.md)); your plugin inherits it and
adds only "which `jentrix` commands and flags I rely on".

## 6. Distribution

Any source Codex's marketplace command accepts: a local path, a GitHub
`owner/repo[@ref]`, or an HTTPS/SSH git URL —
`codex plugin marketplace add acme/codex-plugins@v0.1.0`. Tag releases in
git; users refresh a git marketplace with `codex plugin marketplace
upgrade`. Publishing the directory to npm under your own scope
(`@acme/jentrix-plugin`) works when your own tooling unpacks it; Codex does
not install from npm itself.

Whatever the channel, the plugin is installed under **your** marketplace
name, and users trust its hooks with `/hooks`. Never distribute it as
`jentrix@jentrix`, and say "for Jentrix", not "official Jentrix".

## 7. Update and removal

Update: bump `version` in `plugin.json`, push or re-tag, then on each machine
`codex plugin marketplace upgrade` (git sources) and reinstall the plugin.
An official update (`npm i -g @jentrix/cli && jentrix plugin install codex`)
never touches your plugin — it repoints only the `jentrix` marketplace.

Removal:

```bash
codex plugin remove acme-jentrix
codex plugin marketplace remove acme
```

leaves the official plugin exactly as it was.

## 8. Support boundary

Jentrix supports whether the documented CLI and contract behave; you support
the plugin. When something goes wrong, run the CLI command the skill runs by
hand with `--json`: a wrong error envelope or a contract mismatch is a Jentrix
bug (file it with `jentrix session doctor` output); a wrong prompt is yours.
