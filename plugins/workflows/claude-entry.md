Use Claude Code's Bash tool for CLI commands. For required choices use
AskUserQuestion with preset options and explain that “Other…” accepts the
operator's own wording. Invoke related workflows with `/jentrix-…`.

This plugin's trusted lifecycle hooks supply the Claude session id and
transcript path. Do not override them with a model-chosen id or transcript.
Connect with `--provider claude`; the host runs detached by default. Never
pass `--watch` in a command tool call, whose timeout can kill the host.
