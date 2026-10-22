#!/bin/zsh
set -eu
cd "${0:A:h:h}"
if [[ -z "${RLW_BATCH_DIR:-}" || -z "${RLW_BATCH_BUILD:-}" ]]; then
  print -u2 '请提供已准备的 RLW_BATCH_DIR 和固定 RLW_BATCH_BUILD。'
  exit 2
fi
./scripts/run.sh exec -- node --import tsx scripts/batch-check-root.ts
./scripts/run.sh exec -- node scripts/batch-check-build.mjs
# Source sync is available; paid processing always needs the product switch after launch.
export RLW_ASR_OFFLINE=1 RLW_GENERATION_OFFLINE=1 RLW_VIEW="${RLW_VIEW:-library}"
export RLW_EVIDENCE_DIR="$RLW_BATCH_DIR/evidence"
unset RLW_BATCH_SOURCE_USER_DATA
unset SILICONFLOW_API_KEY DEEPSEEK_API_KEY
unset RLW_E3_REAL_DIR RLW_E3_REAL_QA RLW_E3_REAL_RUN RLW_E3_FIX_DIR RLW_E3_FIX_QA RLW_E3_DIR RLW_E3_QA RLW_E2_DIR RLW_E2_QA RLW_E2_FIX_QA RLW_E112_DIR RLW_E112_QA RLW_E111_DIR RLW_E111_QA RLW_E11_DIR RLW_E11_QA RLW_E1_DIR RLW_E1_ISOLATED RLW_DATA_DIR RLW_USER_DATA_DIR RLW_SOURCE_MODE RLW_BRIDGE_PROFILE RLW_LOGIN RLW_RETRY_CONTENT RLW_E1_QA RLW_ENABLE_EDITOR
exec "$RLW_BATCH_BUILD/ReadLaterE42.app/Contents/MacOS/Electron" "$RLW_BATCH_BUILD/main/main.js"
