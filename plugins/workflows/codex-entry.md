Use Codex's command tool for CLI commands and its structured input UI when
available (otherwise chat) for required choices. Invoke related skills with
`$jentrix-…`. Always identify this provider with `--provider codex`.
Start Codex normally, then connect; the CLI does not launch a Codex SDK.
Keep the detached host it starts; never start a second host or pass `--watch`.

Trusted Codex environment and lifecycle hooks identify THIS task. When hooks
are unavailable, accept only the exact `rollout-*-${CODEX_THREAD_ID}.jsonl`
under the trusted Codex home, never the newest file. That fallback preserves
provider token receipts and opening-prompt provenance, but cannot supply
prompt/tool/assistant lifecycle events. If trusted identity or the exact
rollout is unavailable, relay the refusal and do not guess.

`coverage: COMPLETE` describes token receipts only, not proof that hooks ran.
For future lifecycle coverage, direct the operator to review and trust hooks
by typing `/hooks` at Codex's own prompt (not a shell command), then start a
new Codex task. Do not change trust yourself. Leave unobserved token fields
null; never estimate usage. A final-response artifact requires a prior Stop
hook that observed assistant text before closure: this closing turn's later
response cannot be claimed as captured.
