# Runbook — publish failure or partial promotion

The release is pack-once and candidate-first ([releasing](../releasing.md)):
a `cli-v*` tag publishes the three packages to the `next` dist-tag (plugins
first, CLI last), and `latest` moves only in a separate promote run. That
order is what makes every failure below recoverable without unpublishing —
nothing is ever unpublished.

## Read the run before touching anything

Open the failed `release` run and find the first red step:

| Red step | Meaning | Do |
| --- | --- | --- |
| "Derive and verify CLI version" | The tag does not match `package.json` / `CLI_VERSION`, or a plugin's manifest and package.json disagree | Nothing was published. Delete the tag (`git push origin :refs/tags/cli-vX.Y.Z`), fix, merge, re-tag |
| Typecheck / test / pack / clean-install | A gate failed before publish | Nothing was published. Fix on `main`, re-tag the fixed head (the same version is still free) |
| "Publish @jentrix/plugin-…" or "Publish @jentrix/cli" with `POST 404 … package not found` | No trusted publisher matches this repository + `release.yml` + environment `release` for that package | Nothing was published for that package. Register (or re-point) the publisher on npmjs.com, run the manual dry run until green, then re-tag **only if nothing else published** — see "mixed candidate" below |
| "Publish …" with `E409 Cannot publish over previously staged version` | The same version was published by another path minutes earlier (a hand publish) and npm is still processing it | Wait; never re-run. `npm view <pkg>@<v> version` until it answers, then continue with the promote |
| "Prove the candidates are on npm" red after ten minutes | npm's asynchronous processing is slow, or a publish step failed silently | Read each publish step: `+ <pkg>@<v>` printed = published and processing → wait and check `npm view`; not printed = not published |
| "Verdict on the plugin publishes" | A plugin publish failed while the CLI's dry-run/publish step still ran | On a tag the CLI step is skipped when a plugin failed, so the candidate set is incomplete — "mixed candidate" below |
| "Create GitHub Release" | Everything is on npm; only the announcement failed | `gh release create cli-vX.Y.Z --title "Jentrix CLI vX.Y.Z (candidate)" --notes "…"` by hand |

## Mixed candidate on `next`

A tag run that published one or two packages and not the third leaves
`next` inconsistent — but `latest` untouched, so no user is affected. Two
cases:

- **The CLI did not publish** (a plugin failed first): fix the plugin's
  cause, then re-tag the **same** version only if the CLI step never ran for
  it. The plugin that already published is a no-op on the re-run ("cannot
  publish over" is success for a plugin on a tag).
- **A plugin published under a version the CLI does not pin**: the CLI
  candidate's `dependencies` decide what a promotion moves, so a stray
  plugin version on `next` is harmless. Leave it.

Never publish a version by hand that a tag also tried: one path per version.

## Partial promotion (`latest` mixed)

The promote job moves `latest` plugins first, CLI last, and aborts before
moving anything when a package is missing from npm. A red promote run
therefore leaves one of two states:

- **Nothing moved** — read the error; usually `NPM_PROMOTE_TOKEN` missing on
  the `release` environment, or a version not yet visible. Fix, re-run the
  promote with the same `promote=<version>`.
- **Plugins moved, the CLI did not** (a failure between the two
  `dist-tag add` calls): `latest` now installs the previous CLI with newer
  plugins. The CLI pins its plugin versions exactly, so an `npm i -g
  @jentrix/cli` still installs the previous, consistent set — `latest` on
  the plugin packages is informational for installs through the CLI.
  Finish by hand: `npm dist-tag add @jentrix/cli@<version> latest`, then
  `npm view @jentrix/cli dist-tags`.

To roll a promotion back, move `latest` back to the previous versions with
`npm dist-tag add` in the same order (plugins, then CLI); the previous
tarballs are still on npm.

## Homebrew

The `bump-homebrew` job is a clean skip until `HOMEBREW_TAP_TOKEN` and the
tap exist; a red there never affects npm.

## Afterwards

Write what happened on the release's GitHub Release page (or the issue that
tracked it): which packages reached `next`, which reached `latest`, and the
run ids. If a publisher had to be re-registered, note it in
[releasing](../releasing.md)'s one-time setup so the next person does not
rediscover it.
