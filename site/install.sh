#!/usr/bin/env bash
# Superbar web installer: downloads a release, verifies its checksum, and runs
# the bundled scripts/install.sh. Usage:
#   curl -fsSL https://kbohara315.github.io/superbar/install.sh | bash
#   ... | bash -s -- v0.1.0     # pin a version
set -euo pipefail

REPO='kbohara315/superbar'
version="${1:-latest}"

case "$(uname -m)" in
    x86_64) arch=x86_64 ;;
    aarch64|arm64) arch=aarch64 ;;
    *) echo "superbar: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

if [[ "$version" == latest ]]; then
    version=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/${REPO}/releases/latest")
    version=${version##*/}
fi
[[ "$version" =~ ^v[0-9][0-9A-Za-z._-]*$ ]] || { echo "superbar: bad version '$version'" >&2; exit 1; }
base="https://github.com/${REPO}/releases/download/${version}"

name="superbar-${version}-linux-${arch}"
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT

echo "Downloading ${name}..."
curl -fsSL -o "$tmp/${name}.tar.gz" "${base}/${name}.tar.gz"
curl -fsSL -o "$tmp/SHA256SUMS" "${base}/SHA256SUMS"
(cd "$tmp" && grep -F " ${name}.tar.gz" SHA256SUMS | sha256sum -c -)

tar -C "$tmp" -xzf "$tmp/${name}.tar.gz"
"$tmp/${name}/scripts/install.sh"
