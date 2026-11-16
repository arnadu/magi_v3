#!/usr/bin/env bash
# Installs the CodeQL CLI that `npm run trace` uses: the JavaScript bundle of
# one pinned release, checked against its published SHA-256, into
# $CODEQL_HOME (default ~/.cache/magi/codeql). Does nothing when that
# version is already there. Needs curl, tar and zstd.
set -euo pipefail

VERSION="2.27.4"
ASSET="codeql-bundle-javascript-linux64.tar.zst"
SHA256="082e798c97831283a2a5f69e9198c51270e5767013d5333daeeab6520af9ce72"
URL="https://github.com/github/codeql-action/releases/download/codeql-bundle-v${VERSION}/${ASSET}"

HOME_DIR="${CODEQL_HOME:-$HOME/.cache/magi/codeql}"
MARKER="$HOME_DIR/codeql/.magi-version"

if [[ -f "$MARKER" && "$(cat "$MARKER")" == "$VERSION" ]]; then
	echo "[install-codeql] CodeQL $VERSION already in $HOME_DIR"
	exit 0
fi
for tool in curl tar zstd sha256sum; do
	command -v "$tool" >/dev/null || { echo "[install-codeql] $tool is required" >&2; exit 1; }
done

mkdir -p "$HOME_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "[install-codeql] downloading CodeQL $VERSION"
curl -fsSL --retry 3 -o "$TMP/$ASSET" "$URL"
echo "$SHA256  $TMP/$ASSET" | sha256sum -c --quiet - || {
	echo "[install-codeql] checksum mismatch for $ASSET: refusing to install" >&2
	exit 1
}
rm -rf "$HOME_DIR/codeql"
tar --zstd -xf "$TMP/$ASSET" -C "$HOME_DIR"
echo "$VERSION" > "$MARKER"
echo "[install-codeql] installed $("$HOME_DIR/codeql/codeql" version --format=terse) in $HOME_DIR"
