# Extraction manifest

How this repository was created, from what, and what was checked before the
first commit (open-client PRD §7 "public-repository readiness", D15: a clean
snapshot with an extraction manifest, no filtered history).

## Source

- **Private source:** the `cli/` tree of `jentrix-au/task-manager` (the
  application repository, which stays private) at revision
  **`17a8fb8e1027eb10594600ed97063b89b85a21d7`** (`main`, 2026-09-03).
- **Method:** `git archive HEAD cli` unpacked with `cli/` as the repository
  root — 161 files. No git history was imported; this repository's history
  starts at its first commit. After the export the private `main` advanced
  to `f95ced03` (the runner is no longer published from the private
  repository); its only changes under `cli/` were two comment/prose edits
  (`RELEASING.md`, `scripts/check-version.mjs`) that this tree's own
  rewrites of both files already supersede — no code differs. Phases 1 and 2 of the open-client program
  (the served contract, the eight coupling rows, the three-package split,
  the legacy migration, the pack-once release pipeline) were proven inside
  the private repository first, so nothing here reaches outside this tree.

## Components imported

| Component | Path | Version |
| --- | --- | --- |
| `@jentrix/cli` — the `jentrix` / `stacks` bins, `jentrix-session-host`, the `@jentrix/cli/core` entry | `src/`, `scripts/`, `test/`, `package.json`, `tsconfig*.json` | 0.7.0 (bumped here from 0.6.7 — the first public release) |
| `@jentrix/plugin-claude` — the official Claude Code plugin | `plugins/claude/` | 0.5.5 (as hand-published on 2026-09-03) |
| `@jentrix/plugin-codex` — the official Codex plugin | `plugins/codex/` | 0.2.8 (as hand-published on 2026-09-03) |
| The adopted contract projections | `surface.json`, `contract-vectors.json`, `contract.json` | re-adopted here from `https://tm.jentrix.ai/api/mcp/contract` — mvp 1.0.0, digest `9fdc4c25d64dd3d3fde5a705d54f821002261e15d402a022776a4188b3621fb0`, byte-identical to the private tree's |
| The contract documents | `docs/contract/mvp.json` (the bundle, same digest), `docs/contract/oauth.md` | copied from the private repository's `contract/` |
| Workspace and toolchain | `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.npmrc`, `homebrew/` | unchanged |
| Licence | `LICENSE` (MIT) | unchanged |

## Modified during extraction

| File | Change |
| --- | --- |
| `package.json` | version 0.6.7 → 0.7.0; `repository.url` → `git+https://github.com/jentrix-au/jentrix.git` (no `directory` — the package is the root); `bugs`/`homepage` → this repository; `packageManager` pinned; `validate:examples` script |
| `plugins/claude/package.json`, `plugins/codex/package.json` | `repository.url` → this repository with `repository.directory`; `bugs`/`homepage` → this repository (a mismatch fails provenance publication) |
| `plugins/codex/plugins/jentrix/.codex-plugin/plugin.json` | `repository` → this repository (metadata only; the plugin version is unchanged and its content is otherwise byte-identical to the published 0.2.8) |
| `src/client.ts` | `CLI_VERSION` 0.6.7 → 0.7.0 |
| `README.md` | rewritten for a public audience |
| `RELEASING.md` → `docs/releasing.md` | moved and rewritten for this repository (workflow `release.yml`, environment `release`, no runner) |
| `scripts/check-version.mjs`, `scripts/render-homebrew-formula.mjs`, `scripts/adopt-contract.mjs`, `homebrew/jentrix.rb`, `src/surface.ts` | usage text and comments that named `cli/…` paths or `release-cli.yml` now name this tree |

Everything else under `src/`, `test/`, `plugins/` and `scripts/` is
byte-identical to the private revision.

## Added — what the public repository owns and the private one never did

`CONTRIBUTING.md` (DCO, no CLA), `CODE_OF_CONDUCT.md`, `SECURITY.md`,
`TRADEMARKS.md`, `NOTICE`, `.github/CODEOWNERS`, `.github/ISSUE_TEMPLATE/`,
`.github/PULL_REQUEST_TEMPLATE.md`, `.github/workflows/ci.yml` (from the
private `cli.yml`, no working-directory indirection, the pack smoke always
on), `.github/workflows/release.yml` (from the private `release-cli.yml`,
publish and promote under `environment: release`, no runner),
`.github/scripts/publish-candidate.sh` (since renamed `publish-package.sh`
when candidate-first was dropped; carried verbatim but for its
comments), `.gitignore`, `docs/authoring-claude.md`, `docs/authoring-codex.md`,
`docs/forks.md`, `docs/hooks-security.md`, `docs/compatibility.md`,
`examples/acme-claude`, `examples/acme-codex`, `scripts/validate-examples.mjs`.

