#!/bin/sh
set -eu

case "${1:?target architecture required}" in
    amd64)
        aio_arch=x86_64
        aiod_sha256=1f52cb04e3e6e9df42e0937db060b390c3220af49a14e17bee8696ab9f11faae
        computer_sha256=7b8458e9e89ec6206eea36505efe55b8630e711adcff75afeca033029439405e
        ;;
    arm64)
        aio_arch=aarch64
        aiod_sha256=4871e7f6d0e2f0d4821d36b97c520d91c0dac304e9cfd4e95742a50174996344
        computer_sha256=fbe5a87c4f619abd9b3c55641dca232d5a88be85aa1568672248e9d9ba6d293d
        ;;
    *)
        echo "Unsupported desktop architecture: $1" >&2
        exit 1
        ;;
esac

mkdir -p "${2:?output directory required}"
cd "$2"
aio_base="https://aio-static.tos-cn-beijing.volces.com/v0.9.2/linux-${aio_arch}"
curl --fail --silent --show-error --location --retry 3 "${aio_base}/aiod" -o aiod
curl --fail --silent --show-error --location --retry 3 "${aio_base}/computer-use" -o computer-use
printf '%s  aiod\n%s  computer-use\n' "$aiod_sha256" "$computer_sha256" | sha256sum --check --strict
chmod 0755 aiod computer-use
