#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENDOR_DIR="$ROOT_DIR/vendor/Syphon-Framework"
BUILD_DIR="$ROOT_DIR/build"

if [[ ! -d "$VENDOR_DIR" ]]; then
  git clone https://github.com/Syphon/Syphon-Framework.git "$VENDOR_DIR"
fi

xcodebuild \
  -project "$VENDOR_DIR/Syphon.xcodeproj" \
  -scheme Syphon \
  -configuration Release \
  CONFIGURATION_BUILD_DIR="$BUILD_DIR" \
  build >/dev/null

echo "Built Syphon.framework into $BUILD_DIR"
