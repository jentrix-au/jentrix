# Releasing the client packages

This repository is one pnpm root holding THREE packages (open-client PRD
§5.2): `@jentrix/cli` (the root), `@jentrix/plugin-claude` (`plugins/claude`)
and `@jentrix/plugin-codex` (`plugins/codex`). The CLI depends on both
plugins with `workspace:*`, which `pnpm pack` rewrites to the exact version.
They publish to npm via [`.github/workflows/release.yml`](../.github/workflows/release.yml),
triggered by pushing a **`cli-v*`** tag — PACK-ONCE and STRAIGHT TO `latest`:

1. `pnpm -r pack` runs exactly once; any `workspace:` range that survives is a
   red build.
2. The three tarballs are clean-installed TOGETHER into an empty project and
   exercised (`--version`, `--help`, `plugin install <provider> --dry-run`,
   no `plugins/` inside the CLI package).
3. The very same files are `npm publish`ed under the **`latest`** dist-tag —
   plugins first, the CLI last (its package.json pins their versions).
   Nothing repacks between validation and upload.
4. The registry is asked whether all three versions exist (a ten-minute poll —
   npm publishes asynchronously), and a GitHub Release announces it.

A tagged release is live for every user the moment step 3 lands. There is no
soak period and no promotion step.

Publishing is intentionally NOT automatic on merge — it only happens when a
maintainer cuts a tag. Every run of the `publish` job — a tag or a manual dry
run — executes under the protected **`release` environment** and waits in the
Actions UI for its required reviewer before a single step runs.

## Why there is no `next` candidate any more (2026-09-06)

Worth reading before anyone proposes restoring it.

Promotion ran `npm dist-tag add`, which is **not a publish**, so trusted
publishing's OIDC token could not authorize it — the job needed an account
credential in `NPM_PROMOTE_TOKEN`. npm is now
[restricting tokens that bypass 2FA](https://gh.io/npm-gat-bypass2fa-deprecation)
for direct publishing and account changes, and a dist-tag write counts. The
promote job failed `EOTP` on **every one of its four attempts** across
2026-09-03 and 2026-09-06, with a correctly scoped granular token holding
read+write on all three packages. It never once succeeded, and every `latest`
this repository ever set was set by hand.

That was invisible for three days because a manual dispatch with `promote`
empty *skipped* the promote job, so the only green dispatch run had never
exercised the token at all. A soak period nobody can leave is worse than no
soak period: it made "released" mean "published where users are not looking",
and it hid a manual step behind a green check.

Publishing is exempt because OIDC is not a token, which is why the publish half
has always worked and still does.

**What it costs, plainly.** A bad release is what everyone installs,
immediately. The clean-install exercise in step 2 is now the only gate between
a tarball and every user — keep it exhaustive. Rolling back moves the tag
rather than unpublishing (nothing is ever unpublished), and needs a
browser-authenticated session because of the same npm restriction:

```bash
npm login                                        # the web flow IS the 2FA
npm dist-tag add @jentrix/cli@<previous> latest
```

`NPM_PROMOTE_TOKEN` on the `release` environment is now unused and should be
deleted from the repository and revoked on npmjs.com.

## One-time setup

1. **The `release` environment.** Repository → Settings → Environments →
   `release`, with the maintainers as required reviewers. Its name is part of
   what npm validates (below), so renaming it breaks publishing the same way
   renaming the workflow file does.
2. **npm trusted publisher (no token).** Releases authenticate with OIDC, so
   there is no npm credential in this repository or its Actions secrets. On
   npmjs.com, for **each** of `@jentrix/cli`, `@jentrix/plugin-claude` and
   `@jentrix/plugin-codex`: package → Settings → Trusted publisher → *Select
   your publisher* → GitHub Actions, with **organization or user `jentrix-au`,
   repository `jentrix`, workflow `release.yml`, environment `release`**, and
   **Allowed actions: npm publish** (a required field, easy to miss — an
   incomplete form saves nothing and says nothing). Every package needs its
   own entry — a release that publishes one and fails the other is worse
   than one that fails first. npm binds ONE publisher per package: registering
   this repository replaces any earlier binding (the packages were published
   from the private application repository before extraction).

   **Verify it without cutting a release**: run the workflow manually
   (`gh workflow run release.yml --ref main`, or the Actions UI), approve the `release` deployment when it asks. A manual
   run is always a dry run and publishes nothing. For a package WITH a
   publisher the step goes green: the dry run reaches npm's `cannot publish
   over the previously published versions` check — which runs after auth, so
   getting there is the pass — and the publish step translates that one case
   into success. The line behind the verdict is the exchange:
   `POST 201 …/oidc/token/exchange/package/<pkg>` plus
   `oidc Successfully retrieved and set token`. A `POST 404` with
   `OIDC token exchange error - package not found` means no publisher matches
   this repository + workflow + environment for that package, and the run
   goes red — because the publish script REQUIRES that exchange line on a dry
   run. It has to: npm's helper only logs the 404 and falls through, a dry
   run never PUTs, and a version that is not on npm has nothing to collide
   with, so `npm publish --dry-run` would print `+ <pkg>@<version>` and exit 0
   having proven nothing.

   Worth knowing why that check exists: npm's OIDC helper never throws. Every
   failure is a `log.verbose('oidc', …)` and a silent fallthrough to whatever
   `_authToken` is configured — under actions/setup-node, the placeholder
   `XXXXX-XXXXX-XXXXX-XXXXX`. The registry answers that unauthenticated PUT with
   a bare `E404 Not Found` for a package that plainly exists, so an unregistered
   trusted publisher is indistinguishable from a typo unless you publish at
   `--loglevel verbose` (the workflow does).

   Two consequences. **Renaming the workflow file or the environment breaks
   publishing** until the trusted publisher is re-pointed, because both are
   part of what the registry validates. And **the npm account needs 2FA
   enabled** — not for the workflow, which never touches the account, but
   because editing trusted-publisher configuration is one of the operations
   npm gates on 2FA.
3. **`NPM_PROMOTE_TOKEN` is retired.** It backed the promote job, which no
   longer exists (see "Why there is no `next` candidate any more"). Delete the
   environment secret and revoke the token on npmjs.com; nothing reads it.
4. **`repository.url` must match.** All three `package.json` files name
   `git+https://github.com/jentrix-au/jentrix.git` (the plugins with
   `repository.directory`). Trusted publishing with provenance FAILS
   publication when the metadata names a different repository than the one
   publishing — a blocker, not cosmetics.
