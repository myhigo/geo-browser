#!/usr/bin/env bash
# geo-browser 一键启动（本地 Chrome 版，非 docker）
#
# 用法：
#   1. 进入 deploy 目录
#   2. 用文本编辑器打开 geo-browser-env，按需修改（默认值已配好，一般直接跑）
#   3. 运行：bash run.sh
#
# 前置：本机已安装 Node.js（>=18）、已安装系统 Chrome
# 注意：变量一律用 ${VAR} 花括号形式——macOS bash 3.2 下 $VAR 紧跟中文会被误解析。
set -euo pipefail
cd "$(dirname "$0")" || exit 1

ENV_FILE="geo-browser-env"
# 项目根目录 = deploy 的上一级
ROOT="$(cd .. && pwd)"

echo "== geo-browser 一键启动 =="

# 1) 部署包文件完整？
[ -f "${ENV_FILE}" ] || { echo "[错误] 缺少 ${ENV_FILE}，请把整个 deploy 文件夹完整传过来"; exit 1; }

# 2) 读取配置到环境变量
set -a
# shellcheck disable=SC1090
. "./${ENV_FILE}"
set +a

PORT="${PORT:-8787}"
GEO_STORAGE="${GEO_STORAGE:-file}"

# 3) 已在运行则退出（幂等，防止重复执行）
if curl -fsS "http://127.0.0.1:${PORT}/admin" >/dev/null 2>&1; then
  echo "[提示] 服务已在运行：http://127.0.0.1:${PORT}/admin（如需重启：先 bash stop.sh 再运行本脚本）"
  exit 0
fi

# 4) mysql 模式校验必填项（file 模式跳过）
if [ "${GEO_STORAGE}" = "mysql" ]; then
  db_host="$(grep -E '^DB_HOST=' "${ENV_FILE}" | head -1 | cut -d= -f2- | tr -d '\r')"
  db_user="$(grep -E '^DB_USER=' "${ENV_FILE}" | head -1 | cut -d= -f2- | tr -d '\r')"
  db_name="$(grep -E '^DB_NAME=' "${ENV_FILE}" | head -1 | cut -d= -f2- | tr -d '\r')"
  if [ -z "${db_host}" ] || [ -z "${db_user}" ] || [ -z "${db_name}" ]; then
    echo "[错误] GEO_STORAGE=mysql 但缺少数据库配置：请在 ${ENV_FILE} 里补齐 DB_HOST、DB_USER、DB_NAME"
    exit 1
  fi
fi

# 5) 依赖就绪（没有 node_modules 则安装）
cd "${ROOT}"
if [ ! -d node_modules ]; then
  echo "[deploy] 第一次运行，安装依赖 ..."
  npm install
fi

# 6) 数据根目录（env 里的相对路径按项目根解析；与项目平级），日志放 <数据根>/logs/geo-browser.log
DATA_ROOT="${GEO_DATA_ROOT:-../geo-browser-data}"
case "${DATA_ROOT}" in
  /*) ;;
  *) DATA_ROOT="${ROOT}/${DATA_ROOT}" ;;
esac
DATA_ROOT="$(cd "${DATA_ROOT}" && pwd)"
LOG_DIR="${DATA_ROOT}/logs"
LOG_FILE="${LOG_DIR}/geo-browser.log"

# 7) 启动（后台运行）
mkdir -p "${LOG_DIR}"
nohup npm run serve > "${LOG_FILE}" 2>&1 &

# 8) 等服务完全就绪（admin 可访问）再显示完成
ok=""
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PORT}/admin" >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
if [ -z "${ok}" ]; then
  echo "[错误] 服务在 120 秒内未就绪，请查看日志：${LOG_FILE}"
  exit 1
fi

echo
echo "== 完成 =="
echo "  本机访问：http://127.0.0.1:${PORT}/admin"
echo "  停止服务：bash stop.sh"
