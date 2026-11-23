#!/usr/bin/env bash
# Installs trivy at a pinned version into $1 (default ~/.cache/magi/trivy), checking the
# release's published SHA-256. A newer version is a deliberate change of this file.
set -euo pipefail
VERSION=0.76.1
DEST="${1:-$HOME/.cache/magi/trivy}"
mkdir -p "$DEST"
if [ -x "$DEST/trivy" ] && "$DEST/trivy" --version | grep -qx "Version: $VERSION"; then
	echo "$DEST/trivy"
	exit 0
fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
BASE="https://github.com/aquasecurity/trivy/releases/download/v$VERSION"
TARBALL="trivy_${VERSION}_Linux-64bit.tar.gz"
curl -fsSL -o "$TMP/$TARBALL" "$BASE/$TARBALL"
curl -fsSL -o "$TMP/checksums.txt" "$BASE/trivy_${VERSION}_checksums.txt"
(cd "$TMP" && grep " $TARBALL\$" checksums.txt | sha256sum -c - >&2)
tar -xzf "$TMP/$TARBALL" -C "$DEST" trivy
echo "$DEST/trivy"
