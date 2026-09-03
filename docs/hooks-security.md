# Hooks and the trust model

Both official plugins ship **hooks**: commands the coding agent runs at
lifecycle events (session start and end, prompt submit, tool use, compaction).
They are what binds a Claude Code or Codex session to a Jentrix session so the
work is recorded against the right task. A hook runs on your machine with
your user, so the rules below are the security model, not style.

## What the hooks are

Every hook command in `plugins/claude/hooks/hooks.json` and
`plugins/codex/plugins/jentrix/hooks/hooks.json` is one of two verbs:

- `jentrix-session-host hook --provider <claude|codex> --event <Event>` — the
  session host reads the provider's structured payload on **stdin**
  (session id, transcript path, working directory) and appends it to the
  local session context under your config directory. Nothing else travels.
- `jentrix session snapshot --event <PreCompact|PostCompact>` — preserves the
  capture boundary before the provider compacts its context, following the
  capture consent you gave at connect time (capture off records the boundary
  and no content).

The argument list is the whole story: a provider name and an event name.
**No credential, no transcript content, no path to a secret ever appears in
a hook argument**, and the CLI never writes one there. Compaction-path hooks
carry an explicit timeout of a few seconds so a slow push cannot stall your
`/compact`.

## The absolute-path pin

`jentrix plugin install <provider>` rewrites each hook command in the
installed plugin package from the bare form to an absolute one:

```
"/usr/local/bin/node" "/usr/local/lib/node_modules/@jentrix/cli/dist/session-host-main.js" hook --provider claude --event SessionStart
```

App-launched sessions (a desktop app, an IDE extension) often start without
the shell's PATH; the pin is what makes the hooks resolve there. It keys on
the verb (`hook` / `session`), so re-running the install after an upgrade or
a Node version switch rewrites the pin idempotently. The pin points at the
CLI package that owns the install, never at the plugin package, and it is
the **only** difference permitted between the published plugin artifact and
the installed copy (PRD §7, D12 — integrity is transformation-aware; no byte
equality is claimed after the rewrite). `jentrix session doctor` reports the
pinned target and whether the provider's cached copy of the hooks matches
the package's; a difference means new sessions run the cache, and the fix is
to run the install again.

The pin is applied only to the official plugin packages. A customer plugin's
hooks resolve `jentrix` through PATH; see the authoring guides for the
`command -v` guard and the known limitation for app-launched sessions.

## The provider's trust step is preserved

Installation never bypasses the provider's own consent — and the two
providers place that consent differently (observed on macOS, 2026-09-03;
[forks.md](./forks.md) carries the matrix):

- **Claude Code (2.1.251)** runs a plugin's hooks once the plugin is
  installed and enabled; in our probe no separate prompt was shown at
  install or at the first session, and a hook exceeding its `timeout` was
  killed. **The install is the trust decision**: `jentrix plugin install
  claude` runs `claude plugin install jentrix@jentrix` for the official
  plugin, and you install a third-party plugin only after reading its
  `hooks/hooks.json`.
- **Codex** keeps a plugin's hooks inactive until you review and trust them
  with `/hooks` inside a Codex task; the probe plugin's hooks did not run
  until then.

Jentrix never auto-trusts a customer plugin's hooks, never hides a hook
command, and never treats a hook's output as server authority: the hosted
service re-checks authorization, tenancy, idempotency and rate limits on
every request whatever the client said. A modified hook or a modified
session host cannot imply Jentrix-verified evidence — the service records
what it received and from which token, and diagnostics label a marketplace
that the official CLI did not write as **user-managed**.

## Reviewing a plugin's hooks before you trust them

Before trusting any plugin's hooks — ours or a third party's — read the
hooks file and check:

1. **Each command is a program you recognise**, invoked with literal
   arguments. Be suspicious of `curl | sh`, of anything that reads
   environment variables to build a URL, and of arguments that look like
   tokens or file paths under your home directory.
2. **No secret is passed as an argument.** Anything a hook needs must come
   from the tool's own configuration (the Jentrix CLI reads its credential
   from `jentrix login` or `STACKS_TOKEN`, never from argv).
3. **There is a timeout** on every hook, and it is short (seconds).
4. **The hook is idempotent and quiet.** Lifecycle events fire often; a hook
   that prompts, blocks, or exits non-zero on a missing precondition breaks
   the session. Ours exit 0 and log locally when there is nothing to do.
5. **You can find the source.** For the official plugins it is this
   repository; for a customer plugin, the publisher's. A hook whose command
   you cannot read is a hook you should not trust.

## What the doctor checks

```
jentrix session doctor
```

reports, per provider: the plugin package version and install source, the
marketplace ownership (Official / Official (stale copy) / User-managed /
Unregistered / Unknown), the number of hook commands and the absolute target
they are pinned to, and whether the provider's cached copy matches. It
uploads nothing. `jentrix session doctor --bundle` writes the same facts to
a redacted file for a support request — no tokens, no transcript content, no
hook bodies, no file contents.

## Reporting

A hook that violates any rule above — in the official plugins, the
installer, or the session host — is a vulnerability. Report it privately:
[SECURITY.md](../SECURITY.md).
