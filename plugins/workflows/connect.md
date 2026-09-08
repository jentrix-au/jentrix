Run this exact command with the provider's command tool and relay its output to the user:

```
jentrix session connect --provider {{provider}}
```

Notes for you (the assistant):

- Do NOT pass `--provider-session` yourself — the CLI reads the current
  provider identity and transcript path from trusted provider context as
  described in the provider entry; model-authored session ids are never accepted.
- Do NOT pass `--watch`. It runs the session host in the FOREGROUND, so the
  command tool may wait until the host exits and its timeout may kill it — leaving the session bound but not recording. Without it
  the host starts DETACHED and the command prints its pid; relay that line.
- The session's scope is the FOLDER's workspace (client-runtime v2): if the
  command refuses with `FOLDER_NOT_ALIGNED`, run `jentrix folder align`
  (interactive workspace picker) and retry — never invent a workspace id.
- Connect is IDENTITY only. Anchoring work is `{{prefix}}jentrix-align`
  (`jentrix session align --provider {{provider}} --task <id-or-key>`), and a Project is an optional
  task label (`jentrix task project add`) — neither is part of connecting.
- If the command fails, show its error verbatim — it names the fallback and
  the blocker code. Do not improvise a workaround.
