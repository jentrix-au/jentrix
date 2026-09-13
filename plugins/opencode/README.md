# @jentrix/plugin-opencode

The official Jentrix plugin for [OpenCode](https://opencode.ai). Installed and
registered by the Jentrix CLI — `npm install -g @jentrix/cli && jentrix plugin
install opencode` — never by hand.

What it does, inside OpenCode:

- registers the seven `/jentrix-*` commands (connect, align, plan,
  checkpoint, review, status, end) through OpenCode's plugin `config` hook,
  from the generated files in `commands/` (`pnpm gen:workflows` in
  jentrix-au/jentrix; do not edit them);
- exports `OPENCODE_SESSION_ID` and `JENTRIX_PROVIDER=opencode` into every
  bash tool command through the `shell.env` hook, so `jentrix session connect
  --provider opencode` binds the session that is actually running;
- appends one line per observed host event to
  `~/.config/stacks/opencode-sessions/hooks.ndjson` — lifecycle, prompts,
  tool calls, assistant messages, compaction boundaries and one token receipt
  per model step — which the CLI's session host reads. Nothing here talks to
  the network; the ledger is 0600 under your home directory.

`jentrix plugin install opencode` writes ONE managed loader file,
`jentrix.js`, into OpenCode's global plugins folder (under the config
directory `opencode debug paths` reports) pointing at this package inside the
CLI's dependency tree. It never edits `opencode.json` and leaves other plugin
files alone; `jentrix plugin remove opencode` deletes only that file. Plugins
load at startup: restart OpenCode after installing. A run started with
`--pure` loads no external plugins, and such a session records nothing.

Behaviour, hooks and ledger vocabulary are documented in `hooks/hooks.json`
and `manifest.json`; the package's `jentrix` metadata block (behaviour
revision, resource digest, compatible CLI range) is stamped by the release
tooling and checked by `jentrix session doctor`.
