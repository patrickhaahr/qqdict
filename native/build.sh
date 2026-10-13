#!/bin/zsh
set -euo pipefail
NATIVE_DIR="${0:A:h}"
QQDICT_BUILD_ARCH="${QQDICT_ARCH:-$(uname -m)}"
case "$QQDICT_BUILD_ARCH" in
  arm64) QQDICT_TARGET_ARCH="arm64" ;;
  x64|x86_64) QQDICT_TARGET_ARCH="x86_64" ;;
  *) print -u2 "Unsupported macOS architecture: $QQDICT_BUILD_ARCH"; exit 1 ;;
esac
mkdir -p "$NATIVE_DIR/build/module-cache"
xcrun swiftc -O -target "$QQDICT_TARGET_ARCH-apple-macos13.0" \
  -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  -module-cache-path "$NATIVE_DIR/build/module-cache" \
  "$NATIVE_DIR/DictationBridge.swift" \
  -o "$NATIVE_DIR/build/DictationBridge" \
  -framework AppKit -framework ApplicationServices -framework CoreGraphics
# A stable identifier is retained when the release packager re-signs this helper.
/usr/bin/codesign --force --sign - --timestamp=none \
  --identifier io.github.qwertyu-alex.qqdict.bridge \
  "$NATIVE_DIR/build/DictationBridge"
