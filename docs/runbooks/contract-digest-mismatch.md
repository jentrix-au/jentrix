# Runbook — contract digest mismatch

**Symptom.** One of:

- `jentrix session doctor` prints a `contract` line that is not `ok`:
  `compatible drift: … serves 1.1.0 (digest …), this build adopted 1.0.0
  (digest …)`, `SURFACE_MISMATCH`, `API release … is outside this build's
  range`, or `release line 1.x is no longer supported`.
- `node scripts/adopt-contract.mjs <manifest-url>` refuses with
  `DIGEST_MISMATCH: the manifest at … promises <a> but the bundle at … hashes
  to <b> — nothing written`.
- CI's "Adopted contract vs the production endpoint" step warns.

**What the digest is.** SHA-256 over the bundle bytes the service serves at
`…/api/mcp/contract/bundle`; the manifest at `…/api/mcp/contract` names it,
and `contract.json` in a build records the digest that build was tested
against ([compatibility](../compatibility.md)).

## Triage — which of the three cases

1. **Compatible drift (`warn`, same major, line supported).** Not a fault.
   The service deployed additive changes after this CLI was built. Users
   keep working with the tools they have; commands for newer tools are not
   generated locally. *Action:* adopt and release when the new tools matter —
   step "Adopt" below. Tell the reporter nothing is broken.
2. **Refusal (`fail`: surface, major, or withdrawn line).** The client is
   too old for the service (or pointed at the wrong deployment — `ops` is
   not a compatibility target, D11). *Action for the user:* `npm i -g
   @jentrix/cli` (or, for `SURFACE_MISMATCH`, `jentrix login` against
   `https://tm.jentrix.ai/api/mcp`). *Action for maintainers:* if `latest`
   itself refuses, that is a release gap — a new major of the API shipped
   without a compatible client on `latest`; treat as an incident, ship the
   adoption release, and check that the withdrawn line got its 90 days'
   notice.
3. **`DIGEST_MISMATCH` from adopt-contract.** The manifest and the bundle
   disagree — a deployment in the middle of rolling out, a CDN serving a
   stale bundle, or tampering. `adopt-contract` writes nothing in this
   case, by design.

## `DIGEST_MISMATCH` — procedure

1. Fetch both by hand and hash the bundle:
   ```bash
   curl -sS https://tm.jentrix.ai/api/mcp/contract | tee manifest.json
   curl -sS "$(node -p 'require("./manifest.json").bundleUrl')" -o bundle.json
   shasum -a 256 bundle.json          # must equal manifest.digest
   ```
   The `bundleUrl` is digest-addressed (`…/bundle?digest=<d>`), so a stale
   CDN copy answers 404 `DIGEST_NOT_SERVED` rather than wrong bytes; a
   plain mismatch on the digest-addressed URL is therefore a real fault.
2. Compare the manifest's `revision.appRevision` with `GET
   https://tm.jentrix.ai/api/health` — a rollout in progress shows two
   revisions within minutes of each other. Wait ten minutes and retry
   step 1.
3. Still mismatched: do not adopt. Report it privately through
   [SECURITY.md](../../SECURITY.md)'s channel with both files and the
   hashes; the service side compares the served bytes with the committed
   `contract/mvp.json` (its own sync test would have caught a generator
   mismatch at deploy time, so a live mismatch points at the serving path).
4. Customers are unaffected until they adopt; the installed CLI keeps its
   tested contract.

## Adopt — shipping a client for a new digest

```bash
node scripts/adopt-contract.mjs https://tm.jentrix.ai/api/mcp/contract
curl -sS "$(curl -sS https://tm.jentrix.ai/api/mcp/contract | node -p 'JSON.parse(require("fs").readFileSync(0)).bundleUrl')" -o docs/contract/mvp.json
pnpm typecheck && CLI_PACK_SMOKE=1 pnpm test
```

Commit `surface.json`, `contract-vectors.json`, `contract.json`, the
regenerated `test/golden/help-*.txt` and `docs/contract/mvp.json`, with the
digest in the pull request title. A new API **minor** needs a CLI minor; a
new API **major** needs a CLI major and a release note naming the support
window of the old line. Then [release](../releasing.md).
