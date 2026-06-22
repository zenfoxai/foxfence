# Homebrew formula for foxfence.
#
# This is the canonical source; the release workflow renders the __VERSION__ and
# __SHA_*__ placeholders from each release's binaries and uploads the result as
# a `foxfence.rb` asset. Copy that rendered file into the tap repo
# (zenfoxai/homebrew-tap) so users can:
#
#     brew install zenfoxai/tap/foxfence
#
class Foxfence < Formula
  desc "Model reliability & safety module for agents (OpenAI-compatible proxy)"
  homepage "https://github.com/zenfoxai/foxfence"
  version "__VERSION__"
  license "Apache-2.0"

  on_macos do
    on_arm do
      url "https://github.com/zenfoxai/foxfence/releases/download/v#{version}/foxfence-darwin-arm64"
      sha256 "__SHA_DARWIN_ARM64__"
    end
    on_intel do
      url "https://github.com/zenfoxai/foxfence/releases/download/v#{version}/foxfence-darwin-x64"
      sha256 "__SHA_DARWIN_X64__"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/zenfoxai/foxfence/releases/download/v#{version}/foxfence-linux-arm64"
      sha256 "__SHA_LINUX_ARM64__"
    end
    on_intel do
      url "https://github.com/zenfoxai/foxfence/releases/download/v#{version}/foxfence-linux-x64"
      sha256 "__SHA_LINUX_X64__"
    end
  end

  def install
    bin.install Dir["foxfence-*"].first => "foxfence"
  end

  test do
    assert_match "foxfence #{version}", shell_output("#{bin}/foxfence --version")
  end
end
