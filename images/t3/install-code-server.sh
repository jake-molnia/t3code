#!/bin/sh
set -eu

case "${1:?target architecture required}" in
    amd64) checksum=65bcd20b524d03eb1b5adb7f360244599ef0e5b74089a46a982d32c074b97a29 ;;
    arm64) checksum=e5cc78da1d631c6cf6162f9b18eeaa8ee9d3239e1a88bb99d0602cdc5fa1852d ;;
    *) echo "Unsupported code-server architecture: $1" >&2; exit 1 ;;
esac

archive=$(mktemp)
trap 'rm -f "$archive"' EXIT
curl --fail --silent --show-error --location --retry 3 \
    "https://github.com/coder/code-server/releases/download/v4.141.0/code-server-4.141.0-linux-$1.tar.gz" -o "$archive"
printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check --strict
mkdir -p "${2:?installation directory required}"
tar -xzf "$archive" --strip-components=1 -C "$2"
