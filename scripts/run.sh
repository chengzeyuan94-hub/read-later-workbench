#!/bin/zsh
set -eu
cd "${0:A:h:h}"
if [[ -n "${NODE24_BIN:-}" ]]; then
  export PATH="$NODE24_BIN:$PATH"
fi
if [[ "$(node -p 'process.versions.node.split(".")[0]')" != 24 ]]; then
  print -u2 '需要 Node 24。请设置 NODE24_BIN 为其 bin 目录。'
  exit 1
fi
exec npm "$@"
