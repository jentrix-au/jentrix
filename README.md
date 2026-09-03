# Jentrix open client

The command-line client and the official coding-agent plugins for
[Jentrix](https://tm.jentrix.ai) — open at the edge, governed at the centre.
Everything that runs on your machine is in this repository; everything that
decides authority (authorization, tenancy, audit, idempotency, concurrency,
rate limits) is enforced by the hosted service on every request, whatever
the client says.

| Package | What it is |
| --- | --- |
| [`@jentrix/cli`](https://www.npmjs.com/package/@jentrix/cli) (this directory) | The `jentrix` command: every MCP tool as a shell command (`jentrix task list --board-id <id> --json`), OAuth sign-in, connected-session commands, `jentrix session doctor`, and the `jentrix-session-host` bin the plugins' hooks call |
| [`@jentrix/plugin-claude`](https://www.npmjs.com/package/@jentrix/plugin-claude) (`plugins/claude`) | The official Claude Code plugin: `/jentrix-connect`, `/jentrix-align`, `/jentrix-plan`, `/jentrix-checkpoint`, `/jentrix-review`, `/jentrix-status`, `/jentrix-end` and the trusted lifecycle hooks |
| [`@jentrix/plugin-codex`](https://www.npmjs.com/package/@jentrix/plugin-codex) (`plugins/codex`) | The official Codex plugin: the same seven workflows as `$jentrix-…` skills, plus the hooks |

The CLI depends on both plugin packages with exact pins and materializes
them into your provider with the hook commands pinned to absolute paths.
MIT licensed, DCO signed, no CLA.

## Install — one command

```bash
npx --yes --package @jentrix/cli@latest jentrix setup
```

The same line works in bash, zsh, fish, PowerShell and cmd; it needs Node ≥ 20.
`jentrix setup` checks the machine, installs the CLI globally, signs you in
through the browser, installs the official plugin for the coding agent it
finds (Claude Code, Codex, or both), and leaves the checkout connected. It is
preview-first: read the plan it prints, then confirm.

Without Node on the machine, the hosted bootstrap installs it first and runs
the same command:

```bash
bash -c "$(curl -fsSL https://tm.jentrix.ai/install.sh)"     # macOS / Linux
irm https://tm.jentrix.ai/install.ps1 | iex                  # Windows PowerShell
```

### Direct use, no setup

```bash
npm install -g @jentrix/cli
jentrix --version                  # 0.7.1 (surface: 64 tools, file dated …)
jentrix login                      # OAuth in the browser; or export STACKS_TOKEN=tm_…
jentrix whoami
jentrix task list --board-id <id> --json | jq .

# or run it without installing (the --package form is required: the package
# ships several executables, so a bare `npx @jentrix/cli` cannot pick one)
npx --yes --package @jentrix/cli jentrix --help
```

`jentrix plugin install claude` and `jentrix plugin install codex` install
the official plugins on their own; `jentrix session doctor` reports what is
installed, who owns each provider's `jentrix` marketplace, whether the hooks
are pinned, and how this build's contract compares with the server's.

## Where the contract lives

The CLI is **built from a contract the service serves**, not from a copy of
its source:

```
GET https://tm.jentrix.ai/api/mcp/contract          the manifest: surface, apiRelease, digest, publicationState
GET https://tm.jentrix.ai/api/mcp/contract/bundle   the bundle: every tool's schema + the golden vectors
```

`scripts/adopt-contract.mjs https://tm.jentrix.ai/api/mcp/contract` verifies
the digest and writes `surface.json`, `contract-vectors.json` and
`contract.json` — the three files the command tree, the help goldens, the
mirror test and `jentrix --version` derive from. The bundle this release
adopted is checked in at [`docs/contract/mvp.json`](./docs/contract/mvp.json);
the OAuth protocol contract is [`docs/contract/oauth.md`](./docs/contract/oauth.md).
How versions, digests, drift and the 180/90-day support window work:
[`docs/compatibility.md`](./docs/compatibility.md).

## Documentation

- [Compatibility and lifecycle](./docs/compatibility.md) — the four version domains, the six-step connection order, the support window
- [Hooks and the trust model](./docs/hooks-security.md) — what the hooks do, the absolute-path pin, the provider's trust step
- [Writing a Claude Code plugin for Jentrix](./docs/authoring-claude.md) · [Writing a Codex plugin for Jentrix](./docs/authoring-codex.md) — from a minimal `acme-jentrix` to distribution
- [Forks and composition](./docs/forks.md) — compose beside the official plugin, or fork it under your own name; the coexistence matrix; the upstream comparison loop
- [Releasing](./docs/releasing.md) — the pack-once, candidate-first ritual (maintainers)
- [Runbooks](./docs/runbooks/) — contract digest mismatch, publish failure, compromised release, migration failure
- [`examples/acme-claude`](./examples/acme-claude) · [`examples/acme-codex`](./examples/acme-codex) — the two reference extensions; `pnpm validate:examples` checks them the way your CI would check yours
- In-app: [install](https://tm.jentrix.ai/docs/cli-install), [connected sessions](https://tm.jentrix.ai/docs/cli), [the product tool catalog](https://tm.jentrix.ai/docs/mcp-tools)

## Build and test

```bash
pnpm install
pnpm typecheck && pnpm test
CLI_PACK_SMOKE=1 pnpm test        # + cold install of the packed tarballs (what CI runs)
pnpm validate:examples
pnpm build                        # dist/: the two bins and the @jentrix/cli/core entry
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) (DCO sign-off, what is in scope),
[SECURITY.md](./SECURITY.md) (private reporting, severity targets),
[TRADEMARKS.md](./TRADEMARKS.md) (reserved names, how to name a fork) and
[EXTRACTION.md](./EXTRACTION.md) (how this repository was created from the
private source, and what was audited).

## License

MIT © Jentrix — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
