---
description: Acme standup — what moved on our Jentrix boards in the last day, grouped by column
allowed-tools: Bash(jentrix:*)
---

Produce Acme's standup summary from Jentrix, using ONLY the `jentrix` CLI
through the Bash tool. Never ask for or print a token; the CLI reads its
credential from `jentrix login` or `STACKS_TOKEN` itself.

1. Run `jentrix workspace list --json` and pick the workspace whose slug
   matches the folder binding (`jentrix session doctor --json` reports it as
   `folder binding`); if there is exactly one workspace, use it.
2. Run `jentrix board list --workspace-id <id> --json` and keep the boards
   whose `kind` is `TASKS`.
3. For each board run `jentrix task list --board-id <id> --json` (follow
   `nextCursor` with `--cursor` until it is null) and keep tasks whose
   `updatedAt` is within the last 24 hours.
4. Print one section per board, tasks grouped by `columnName`, each line as
   `KEY — title (priority)`. Say "nothing moved" for a board with no changes.

Failure handling: relay any `{"error":{"code":…}}` envelope the CLI prints
verbatim and stop — a `RATE_LIMITED` envelope carries `retryAfterSeconds`
(the CLI already waits up to 60 s by itself), a `FORBIDDEN` one means the
token lacks the `read` scope for that workspace. Do not retry a `FORBIDDEN`
or `NOT_FOUND` call with different ids you guessed.
