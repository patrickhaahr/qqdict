#!/bin/zsh
set -euo pipefail
cd -- "$(dirname -- "$0")"
if [[ -d "release/qqdict.app" ]]; then
  exec /usr/bin/open "release/qqdict.app"
fi
if [[ ! -x native/build/DictationBridge || native/DictationBridge.swift -nt native/build/DictationBridge ]]; then
  pnpm run build:native
fi
if [[ ! -f dist/main.js ]]; then
  pnpm run build
fi
exec ./node_modules/.bin/electron .
