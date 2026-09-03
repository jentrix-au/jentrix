#!/usr/bin/env bash
# Publish ONE packed tarball to npm under the `next` dist-tag over trusted
# publishing (release.yml, open-client PRD §5.2). Usage:
#
#   publish-candidate.sh <tarball> plugin|cli
#
# Environment: IS_TAG ("true" on a cli-v* tag run; anything else = dry run).
# `--loglevel verbose` is load-bearing and DRY is derived in the shell — the
# reasons are written above the steps that call this in release.yml.
#
# THE DRY RUN MUST PROVE THE EXCHANGE. npm's OIDC helper never throws: a
# refused exchange is a `verbose` line and a silent fallthrough, and a dry run
# never PUTs, so nothing downstream can fail on the missing publisher. For a
# package that is not on npm at all there is not even a version to collide
# with: `npm publish --dry-run` prints `+ <pkg>@<version>` and exits 0 having
# proven NOTHING (the 2026-09-03 dry run did exactly that for both plugin
# packages, `POST 404 … package not found` sitting in the verbose log above a
# green step). So on a dry run this script also requires the exchange's own
# success line and turns its absence into the red it always should have been.
#
# Exit 0 means: published (tag); or the dry run's OIDC exchange succeeded and
# npm then either completed the dry run or stopped at "cannot publish over the
# previously published versions" (the version is already on npm — the pass);
# or — on a TAG, for a PLUGIN only — that same message, which is the
# coordinated train republishing a plugin whose version did not move. For the
# CLI on a tag that message is a real fault (its version always equals the
# fresh tag). Everything else exits non-zero, naming the reason.
set -euo pipefail
tarball="${1:?tarball}"
kind="${2:?plugin|cli}"
DRY="--dry-run"; [ "${IS_TAG:-}" = "true" ] && DRY=""
log="$(mktemp)"
status=0
npm publish "$tarball" --access public --tag next --loglevel verbose $DRY 2>&1 | tee "$log" || status=$?

exchanged() {
  grep -q "oidc Successfully retrieved and set token" "$log" ||
    grep -Eq "POST 201 .*/oidc/token/exchange/package/" "$log"
}

if [ -n "$DRY" ]; then
  if ! exchanged; then
    reason="$(grep -Eo "OIDC token exchange error[^\"]*" "$log" | head -n1 || true)"
    echo "::error::$tarball: the dry run proved nothing — no OIDC exchange succeeded${reason:+ ($reason)}. No trusted publisher is registered for this package on npmjs.com (for a package that is not on npm yet, register one against jentrix-au/jentrix + release.yml + environment release — docs/releasing.md)."
    exit 1
  fi
  if [ "$status" -eq 0 ]; then
    echo "::notice::Dry run PASSED for $tarball — trusted publishing authenticated (see the oidc token exchange above); this version is not on npm yet, so a tag would publish it."
    exit 0
  fi
  if grep -q "cannot publish over the previously published versions" "$log"; then
    echo "::notice::Dry run PASSED for $tarball — trusted publishing authenticated (see the oidc token exchange above); this version is already on npm, which is why the publish stopped."
    exit 0
  fi
  exit "$status"
fi

[ "$status" -eq 0 ] && exit 0
if [ "$kind" = "plugin" ] && grep -q "cannot publish over the previously published versions" "$log"; then
  echo "::notice::$tarball unchanged — this plugin version is already on npm (coordinated train, plugin not bumped); nothing to publish."
  exit 0
fi
exit "$status"
