#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

"$ROOT_DIR/build-framework.sh" >&2
export DYLD_FRAMEWORK_PATH="$ROOT_DIR/build${DYLD_FRAMEWORK_PATH:+:$DYLD_FRAMEWORK_PATH}"

exec swift run \
  --quiet \
  --package-path "$ROOT_DIR" \
  wintercircus-syphon-adapter \
  "$@"
