---
description: Connect this Claude Code session to Jentrix (session anchor + capture in the folder's workspace)
allowed-tools: Bash(jentrix session:*), Bash(jentrix folder:*)
---
<!-- Source of truth: plugins/claude in jentrix-au/jentrix. Shipped verbatim in the npm package. -->

Run this exact command with the Bash tool and relay its output to the user:

```
jentrix session connect --provider claude
```

Notes for you (the assistant):

- Do NOT pass `--provider-session` yourself — the CLI reads the current
  session id and transcript path from the TRUSTED lifecycle-hook context this
  plugin's hooks recorded; model-authored session ids are never accepted.
- Do NOT pass `--watch`. It runs the session host in the FOREGROUND, so the
  Bash tool call never returns until the host exits and Claude Code's tool
  timeout kills it — leaving the session bound but not recording. Without it
  the host starts DETACHED and the command prints its pid; relay that line.
- The session's scope is the FOLDER's workspace (client-runtime v2): if the
  command refuses with `FOLDER_NOT_ALIGNED`, run `jentrix folder align`
  (interactive workspace picker) and retry — never invent a workspace id.
- Connect is IDENTITY only. Anchoring work is `/jentrix-align`
  (`jentrix session align --task <id-or-key>`), and a Project is an optional
  task label (`jentrix task project add`) — neither is part of connecting.
- If the command fails, show its error verbatim — it names the fallback and
  the blocker code. Do not improvise a workaround.
