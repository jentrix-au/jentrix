# @jentrix/plugin-pi

The official Jentrix package for [Pi](https://github.com/earendil-works/pi)
(`@earendil-works/pi-coding-agent`). Installed and registered by the Jentrix
CLI — `npm install -g @jentrix/cli && jentrix plugin install pi` — never by
hand.

What it does, inside Pi (one extension, `src/index.js`, declared in
`package.json`'s `pi.extensions`):

- registers the seven `/jentrix-*` commands (connect, align, plan,
  checkpoint, review, status, end) with `pi.registerCommand`; each handler
  injects the generated workflow from `commands/` as a marked custom message
  (`customType: "jentrix"`) and waits for the turn it triggers, so the
  workflow text is never mistaken for the operator's own words;
- appends one line per observed extension event to
  `~/.config/stacks/pi-sessions/hooks.ndjson` — lifecycle, prompts, tool
  calls, assistant messages, compaction boundaries, and one token receipt per
  assistant message plus one per compaction or branch summary — which the
  CLI's session host reads. Session identity is Pi's own: its bash tool
  exports `PI_SESSION_ID` and `PI_SESSION_FILE`. Nothing here talks to the
  network; the ledger is 0600 under your home directory.

`jentrix plugin install pi` runs `pi install <this package's directory>` (Pi
records the path in its settings; nothing is copied) and `jentrix plugin
remove pi` runs `pi remove` on the same path — Pi's own CLI, never its
settings files. Extensions load at startup: restart Pi after installing. A
run started with `--no-extensions` loads none, and such a session records
nothing.

Behaviour, events and ledger vocabulary are documented in `hooks/hooks.json`
and `manifest.json`; the package's `jentrix` metadata block (behaviour
revision, resource digest, compatible CLI range) is stamped by the release
tooling and checked by `jentrix session doctor`.
