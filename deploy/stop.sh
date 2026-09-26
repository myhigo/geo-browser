#!/usr/bin/env bash
# geo-browser 停止服务（本地 Chrome 版，非 docker）
set -euo pipefail
cd "$(dirname "$0")" || exit 1

ENV_FILE="geo-browser-env"
[ -f "${ENV_FILE}" ] || { echo "[错误] 缺少 ${ENV_FILE}"; exit 1; }

set -a
# shellcheck disable=SC1090
. "./${ENV_FILE}"
set +a

PORT="${PORT:-8787}"

# 找监听端口的进程并停止
pids="$(lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)"
if [ -z "${pids}" ]; then
  echo "服务未在运行"
  exit 0
fi
kill ${pids} 2>/dev/null || true

# 确认服务已完全退出再报完成
alive=1
for i in $(seq 1 15); do
  if ! lsof -tiTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then alive=0; break; fi
  sleep 1
done
if [ "${alive}" -eq 0 ]; then
  echo "服务已停止"
else
  echo "[提示] 服务未完全退出，请检查：lsof -iTCP:${PORT}"
  exit 1
fi
