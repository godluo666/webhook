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
  up -d --build

printf 'Webhook Radar 已启动：http://127.0.0.1:3000\n'
