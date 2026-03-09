#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
VERSION=$(node -p "require('$ROOT_DIR/package.json').version")
OUT="$ROOT_DIR/../iobroker.cpt-$VERSION.zip"
cd "$ROOT_DIR"
zip -r "$OUT" . -x "*.git*" "node_modules/*" >/dev/null
echo "Created: $OUT"
