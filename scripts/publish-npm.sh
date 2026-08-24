#!/bin/sh
# scripts/publish-npm.sh: 发 gotry 到 npmjs(npm 2026-07 政策:必须 OTP)
# 用法(二选一):
#   ./scripts/publish-npm.sh <OTP六位码>          # 你手机 authenticator 当前显示的 6 位
#   NPM_TOKEN=npm_xxx ./scripts/publish-npm.sh <OTP>
# OTP 30 秒时效 — 拿到码立刻跑。
set -e
OTP="${1:?用法: ./scripts/publish-npm.sh <OTP六位码>}"
TAG="${2:-rc.5}"
TOKEN="${NPM_TOKEN:-$(grep '^NPM_TOKEN=' .env 2>/dev/null | cut -d= -f2)}"
[ -z "$TOKEN" ] && { echo "ERROR: .env 缺 NPM_TOKEN" >&2; exit 1; }
npm config set //registry.npmjs.org/:_authToken "$TOKEN" --registry=https://registry.npmjs.org/
npm publish --access public --tag "${TAG}" --otp="${OTP}" --registry=https://registry.npmjs.org/
npm config delete //registry.npmjs.org/:_authToken --registry=https://registry.npmjs.org/ 2>/dev/null || true
echo "Done → npm view gotry@$(grep '\"version\"' package.json | head -1 | sed 's/.*: \"\(.*\)\".*/\1/') --registry=https://registry.npmjs.org/"
