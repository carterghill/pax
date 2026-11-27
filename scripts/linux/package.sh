#!/usr/bin/env bash
# Runs inside the target-architecture builder.
set -euo pipefail
expected_arch=${1:?Missing target Debian architecture}
[[ $(dpkg --print-architecture) == "$expected_arch" ]]
npm ci
npm run tauri -- build --bundles deb -- --locked
debs=(src-tauri/target/release/bundle/deb/*.deb)
[[ ${#debs[@]} == 1 && -f ${debs[0]} ]]
deb=${debs[0]}

[[ $(dpkg-deb -f "$deb" Architecture) == "$expected_arch" ]]
case "$expected_arch" in
  amd64) arch=x86_64; machine='Advanced Micro Devices X86-64' ;;
  arm64) arch=aarch64; machine=AArch64 ;;
  *) echo "Unexpected Debian package architecture" >&2; exit 1 ;;
esac

work=/home/builder/package
install -d -o builder -g builder "$work" /packages
dpkg-deb -x "$deb" "$work/payload"
readelf -h "$work/payload/usr/bin/pax" | grep -F "$machine"
cp scripts/linux/PKGBUILD "$work/"
version=$(dpkg-deb -f "$deb" Version)
cd "$work"
# Debian's makepkg configuration can default to a different CARCH.
cp /etc/makepkg.conf ./makepkg.conf
printf '\nCARCH=%s\nPKGEXT=.pkg.tar.zst\n' "$arch" >> makepkg.conf
runuser -u builder -- env PAX_VERSION="${version//-/_}" PKGDEST=/packages \
    makepkg --config "$work/makepkg.conf" --nodeps
pkg=(/packages/*.pkg.tar.zst)
[[ ${#pkg[@]} == 1 ]]
pacman -Qp "${pkg[0]}"
cp "/work/$deb" /packages/
