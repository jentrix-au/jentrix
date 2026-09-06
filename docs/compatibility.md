# Compatibility and lifecycle

Four things carry a version, and by rule they never share a number:

| Domain | Owner | Where the number lives |
| --- | --- | --- |
| Hosted API surface (`mvp`) | Jentrix, server-side | `apiRelease` in `GET https://tm.jentrix.ai/api/mcp/contract` (semver; ask the endpoint rather than this table, which cannot follow it) |
| `@jentrix/cli` | this repository | `package.json` + `CLI_VERSION` in `src/client.ts` (`0.8.1`) |
| `@jentrix/plugin-claude` | this repository | `plugins/claude/package.json` + `.claude-plugin/plugin.json` (`0.5.6`) |
| `@jentrix/plugin-codex` | this repository | `plugins/codex/package.json` + `plugins/jentrix/.codex-plugin/plugin.json` (`0.2.9`) |

The server owns the API release and the support state of each line; each
client owns the range and the exact digest it tested against. Neither side
claims compatibility alone.

## The contract a CLI is built from

The production deployment serves a deterministic **bundle** — every MCP
tool's name, description, input schema, annotations and scope class, plus the
redaction and connection-key golden vectors — and a small **manifest**:

```
GET https://tm.jentrix.ai/api/mcp/contract          → { revision, surface, apiRelease, digest, publicationState, supportedReleases, bundleUrl }
GET https://tm.jentrix.ai/api/mcp/contract/bundle   → the bundle bytes (ETag = digest, immutable when addressed by digest)
```

`digest` is SHA-256 over the bundle bytes. `publicationState` is `supported`
only on the production deployment; a preview deployment says `preview` and
never claims support. A copy of the bundle this release was built from is
checked in at [`docs/contract/mvp.json`](./contract/mvp.json); the OAuth
contract is [`docs/contract/oauth.md`](./contract/oauth.md).

`scripts/adopt-contract.mjs <manifest-url | bundle-file>` is the only writer
of the three adopted files: it verifies the digest, refuses any surface other
than `mvp`, and writes `surface.json` (the tools the command tree is built
from), `contract-vectors.json` (the mirror test's corpus) and `contract.json`
(`{ surface, apiRelease, digest }` — what this build was tested against).

## The six-step connection order

At connect time — `jentrix session doctor` shows the result as its
`contract` line — the client compares `contract.json` with the served
manifest in this fixed order (PRD §5.4, D5, D11):

1. **Surface must match.** This CLI targets `mvp`; any other surface (the
   `ops` platform deployment, for instance) is refused — `SURFACE_MISMATCH`.
2. **API release must be inside the client's range.** The range is the major
   of the adopted release (`^1.0.0`). A different major is a refusal with the
   remedy `npm i -g @jentrix/cli`.
3. **The server must still list that line as supported** (`supportedReleases`
   contains `1.x`). A withdrawn line is a refusal with the same remedy.
4. **An equal digest is the tested contract** — the exact bundle this build's
   goldens and mirror test ran against.
5. **A different digest inside the range is compatible drift** — disclosed in
   diagnostics, never a refusal. The server may have added a tool or an
   optional field; the client keeps using what it knows.
6. **Drift never generates commands for newer tools.** An older client does
   not grow a command it was not built with; a server that is *behind* the
   client refuses commands for tools it lacks with the ordinary error
   envelope. The fix for either direction is a release that adopts the newer
   bundle.

CI performs steps 4–5 informationally on every push (`ci.yml`, "Adopted
contract vs the production endpoint"), so drift is visible before a customer
asks.

## How the API release moves

Every byte change to the bundle changes `apiRelease`; the classification is
enforced in the application repository's CI on every pull request:

- a **removed tool or removed required field** requires a **major**;
- a **new tool or new optional field** requires at least a **minor**;
- anything else is a **patch**.

Additive server capability may deploy before any client uses it. A breaking
change ships as a new major **beside** the old one (`/api/mcp/v2` next to
`/api/mcp`; nothing is renamed), then compatible clients, then withdrawal.

## The support window: 180 days, 90 days' notice

A superseded API major stays supported for **180 days** after its successor
is generally available and gets **90 days' withdrawal notice** through
`supportedReleases` and the release notes. A critical security fix may
shorten this, with a published reason and a migration.

## Official updates and what they touch

An official update (`npm i -g @jentrix/cli` followed by `jentrix plugin
install`) replaces only files the official packages own and repoints only a
marketplace registration the official CLI wrote. The outcomes are three and
distinct, and `jentrix plugin install` says which one happened:

- **official update completed** — the `jentrix` marketplace points at the new
  package, hooks are pinned, activation is proven from the provider's own
  listing;
- **custom installation left untouched** — the `jentrix` marketplace was not
  written by this CLI (`PLUGIN_MARKETPLACE_CONFLICT`, with the remedy);
- **incompatible combination refused with a remedy** — for example a surface
  or major mismatch at step 1–3 above.

Existing installations migrate two-phase: the new package is staged and
activation-tested before the old registration is removed, and any failure
restores the previous registration. Rollback of a release is reinstalling the
previous published version — nothing is ever unpublished.

## Plugins declare the CLI range they need

The CLI declares the plugin versions it ships with (exact pins in
`package.json`). A plugin — official or yours — declares the CLI range it was
written against. The convention this repository uses and validates for its
examples is `peerDependencies` in the plugin's `package.json`:

```json
{
  "name": "acme-jentrix",
  "version": "0.1.0",
  "peerDependencies": { "@jentrix/cli": ">=0.7.0 <1.0.0" }
}
```

`pnpm validate:examples` checks that the range is well-formed and includes
the CLI version in this tree; a customer plugin's CI can run the same script
against its own directory. The provider ignores the field; it is a contract
between your plugin and the CLI it shells out to.
