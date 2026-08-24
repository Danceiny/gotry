#!/bin/sh
# scripts/publish-npm.sh: 一键发 gotry 到 npmjs(需要 founder 2FA bypass token)
# 用法:
#   1. founder 跑 `npm login` + 浏览器开 2FA
#   2. 在 https://www.npmjs.com/settings/tokens 创建 'Bypass 2FA' token
#   3. 把 token 写入环境变量: export NPM_TOKEN=npm_xxxxx
#   4. 跑本脚本: ./scripts/publish-npm.sh rc.5
# 
# 安全: token 永远走 env,不写 .npmrc 也不 commit
set -e
TAG="${1:-rc.5}"
VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*"version": "\(.*\)".*/\1/')
[ -z "$NPM_TOKEN" ] && { echo "ERROR: set NPM_TOKEN (Bypass-2FA token)" >&2; exit 1; }
[ -z "$VERSION" ] && { echo "ERROR: package.json missing version" >&2; exit 1; }
echo "Publishing gotry@${VERSION} with tag=${TAG}..."
# 1. dry-run
npm publish --access public --tag "${TAG}" --dry-run --registry=https://registry.npmjs.org/
echo
echo "OK above? Real publish in 5 sec (Ctrl-C to abort)..."
sleep 5
# 2. 真发(走 env token,不污染 ~/.npmrc)
npm config set //registry.npmjs.org/:_authToken "${NPM_TOKEN}" --registry=https://registry.npmjs.org/
npm publish --access public --tag "${TAG}" --registry=https://registry.npmjs.org/
# 3. 撤回 token(干净)
npm config delete //registry.npmjs.org/:_authToken --registry=https://registry.npmjs.org/
echo
echo "Done. Verify: npm view gotry@${VERSION} --registry=https://registry.npmjs.org/"
