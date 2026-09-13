Use OpenCode's bash tool for CLI commands and its question or permission UI
(otherwise chat) for required choices. Invoke related workflows with
`/jentrix-…`. Always identify this provider with `--provider opencode`.
Start OpenCode normally, then connect; the CLI does not launch OpenCode.
Keep the detached host it starts; never start a second host or pass `--watch`.

The Jentrix plugin runs INSIDE OpenCode: it exports `OPENCODE_SESSION_ID`
(this session's own id) into every bash command and records lifecycle,
prompts, tool calls, assistant messages, compaction boundaries and one token
receipt per model step in its ledger. Never supply a session id yourself. If
the plugin is not loaded — a run started with `--pure`, or the plugin never
installed — the CLI refuses with `PROVIDER_SESSION_UNAVAILABLE`; relay it
and do not guess. Only a restart with the plugin loaded repairs it.

Token receipts count each model step exactly once; OpenCode's own
title-generation call has no message and is never counted — say so when
coverage is discussed. Replayed history on a forked session is inherited,
not new work, and yields no receipt.
