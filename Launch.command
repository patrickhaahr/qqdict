#!/bin/zsh
set -euo pipefail
cd -- "$(dirname -- "$0")"
export QQDICT_CHANNEL=nightly
if [[ -d "release/qqdict Nightly.app" ]]; then
  exec /usr/bin/open "release/qqdict Nightly.app"
fi
pnpm run build:native
pnpm run build
exec ./node_modules/.bin/electron .
