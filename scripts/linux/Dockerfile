FROM node:22-bookworm AS node
FROM rust:bookworm

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        clang cmake libasound2-dev libayatana-appindicator3-dev libclang-dev \
        libdbus-1-dev libgbm-dev libgstreamer-plugins-base1.0-dev libssl-dev libva-dev \
        libwebkit2gtk-4.1-dev libxcb-randr0-dev libxcb-shm0-dev libxcb1-dev \
        libxdo-dev libxss-dev makepkg pacman-package-manager protobuf-compiler \
        libarchive-tools zstd \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home builder

WORKDIR /work
