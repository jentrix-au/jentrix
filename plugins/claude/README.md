# @jentrix/plugin-claude

The official Jentrix plugin for [Claude Code](https://claude.com/claude-code):
the `/jentrix-connect`, `/jentrix-align`, `/jentrix-plan`,
`/jentrix-checkpoint`, `/jentrix-review`, `/jentrix-status` and
`/jentrix-end` commands plus the trusted lifecycle hooks that bind a session
to a Jentrix workspace.

Install it with the Jentrix CLI, never by hand — the CLI pins the hook
commands to absolute paths so they resolve without a PATH (JEN-305) and
registers the marketplace:

```bash
npm install -g @jentrix/cli
jentrix plugin install claude
```

This package is a dependency of `@jentrix/cli` and carries provider-facing
content only (manifests, commands, hook declarations). Business logic lives in
the CLI; removing the plugin leaves `jentrix session connect` as the fallback.
MIT.

All seven workflows include complete generated rules from
`plugins/workflows/` in the public repository, with a short provider entry.
No sibling package or repository file is needed at runtime. Maintainers edit
those sources, run `pnpm gen:workflows`, and review the generated commands or
skills; prepack rejects stale output. Provider hooks and trust stay explicit.
Sessions use the folder's workspace; projects are optional task labels.
