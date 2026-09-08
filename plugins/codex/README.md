# @jentrix/plugin-codex

The official Jentrix plugin for [Codex](https://developers.openai.com/codex/cli):
the `$jentrix-connect`, `$jentrix-align`, `$jentrix-plan`,
`$jentrix-checkpoint`, `$jentrix-review`, `$jentrix-status` and
`$jentrix-end` skills plus the trusted lifecycle hooks that bind a task to a
Jentrix workspace (trust them once with `/hooks` at Codex's own prompt).

Install it with the Jentrix CLI, never by hand — the CLI pins the hook
commands to absolute paths so they resolve without a PATH (JEN-305) and
registers the marketplace:

```bash
npm install -g @jentrix/cli
jentrix plugin install codex
```

This package is a dependency of `@jentrix/cli` and carries provider-facing
content only (manifests, skills, hook declarations). Business logic lives in
the CLI. MIT.

All seven workflows include complete generated rules from
`plugins/workflows/` in the public repository, with a short provider entry.
No sibling package or repository file is needed at runtime. Maintainers edit
those sources, run `pnpm gen:workflows`, and review the generated commands or
skills; prepack rejects stale output. Provider hooks and trust stay explicit.
Sessions use the folder's workspace; projects are optional task labels.
