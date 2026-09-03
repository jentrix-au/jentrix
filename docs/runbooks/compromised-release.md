# Runbook — compromised release

Use this when a published version of `@jentrix/cli`, `@jentrix/plugin-claude`
or `@jentrix/plugin-codex` is suspected or known to be malicious, or to have
been built by a compromised pipeline or account. The five steps are the
policy stated in [SECURITY.md](../../SECURITY.md) and the PRD (§7): there is
**no remote deletion of local files and no client kill switch**, and nothing
is ever unpublished — an unpublished version breaks every lockfile that pins
it and hides the evidence.

## 0. Triage (first 30 minutes)

- Name the affected package(s) and version(s). `npm view <pkg> versions
  --json` and `npm view <pkg>@<v> dist.shasum` give the registry's view; the
  release run's "Prove the candidates are on npm" step prints what it saw.
- Compare provenance: each published version carries a provenance
  attestation naming this repository, `release.yml` and the commit. A
  version whose attestation is missing or names a different source did not
  come from the release workflow.
- Decide the blast radius: `latest` (every `npx --package @jentrix/cli@latest
  jentrix setup` and `npm i -g`), `next` (candidates only), or a specific
  pinned version.

## 1. Freeze publication

- Remove every trusted publisher for the three packages on npmjs.com, or
  point them at a non-existent workflow name; this stops any further OIDC
  publish immediately.
- Delete the `release` environment's required-reviewer list and replace it
  with the incident owner only, so no queued run can be approved by habit.
- Revoke `NPM_PROMOTE_TOKEN` on npm and delete it from the environment.
- Lock the `main` ruleset to require two approvals until the replacement is
  out.

## 2. Rotate affected access

- npm: rotate the maintainer accounts' passwords and second factors; revoke
  every granular access token on the `jentrix` org.
- GitHub: rotate the maintainer accounts' credentials; audit
  `jentrix-au/jentrix` for unexpected collaborators, deploy keys, Actions
  secrets and workflow changes; re-review CODEOWNERS.
- Anything the compromised version could have read on a customer machine —
  Jentrix tokens (`tm_`, `tmo_`, `tmr_`) — is treated as exposed: revoke
  OAuth grants and personal access tokens minted before the fix through the
  service, and tell users to run `jentrix login` again.

## 3. Deprecate the versions (never unpublish)

```bash
npm deprecate @jentrix/cli@<bad> "Security: do not install — see GHSA-…; upgrade to <fixed>"
```

for each affected package and version, and move the `next` and `latest`
dist-tags back to the last known-good versions (plugins first, CLI last)
so a fresh install cannot pick the bad one:

```bash
npm dist-tag add @jentrix/plugin-claude@<good> latest
npm dist-tag add @jentrix/plugin-codex@<good> latest
npm dist-tag add @jentrix/cli@<good> latest
```

## 4. Build a clean replacement through the same gates

- From a clean clone of the reviewed commit, on a machine that was not part
  of the incident, cut the fix and a new version. No shortcut around
  `ci.yml`, the pack-once smoke, or the `release` environment — the gates
  are the evidence that the replacement is clean.
- Re-register the trusted publishers, run the manual dry run, tag, watch
  the registry proof, install the candidate from `next` on a clean machine
  and run `jentrix session doctor`, then promote.

## 5. Publish an advisory

- A GitHub security advisory on this repository (GHSA), naming the affected
  versions, the fixed version, what the compromised code did, what users
  must rotate, and the timeline.
- The npm deprecation message (step 3) links to it.
- Release notes on the fixed version link to it.
- Notify users through the channels the launch checklist names (the
  in-app documentation's install page carries a notice for the support
  window of the fix).

## What we tell users to do

1. `npm i -g @jentrix/cli@<fixed>` then `jentrix plugin install claude` /
   `codex` (the installer repoints the marketplaces and re-pins hooks).
2. `jentrix logout && jentrix login` to replace tokens minted while the
   bad version was installed.
3. `jentrix session doctor` — every line `ok`, contract "tested contract".

We never reach into a customer machine: no remote deletion, no kill switch,
no automatic update. The customer decides when to act; our job is to make
the fixed version and the facts available fast.
