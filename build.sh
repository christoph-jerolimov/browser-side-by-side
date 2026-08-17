#!/usr/bin/env bash
# Build installable zip bundles for both browser extensions into dist/.
set -euo pipefail

cd "$(dirname "$0")"

VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' chrome/manifest.json)
DIST="dist"

mkdir -p "$DIST"

for browser in chrome firefox; do
  out="$DIST/docs-side-by-side-$browser-$VERSION.zip"
  rm -f "$out"
  (cd "$browser" && zip -r -q "../$out" . -x '.*')
  echo "Built $out"
done
