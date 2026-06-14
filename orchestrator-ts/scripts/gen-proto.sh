#!/usr/bin/env bash
# Generates TypeScript types + gRPC service stubs from proto/cognition.proto.
# Requires: protoc, and ts-proto plugin (installed via npm install).
# Usage: npm run proto:gen
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUT_DIR="$SCRIPT_DIR/../src/generated"

mkdir -p "$OUT_DIR"

protoc \
  --plugin="$SCRIPT_DIR/../node_modules/.bin/protoc-gen-ts_proto" \
  --ts_proto_out="$OUT_DIR" \
  --ts_proto_opt=esModuleInterop=true \
  --ts_proto_opt=outputServices=grpc-js \
  --ts_proto_opt=useOptionals=messages \
  --ts_proto_opt=env=node \
  -I "$REPO_ROOT/proto" \
  "$REPO_ROOT/proto/cognition.proto"

echo "Proto codegen complete → $OUT_DIR"
