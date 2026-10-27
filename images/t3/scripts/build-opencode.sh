#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 2 ]]; then
  echo "usage: $0 {amd64|arm64} OUTPUT_DIRECTORY" >&2
  exit 2
fi
case "$1" in
  amd64) opencode_build_arch=x64 ;;
  arm64) opencode_build_arch=arm64 ;;
  *) echo "unsupported architecture: $1" >&2; exit 2 ;;
esac
opencode_repo=$(cd "$(dirname "$0")/.." && pwd)
opencode_output=$(realpath -m "$2")
read -r opencode_version opencode_commit opencode_sha256 opencode_bun < <(
  bun -e 'const pin = await Bun.file(process.argv[1]).json(); console.log(pin.opencode, pin.opencode_source.commit, pin.opencode_source.sha256, pin.opencode_source.bun)' "$opencode_repo/upstream.json"
)
[[ $(bun --version) == "$opencode_bun" ]]
opencode_build_root=$(mktemp -d /tmp/opencode-build.XXXXXX)
trap 'rm -rf "$opencode_build_root"' EXIT
curl -fsSL "https://codeload.github.com/anomalyco/opencode/tar.gz/$opencode_commit" -o "$opencode_build_root/source.tar.gz"
(cd "$opencode_build_root" && printf '%s  source.tar.gz\n' "$opencode_sha256" | sha256sum -c -)
mkdir "$opencode_build_root/source"
tar -xzf "$opencode_build_root/source.tar.gz" -C "$opencode_build_root/source" --strip-components=1
cd "$opencode_build_root/source"
patch --batch --fuzz=0 -p1 < "$opencode_repo/patches/opencode-mcp-tool-refresh.patch"
bun install --frozen-lockfile --cpu='*' --os=linux
cd packages/cli
OPENCODE_VERSION="$opencode_version" OPENCODE_CHANNEL=latest bun run script/build.ts \
  --target="opencode-linux-$opencode_build_arch" --skip-install --skip-web-ui --outdir="$opencode_output"
cp "$opencode_output/cli-linux-$opencode_build_arch/bin/opencode" "$opencode_output/opencode"
