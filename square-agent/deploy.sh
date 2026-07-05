#!/bin/bash
# square-agent 一键部署到东京 VPS
# 用法: ./deploy.sh [--pull-only]

set -e

REMOTE="deploy"
VPS_USER="linuxuser"
VPS_IP="198.13.49.113"
VPS_PATH="~/projects/square-agent"

cd "$(dirname "$0")"

echo "📦 推送代码到 VPS..."
git push deploy main

echo "🔄 VPS 拉取最新代码..."
ssh "$VPS_USER@$VPS_IP" "cd $VPS_PATH && git pull"

echo "✅ 部署完成"
