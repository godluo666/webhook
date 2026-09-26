#!/usr/bin/env bash
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  printf 'Docker 未安装。请先安装 Docker，再重新运行此命令。\n' >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  printf 'Docker Compose 不可用。请安装 Docker Compose 插件。\n' >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  printf '无法连接 Docker。请启动 Docker，并确认当前用户有运行权限。\n' >&2
  exit 1
fi

docker compose -p webhook-radar \
  -f 'https://github.com/godluo666/webhook.git#main:compose.build.yaml' \
  up -d --build --wait --wait-timeout 90

if [[ "${RADAR_BIND:-127.0.0.1}" == '127.0.0.1' ]]; then
  printf 'Webhook Radar 已启动。本机访问：http://127.0.0.1:%s\n' "${RADAR_PORT:-3000}"
  printf '其他设备需要使用 RADAR_BIND=0.0.0.0 显式开放端口。\n'
else
  printf 'Webhook Radar 已启动。请访问 http://服务器IP:%s\n' "${RADAR_PORT:-3000}"
  printf '如果仍无法访问，请检查服务器或云平台是否放行该 TCP 端口。\n'
fi
