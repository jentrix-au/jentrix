---
name: jentrix-status
description: Show the connected Jentrix session, alignment, capture health, and honest telemetry availability for this Codex task.
---
<!-- Source of truth: cli/plugins. Shipped verbatim in the npm package. -->

# Show session status

Run `jentrix session status` and append the session id when the user supplied one.
Relay stdout and stderr verbatim, including capture or telemetry warnings. Never turn
null token values into zero or infer provider usage that Codex did not report.
`coverage: COMPLETE` describes provider token-receipt coverage only; it does not prove
the lifecycle hooks ran. If the session uses the exact-rollout fallback, report that
prompt/tool/assistant lifecycle evidence is unavailable and point to `/hooks` plus a
new Codex task for future full coverage.
