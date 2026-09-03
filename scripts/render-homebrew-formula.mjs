#!/usr/bin/env node
/**
 * Render the Homebrew formula for `@jentrix/cli` at a given version by
 * fetching the PUBLISHED npm tarball and hashing it (Homebrew needs a real
 * sha256 of the exact artifact). Prints the formula to stdout.
 *
 *   node scripts/render-homebrew-formula.mjs 0.7.0 > Formula/jentrix.rb
 *
 * Used by `.github/workflows/release.yml` (after `npm publish`) and runnable
 * by hand for a manual tap bump — see `docs/releasing.md`. Node >= 20 (global
 * `fetch`).
 */
import { createHash } from "node:crypto";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
  process.stderr.write("usage: render-homebrew-formula.mjs <version>\n");
  process.exit(1);
}

// Scoped-package tarball path drops the SCOPE from the filename, keeping the
// bare package name — so `@jentrix/cli` is `cli-<version>.tgz`, not
// `jentrix-cli-<version>.tgz` and no longer `stacks-cli-<version>.tgz`. The
// rename changed this path; getting it wrong renders a formula whose `url`
// 404s at install time rather than at release time.
const url = `https://registry.npmjs.org/@jentrix/cli/-/cli-${version}.tgz`;

const res = await fetch(url);
if (!res.ok) {
  process.stderr.write(
    `failed to fetch ${url}: ${res.status} ${res.statusText}\n` +
      "(is the version published to npm yet?)\n",
  );
  process.exit(1);
}
const sha256 = createHash("sha256")
  .update(Buffer.from(await res.arrayBuffer()))
  .digest("hex");

process.stdout.write(`require "language/node"

class Jentrix < Formula
  desc "Command-line client for the Jentrix MCP surface"
  homepage "https://tm.jentrix.ai/docs/cli"
  url "${url}"
  sha256 "${sha256}"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *Language::Node.std_npm_install_args(libexec)
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match "surface:", shell_output("#{bin}/jentrix --version")
  end
end
`);
