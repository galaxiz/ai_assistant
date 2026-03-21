#!/usr/bin/env bash
# Generate Python gRPC stubs from the shared proto file.
#
# Run from the repo root:
#   bash cognition-engine/scripts/generate_proto.sh
#
# Output goes to:
#   cognition-engine/cognition_engine/generated/

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROTO_DIR="${REPO_ROOT}/proto"
OUT_DIR="${REPO_ROOT}/cognition-engine/cognition_engine/generated"
VENV_PYTHON="${REPO_ROOT}/cognition-engine/.venv/bin/python"

mkdir -p "${OUT_DIR}"
touch "${OUT_DIR}/__init__.py"

echo "Generating stubs from ${PROTO_DIR}/cognition.proto → ${OUT_DIR}"

"${VENV_PYTHON}" -m grpc_tools.protoc \
  --proto_path="${PROTO_DIR}" \
  --python_out="${OUT_DIR}" \
  --grpc_python_out="${OUT_DIR}" \
  cognition.proto

# grpc_tools generates absolute imports like "import cognition_pb2"
# but the generated files live inside a sub-package, so fix to relative.
sed -i '' 's/^import cognition_pb2/from . import cognition_pb2/' \
  "${OUT_DIR}/cognition_pb2_grpc.py" 2>/dev/null \
  || sed -i 's/^import cognition_pb2/from . import cognition_pb2/' \
       "${OUT_DIR}/cognition_pb2_grpc.py"

echo "Done."
