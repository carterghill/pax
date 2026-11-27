#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

build_env=(GIPHY_API_KEY PAX_HOMESERVER PAX_SERVER_NAME PAX_REGISTRATION_TOKEN
           PAX_HIDE_SERVER_CONFIG PAX_PUSH_GATEWAY_URL PAX_IOS_VOIP_PUSH_GATEWAY_URL
           PAX_IOS_BADGE_PUSH_GATEWAY_URL VITE_TENOR_API_KEY)

# Configures docker_cmd for this build, including first-run setup when needed.
source scripts/linux/prerequisites.sh
prepare_linux_builder

output="$PWD/src-tauri/target/linux-packages"
mkdir -p "$output"
stage=$(mktemp -d "$output/.build-XXXXXXXX")
trap 'rm -rf "$stage"' EXIT

# Send only release inputs. Include local build settings just as a desktop build would.
inputs=(package.json package-lock.json index.html tsconfig*.json vite.config.ts
        rust-toolchain.toml public src src-tauri scripts/linux)
for file in .env .env.local .env.production .env.production.local; do
  if [[ -f $file ]]; then inputs+=("$file"); fi
done
env_args=()
for key in "${build_env[@]}"; do
  if [[ -v $key ]]; then env_args+=(--env "$key"); fi
done

for arch in arm64 amd64; do
  tag="pax-linux-builder:$arch"
  echo "Building Pax for linux/$arch"
  "${docker_cmd[@]}" build --platform "linux/$arch" --tag "$tag" scripts/linux
  tar --exclude=src-tauri/target --exclude=src-tauri/gen/android \
      --exclude=src-tauri/gen/apple -cf - "${inputs[@]}" |
    "${docker_cmd[@]}" run --platform "linux/$arch" --rm -i "${env_args[@]}" "$tag" \
      bash -ec 'tar -xf -; bash scripts/linux/package.sh "$1" >&2; tar -C /packages -cf - .' bash "$arch" > "$stage/$arch.tar"
  tar --no-same-owner -xf "$stage/$arch.tar" -C "$stage"
  rm "$stage/$arch.tar"
done

mv "$stage"/*.deb "$stage"/*.pkg.tar.zst "$output/"
echo "Linux packages written to $output"
