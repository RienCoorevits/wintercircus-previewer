#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="${NDI_SDK_DIR:-/Library/NDI SDK for Apple}/lib/macOS"

export DYLD_LIBRARY_PATH="$LIB_DIR${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"

exec swift run \
  --quiet \
  --package-path "$ROOT_DIR" \
  wintercircus-ndi-adapter \
  "$@"
