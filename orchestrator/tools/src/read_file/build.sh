#!/usr/bin/env bash
# Build read_file.wasm and copy it to tools/read_file.wasm.
# Run from repo root or orchestrator/ directory.
#
# Requires wasm32-wasip1 target:
#   rustup target add wasm32-wasip1

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$SCRIPT_DIR/../../read_file.wasm"

cd "$SCRIPT_DIR"
cargo build --target wasm32-wasip1 --release
cp target/wasm32-wasip1/release/read_file.wasm "$OUT"
echo "Built: $OUT ($(du -sh "$OUT" | cut -f1))"
