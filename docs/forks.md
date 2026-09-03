# Forks, composition, and the upstream comparison loop

The official plugins are the shortest path. When your team's process is
different enough that the official commands are in the way, you have two
supported shapes, and one loop that keeps either of them close to upstream.
Neither requires disclosing your workflow content to Jentrix, and neither
changes what the service enforces.

## Compose beside the official plugin (preferred)

Keep `jentrix` installed and unmodified, and install **your own plugin with
its own name** beside it — `acme-jentrix` from a marketplace named `acme`.
Your plugin adds the commands, skills and hooks your process needs and calls
the CLI (`jentrix task …`, `jentrix push …`) or the documented MCP contract.
Official updates keep working: `jentrix plugin install` touches only the
`jentrix` marketplace and the official package.

This is the shape both authoring guides build
([Claude Code](./authoring-claude.md), [Codex](./authoring-codex.md)) and
both reference extensions ship ([`examples/acme-claude`](../examples/acme-claude),
[`examples/acme-codex`](../examples/acme-codex)). It is supported where the
capability spike below proved the provider keeps the two plugins apart.

## A renamed fork (when composition is not enough)

When you need to change what the official commands themselves do — different
prompts, a different checkpoint ritual, a different set of hooks — copy the
official plugin directory into your own repository, **rename it** (the
marketplace name, the plugin name, and every command or skill name that
would collide), pin the CLI range you tested against, and distribute it
through your own channel. Do not install a fork under the name `jentrix`:
the official installer will refuse to repoint that marketplace
(`PLUGIN_MARKETPLACE_CONFLICT`) and `jentrix session doctor` will label it
**user-managed**, which is exactly what the support boundary needs to see.

A fork may say "for Jentrix"; it may not say "official Jentrix"
([TRADEMARKS.md](../TRADEMARKS.md)). Jentrix supports the API boundary under
it — whether the documented CLI and contract behave — and you support the
fork.

## Coexistence matrix (the Phase 0 capability spike)

What each provider does when a differently named plugin is installed beside
the official one. Filled in from an actual run; a cell says "not yet probed"
until a run on that OS is recorded. The macOS column is the run of
2026-09-03 on Claude Code 2.1.251 and Codex CLI 0.147.0 with the official
plugins 0.5.5 / 0.2.8 installed by `jentrix plugin install`, using
`examples/acme-claude` / `examples/acme-codex` plus a throwaway
`acme-collide` plugin that deliberately carries a command and a skill named
`jentrix-status` and two SessionStart hooks (one within its timeout, one
over it).

| Question | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Both plugins listed, no command collision (Claude Code) | **yes** — `claude plugin list` shows `acme-jentrix@acme` 0.1.0 and `acme-collide@acme-collide` 0.0.1 side by side, each cached under its own marketplace (`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>`); the official plugin's marketplace row, enabled state and pinned hooks were untouched throughout (`jentrix session doctor`: Official, 6 commands pinned, cache matches) | not yet probed | not yet probed |
| Same-named command in both: which wins / how it is shown (Claude Code) | **namespaced, no winner needed** — plugin commands resolve as `/<plugin>:<command>`: `/jentrix:jentrix-status` and `/acme-collide:jentrix-status` both resolve; the bare `/jentrix-status` is "Unknown command" in `claude -p` with or without the second plugin. Whether the interactive picker offers a bare alias when the name is unique was not observable here (a nested `claude -p` could not authenticate a model turn). Use a distinct prefix anyway | not yet probed | not yet probed |
| `claude plugin update` touches only its own plugin | **yes** — `claude plugin update acme-jentrix@acme` → "already at the latest version (0.1.0)"; the official plugin unchanged | not yet probed | not yet probed |
| Hook trust prompt shown per plugin; timeout honoured (Claude Code) | **no prompt; timeout enforced** — after `claude plugin install acme-collide@acme-collide` (no message about hooks) the plugin's SessionStart hooks ran in the next `claude -p` session without any trust prompt; the hook within its `timeout: 5` wrote its marker, the hook that sleeps 6 s under `timeout: 2` never did. On 2.1.251 **the install is the trust decision** — read a plugin's hooks before installing it | not yet probed | not yet probed |
| Both plugins listed, no skill collision (Codex) | **yes** — `codex plugin list --json` shows `jentrix@jentrix` 0.2.8, `acme-jentrix@acme` 0.1.0 and `acme-collide@acme-collide` 0.0.1, each with its own source path; `codex plugin marketplace list --json` shows the three marketplaces | not yet probed | not yet probed |
| Same-named skill in both: which wins / how it is shown (Codex) | **the official one won** — `codex exec 'Use the jentrix-status skill now'` used the official skill's text and ran `jentrix session status`; the probe plugin's same-named skill was never used. The tie-break is undocumented (registration order is the likely rule) — use a distinct prefix | not yet probed | not yet probed |
| `codex plugin marketplace upgrade` touches only its own marketplace | **git marketplaces only** — "All configured Git marketplaces are already up to date"; local (directory) marketplaces, the official one included, are not touched | not yet probed | not yet probed |
| Hooks inactive until `/hooks` trust, per plugin; timeout honoured (Codex) | **inactive until trusted** — the probe plugin's SessionStart hooks did not run in `codex exec` (no marker); `/hooks` is interactive, so the timeout arm was not reachable non-interactively | not yet probed | not yet probed |

