# Homebrew formula for the Jentrix CLI (`@jentrix/cli`).
#
# This is the SOURCE-OF-TRUTH copy. The live formula lives in the tap repo
# `jentrix-au/homebrew-tap` at `Formula/jentrix.rb`; the release workflow
# (`.github/workflows/release.yml`) regenerates it from the published npm
# tarball on every `cli-v*` tag via `scripts/render-homebrew-formula.mjs`.
#
# `url` + `sha256` below are PLACEHOLDERS for the first release — the render
# script fills them with the real published tarball + hash. Install target:
#   brew install jentrix-au/tap/jentrix
#
# The old `Formula/stacks.rb` is left in the tap pointing at the last
# `@jentrix/stacks-cli` release rather than deleted, so `brew upgrade` on an
# existing install does not break; it is retired by hand once nobody is on it.
require "language/node"

class Jentrix < Formula
  desc "Command-line client for the Jentrix MCP surface"
  homepage "https://tm.jentrix.ai/docs/cli"
  url "https://registry.npmjs.org/@jentrix/cli/-/cli-0.1.0.tgz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
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
