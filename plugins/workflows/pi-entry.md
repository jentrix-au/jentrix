Use Pi's bash tool for CLI commands and chat for required choices (state the
options and accept the operator's own wording). Invoke related workflows with
`/jentrix-…`. Always identify this provider with `--provider pi`.
Start Pi normally, then connect; the CLI does not launch Pi. Keep the
detached host it starts; never start a second host or pass `--watch`.

The Jentrix extension runs INSIDE Pi: Pi's own bash tool exports
`PI_SESSION_ID` and `PI_SESSION_FILE` (this session's identity), and the
extension records lifecycle, prompts, tool calls, assistant messages,
compaction boundaries and one token receipt per assistant message (plus one
per compaction or branch summary) in its ledger. Each workflow command
arrives as a marked custom message from the extension, never as the
operator's words. Never supply a session id yourself. If the extension is
not loaded — a run started with `--no-extensions`, or the package never
installed — the CLI refuses with `PROVIDER_SESSION_UNAVAILABLE`; relay it
and do not guess. Only a restart with the extension loaded repairs it.

Forked or switched history is inherited, not new work, and is never
recharged; a session run with `--no-session` has an id but no file.