5. **Homebrew tap (optional, NOT done).** Create an empty repo
   **`jentrix-au/homebrew-tap`**. Generate a fine-grained PAT with
   `contents: read/write` on just that repo and add it as the secret
   **`HOMEBREW_TAP_TOKEN`**. Without this secret the release still publishes to
   npm and creates the GitHub Release; only the automatic formula bump is
   skipped (do it manually — see below).

## Cutting a release

**The tag must point at a commit that already CONTAINS the bump.** Tagging
`main` before the bump merges tags the PREVIOUS release's commit, and the
workflow's first step refuses it —

```
version mismatch:
  package.json version 0.7.0 != tag 0.7.1
```

That guard runs before install, gates, and publish, so a mismatch costs nothing
but the run: nothing is published and the version stays free to reuse. Delete
the tag (`git push origin :refs/tags/cli-v0.7.1`), merge, then tag the new head.

1. Bump the CLI version in both its places (the workflow's guard enforces
   they match the tag):
   - `package.json` → `version`
   - `src/client.ts` → `CLI_VERSION`

   A plugin that CHANGED bumps its own version in BOTH its places — the
   provider manifest (`plugins/claude/.claude-plugin/plugin.json`,
   `plugins/codex/plugins/jentrix/.codex-plugin/plugin.json`: what Claude Code
   and Codex cache BY) and its `package.json` (what npm publishes); the guard
   fails when they disagree. An unchanged plugin keeps its version: on a tag
   its publish is a clean no-op (npm's "cannot publish over" is success for a
   plugin, a fault for the CLI), and the registry check proves the existing
   version is live.