## Deliberately omitted

- **Everything outside `cli/`**: the application, its data model and routes,
  the agent-operations planes, and the runner (`agents/`) — the service and
  the runner stay private (PRD §10, D14).
- **The private CI lanes** (`ci.yml`, `cli.yml`, `release-cli.yml`,
  `release-runner.yml`) — replaced by `ci.yml` and `release.yml` here; the
  runner's workflow is not part of this train.
- **Git history** — none. The private history is the private repository's.
- **The private release notes and skill files** that drove releases from the
  private repository.

## What was scanned, and how

- **Secret sweep** (gitleaks was not available on the extraction machine):
  a regex sweep over every file except `node_modules/`, `dist/` and
  `pnpm-lock.yaml` for Jentrix token prefixes (`tm_`, `tmo_`, `tmr_`), Resend
  (`re_`), OpenAI/Anthropic (`sk-`), GitHub (`ghp_`, `gho_`), AWS (`AKIA`),
  Slack (`xox?-`), Stripe (`sk_live_`, `pk_live_`), npm (`npm_`), Google
  (`AIza`) and private-key headers. Every hit is a **synthetic fixture** in a
  redaction test or in the golden vectors the contract ships — obviously
  fake by construction (`tm_0123456789abcdefTOKEN`, `AKIAABCDEFGHIJKLMNOP`,
  `ghp_ABCDEFGHIJKLMNOPQRST12`, a private-key block whose body is `MIIabc`),
  kept because they are the corpus that proves redaction works. No credential
  was ever present in the export, so nothing had to be rotated.
- **Identity and path sweep**: a sweep for the maintainers' user names, email
  addresses, home directories and Windows profile paths found none; the only
  absolute paths are fixtures (`/Users/dev/…`, `/Users/op/…`,
  `/Users/operator/…`, `C:\Users\Jane Doe\…`).
- **Goldens and fixtures reviewed by eye**, every file under `test/golden/`:
  the four help goldens (generated from the contract), the six
  `flags-*.json` descriptor goldens (generated from the contract), and
  `claude-transcript-cache-ttl.jsonl` (three synthetic usage records with
  `ok` as their only text). Nothing was rewritten or dropped.
- **Private references kept on purpose**: fixtures naming the MVP's Vercel
  alias `stacks-mvp.vercel.app` (the same public deployment as
  `tm.jentrix.ai`), a repository-identity fixture naming
  `jentrix-au/task-manager`, comments that describe the private runner
  package (`agents/lib/…`) whose contract the CLI mirrors, and the private
  tracker's card ids (`JEN-`, `STA-`, `AGE-`) in comments, which are opaque
  references to design history. The official plugin command and skill files
  carry a `Source of truth: cli/plugins` comment naming the pre-extraction
  path; they are byte-identical to the published plugin versions and are
  updated with the next plugin version bump, since providers cache plugins by
  version.
- **Licence and notice review**: `NOTICE` lists every third-party package
  from `pnpm licenses list` (MIT, BSD-2/3-Clause, ISC, Apache-2.0); the
  runtime set is bundled into `dist/`, the rest is development-only.

## Verified in the snapshot before the first commit

- `node scripts/check-version.mjs 0.7.0` → OK (plugins self-consistent at
  0.5.5 / 0.2.8).
- `node scripts/adopt-contract.mjs https://tm.jentrix.ai/api/mcp/contract`
  → adopted mvp 1.0.0, `supported`, and the three projections plus the four
  help goldens came out byte-identical to the private tree's.
- `pnpm install --frozen-lockfile && pnpm typecheck` → clean.
- `CLI_PACK_SMOKE=1 pnpm test` → 882 tests, 0 failures, including the
  cold install of the three packed tarballs.
- `pnpm validate:examples` → both reference extensions valid (and
  `claude plugin validate` agrees on the Claude Code one).