Two removal facts from the same run: Codex removes a plugin only as
`codex plugin remove <plugin>@<marketplace>` (the bare name errors), and
`codex plugin marketplace remove` leaves the plugin's
`[plugins."…"]` entry in `~/.codex/config.toml` and its cache directory
behind — remove the plugin **before** the marketplace. Claude Code's
`claude plugin uninstall` and `claude plugin marketplace remove` clean
up their own entries; the version cache under `~/.claude/plugins/cache`
stays until deleted.

Windows and Linux are probed in the workspaces named CWP (Claude Code on
Windows), CLP (Claude Code on Linux) and XLP (Codex on Linux); the macOS
column is this repository's own run. Until a column is filled, treat
composition on that OS as unverified and prefer the renamed fork.

## The manual upstream comparison loop

There is no automatic merge from the official plugin into yours; the loop is
deliberate and takes minutes:

1. **Pin what you started from.** Record the official plugin version you
   copied (`plugins/claude/.claude-plugin/plugin.json` `version`, or the
   Codex manifest's) in your fork's README.
2. **Watch releases.** Each `cli-v*` release of this repository lists the
   plugin versions it pins; a plugin whose version moved has changed content.
3. **Diff the published artifact, not a checkout.**
   ```bash
   npm pack @jentrix/plugin-claude@0.5.5 @jentrix/plugin-claude@latest
   mkdir old new && tar -xzf jentrix-plugin-claude-0.5.5.tgz -C old && tar -xzf jentrix-plugin-claude-<new>.tgz -C new
   diff -ru old/package new/package
   ```
   The tarball is exactly what a customer installs; a checkout may carry
   unreleased text.
4. **Port what applies** — usually a prompt improvement or a new hook event —
   keeping your renames. Re-run your validation
   (`node scripts/validate-examples.mjs <your-plugin-dir>` works on any
   plugin directory laid out like the examples) and your provider's local
   install.
5. **Bump your version** in both places the provider and npm read
   (`plugin.json` and `package.json`); providers cache plugins by version,
   so an unbumped change is invisible to installed users.

## Isolating a fault when a custom plugin is installed

`jentrix session doctor` names the layer: the CLI version and source, each
marketplace's ownership, hook pinning and cache agreement, and the contract
state. A request is never rejected merely because a custom plugin is
installed, so "the CLI returns an error envelope" and "the plugin does the
wrong thing with it" are separable: run the CLI command the plugin runs, by
hand, with `--json`. If the CLI misbehaves against the documented contract,
that is Jentrix's bug — file it with the doctor output. If the CLI is right
and the plugin is wrong, that is the plugin publisher's.
