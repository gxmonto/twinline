#!/usr/bin/env bash
#
# Build the Linux packages (.deb, .rpm, AppImage) in a container.
#
# electron-builder cannot produce .deb or .rpm on Windows — those targets need
# fpm and rpmbuild, which are Linux tools. This script runs the build inside
# electron-builder's official image and copies the artefacts back into ./dist.
#
# Usage:  bash tools/build-linux.sh [extra electron-builder args]
#
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${BUILDER_IMAGE:-electronuserland/builder:20}"

echo "==> Building Linux packages in ${IMAGE}"
echo "    project: ${PROJECT_DIR}"

# The host's node_modules holds Windows/macOS binaries, so the container copies
# the sources to a scratch directory and installs its own. ./dist is mounted
# read-write so the finished packages land on the host.
docker run --rm \
  -v "${PROJECT_DIR}:/project:ro" \
  -v "${PROJECT_DIR}/dist:/out" \
  -e ELECTRON_CACHE=/root/.cache/electron \
  -e ELECTRON_BUILDER_CACHE=/root/.cache/electron-builder \
  "${IMAGE}" \
  /bin/bash -c '
    set -euo pipefail
    mkdir -p /build
    cd /project
    # Copy everything the build needs, but never the host node_modules or dist.
    tar -cf - --exclude=node_modules --exclude=dist --exclude=.git . | (cd /build && tar -xf -)
    cd /build
    npm install --no-audit --no-fund
    npx electron-builder --linux '"$*"'
    # Mirror the host layout: dist/<version>/ per release.
    VERSION="$(node -p "require(\"./package.json\").version")"
    mkdir -p "/out/${VERSION}"
    cp -v "dist/${VERSION}"/*.deb "dist/${VERSION}"/*.rpm "dist/${VERSION}"/*.AppImage "/out/${VERSION}/" 2>/dev/null || true
    cp -v "dist/${VERSION}"/*.yml "/out/${VERSION}/" 2>/dev/null || true
  '

# sed rather than node: on Windows/Git Bash, node cannot resolve the /c/... form.
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "${PROJECT_DIR}/package.json" | head -1)"
echo "==> Done. Artefacts in ${PROJECT_DIR}/dist/${VERSION}:"
ls -lh "${PROJECT_DIR}/dist/${VERSION}" | grep -Ei '\.(deb|rpm|AppImage)$' || echo "    (none found)"