2. If the MCP tool surface changed on the service, adopt the new contract —
   `node scripts/adopt-contract.mjs https://tm.jentrix.ai/api/mcp/contract`
   — and commit `surface.json`, `contract-vectors.json`, `contract.json`, the
   regenerated help goldens and the copy under `docs/contract/mvp.json`
   (fetch it from the manifest's `bundleUrl`). Say which digest the release
   adopts in the pull request.
3. Run the workflow's own gates locally: `pnpm typecheck && CLI_PACK_SMOKE=1
   pnpm test && pnpm validate:examples` (the smoke packs all three,
   cold-installs them together and runs the plugin dry runs).
4. Merge through a pull request (the `main` ruleset requires one, with a code
   owner's approval and a green `ci`), then tag and push the tag:
   ```bash
   git tag cli-v0.7.1
   git push origin cli-v0.7.1
   ```
5. Approve the `release` deployment in the Actions UI. The workflow then
   verifies the tag pins the CLI and the plugins agree with themselves,
   typechecks and tests, packs once, clean-installs the exact tarballs,
   installs an npm that speaks OIDC (>= 11.5.1; Node 22 bundles 10.9.x),
   publishes the three packages to `latest` over trusted publishing (plugins
   first, CLI last — no credential anywhere), **asks the registry whether all
   three versions actually exist**, and creates the GitHub Release. That
   registry step is not belt-and-braces: the publish steps exit 0 on a dry run
   by design, so their exit code cannot distinguish "released" from "released
   nothing". `DRY` is derived in the shell from an `IS_TAG` env var
   (`.github/scripts/publish-package.sh`), never by an Actions ternary
   (`a && b || c` yields an operand, not a boolean — a release once published
   nothing while every step reported success).

   **npm publishes asynchronously.** The registry answers the PUT with
   `202 … Your package is being processed and may take a few minutes to
   become available`, and the version appears minutes later. The check polls
   for ten minutes; when it still goes red, read the publish step first — a
   printed `+ @jentrix/cli@<version>` means the publish SUCCEEDED and is
   processing, so wait for `npm view @jentrix/cli@<version> version`, then
   `gh release create` the tag by hand (the release step is skipped after a
   red check). Never republish or re-run on that red: a hand publish followed
   by a tag of the same version hits `E409 Cannot publish over previously
   staged version` — one publish path per version, never both.
6. Verify what users now get — the release is already live:
   `npm view @jentrix/cli dist-tags` (expect `latest` at the new version), then
   `npm i -g @jentrix/cli && jentrix --version && jentrix plugin install`.
   If it is broken, roll `latest` back to the previous version with
   `npm login && npm dist-tag add @jentrix/cli@<previous> latest` — see the
   section above for why that step is manual.

Install afterward: `npm i -g @jentrix/cli`. Brew is not an install channel
(see above), which is why the install docs omit it.

## Preparing shared workflows

Edit provider-neutral rules under `plugins/workflows/`, and the short
provider entries/frontmatter there when a provider-specific change is needed.
Run `pnpm gen:workflows`, review both generated provider surfaces, and include
them with their sources. The CLI build and each plugin's prepack check reject
stale entries. The packed smoke checks all seven complete workflows and the
hook declarations in both independently installed packages.

The generator uses only Node builtins and repository files. Regeneration
requires no provider installation, hook trust change, network access, or
version bump. Local review can keep existing versions; maintainers must make
the normal release/version decision before distributing changed plugin text.

## How plugin changes ship

Both provider plugins are packages of their own — `@jentrix/plugin-claude`
under `plugins/claude`, `@jentrix/plugin-codex` under `plugins/codex` — and
the CLI depends on them with exact pins; `main.ts` resolves their
directories through module resolution, never a path next to `dist/`. Claude
Code and Codex copy a directory marketplace into their by-version cache, so an
edit under an unchanged `plugin.json` version is a no-op for every installed
operator: **bump the plugin's version (manifest + package.json) with the
change** and let the release deliver it. `jentrix plugin install` re-resolves
the package after `npm i -g @jentrix/cli@<version>`, pins the
hooks to absolute paths, and migrates an older registration two-phase: it
repoints only a row that is provably an installed copy of ours (npm global,
Homebrew, pnpm global, npx root), proves activation from the provider's own
listing, and restores the previous registration if anything fails. Do not
add a `claude plugin update` step to any in-repo ritual. (To test unreleased
plugin text locally, register a second marketplace under your own name
pointing at the checkout's `plugins/claude/` — a per-machine choice, not
part of any ritual; the installer refuses to repoint a checkout registration
and refuses to register from one over a global row.)

**Independent lanes** — a plugin-only release on its own tag — are not active.
They are activated on recorded evidence (a provider-only compatibility fix,
repeated plugin-only releases, a customer needing to pin plugins separately)
by widening the CLI's dependency range and giving the plugin its own tag; no
source change is needed, and a rehearsal publishes under a dist-tag or an
out-of-range version so live global installs are untouched.

## Manual publish (when Actions can't run)

The registry refuses an unprotected publish outright, so this requires
**2FA enabled on the npm account** and a second-factor approval per publish.

1. Run the workflow's own gates by hand — `pnpm typecheck` + `CLI_PACK_SMOKE=1
   pnpm test`.
2. `pnpm -r pack --pack-destination /tmp/jx-pack`, then `npm login`
   (`npm whoami` must print your account) and `npm publish <tarball> --access
   public --tag next` for the two plugins, then the CLI, WITHOUT `--otp`: a
   passkey account approves each publish in the browser (npm prints
   `Authenticate your account at …`), an authenticator-app account types the
   current code at `Enter OTP:`. Publish the tarballs, never the directories
   (a directory publish repacks).
3. Promote by hand (`npm dist-tag add … latest`, plugins first, CLI last) and
   `gh release create` the tag by hand.

Do NOT rerun the failed workflow afterwards — npm refuses duplicate versions;
the Homebrew tap catches up on the next tagged release.

## Manual Homebrew bump (when `HOMEBREW_TAP_TOKEN` isn't set)

In a checkout of `jentrix-au/homebrew-tap`, after the npm publish is live:

```bash
node /path/to/jentrix/scripts/render-homebrew-formula.mjs 0.7.0 \
  > Formula/jentrix.rb
git commit -am "jentrix 0.7.0" && git push
```

The source-of-truth formula template lives at
[`homebrew/jentrix.rb`](../homebrew/jentrix.rb).

## npm provenance

Nothing to add — `id-token: write` is on the publish job for trusted
publishing, and npm generates provenance automatically over that same OIDC
token from a public repository. `--provenance` is not needed and is not
passed. Provenance requires that every package's trusted publisher and
`repository.url` name THIS repository (setup steps 2 and 4).

## A compromised release

[`runbooks/compromised-release.md`](./runbooks/compromised-release.md):
freeze publication, rotate affected access, deprecate the versions (never
unpublish), rebuild a clean replacement through the same gates, move the
dist-tags, publish an advisory.
