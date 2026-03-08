#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
VERSION="$(node -p "require('./package.json').version")"
OUT="iobroker.cpt-${VERSION}.zip"
rm -f "$OUT"
zip -r "$OUT" . \
  -x "*.git*" \
  -x "node_modules/*" \
  -x "*.zip" \
  -x "README.txt" \
  -x "test_write.txt"
echo "$OUT"
