# acme-jentrix — reference Codex extension

A minimal, differently named plugin that composes beside the official
`jentrix` plugin: one skill (`$acme-standup`) over the documented Jentrix
CLI and one read-only hook. It is what
[docs/authoring-codex.md](../../docs/authoring-codex.md) builds step by
step, and `pnpm validate:examples` (or
`node scripts/validate-examples.mjs examples/acme-codex`) validates it the
way your CI would validate your own plugin.

```bash
# from a clone of this repository, with the official plugin already installed
codex plugin marketplace add "$(pwd)/examples/acme-codex"
codex plugin add acme-jentrix@acme
codex plugin list --json               # jentrix@jentrix AND acme-jentrix@acme
# …in a Codex task: /hooks to trust the hook, then $acme-standup
codex plugin remove acme-jentrix
codex plugin marketplace remove acme
```

Layout:

| File | Role |
| --- | --- |
| `.agents/plugins/marketplace.json` | The marketplace `acme` with one plugin, `acme-jentrix`, sourced from `./plugins/acme-jentrix` |
| `plugins/acme-jentrix/.codex-plugin/plugin.json` | The plugin's name, version, description and interface (the version is what Codex caches by — bump it with every change) |
| `plugins/acme-jentrix/skills/acme-standup/SKILL.md` | The `$acme-standup` skill |
| `plugins/acme-jentrix/hooks/hooks.json` | A `SessionStart` hook with a timeout, resolving `jentrix` through PATH; inactive until trusted with `/hooks` |
| `package.json` | The CLI range this plugin was written against (`peerDependencies`) |

Rename everything `acme` to your own name before distributing; never use
`jentrix` as a marketplace or plugin name ([TRADEMARKS.md](../../TRADEMARKS.md)).
