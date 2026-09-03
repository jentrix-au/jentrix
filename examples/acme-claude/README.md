# acme-jentrix — reference Claude Code extension

A minimal, differently named plugin that composes beside the official
`jentrix` plugin: one command (`/acme-standup`) over the documented Jentrix
CLI and one read-only hook. It is what
[docs/authoring-claude.md](../../docs/authoring-claude.md) builds step by
step, and `pnpm validate:examples` (or
`node scripts/validate-examples.mjs examples/acme-claude`) validates it the
way your CI would validate your own plugin.

```bash
# from a clone of this repository, with the official plugin already installed
claude plugin marketplace add "$(pwd)/examples/acme-claude"
claude plugin install acme-jentrix@acme
claude plugin list                     # acme-jentrix@acme beside the official plugin
# …in a session: /acme-jentrix:acme-standup (plugin commands are namespaced)
claude plugin uninstall acme-jentrix@acme
claude plugin marketplace remove acme
```

Layout:

| File | Role |
| --- | --- |
| `.claude-plugin/marketplace.json` | The marketplace `acme` with one plugin, `acme-jentrix`, sourced from this directory |
| `.claude-plugin/plugin.json` | The plugin's name, description and version (the version is what Claude Code caches by — bump it with every change) |
| `commands/acme-standup.md` | The `/acme-jentrix:acme-standup` command: a prompt with `allowed-tools: Bash(jentrix:*)` |
| `hooks/hooks.json` | A `SessionStart` hook with a timeout, resolving `jentrix` through PATH |
| `package.json` | The CLI range this plugin was written against (`peerDependencies`) |

Rename everything `acme` to your own name before distributing; never use
`jentrix` as a marketplace or plugin name ([TRADEMARKS.md](../../TRADEMARKS.md)).
