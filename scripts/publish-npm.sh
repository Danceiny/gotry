#!/bin/sh
# scripts/publish-npm.sh: 发 gotry 到 npmjs —— 与全局 ~/.npmrc 完全隔离
#
# 隔离方式(2026-08-22 founder 指示「单独弄个命令隔离开」):
#   NPM_CONFIG_USERCONFIG 指向仓内 .npmrc.publish(gitignored,每次由 .env 现生成)
#   —— 不读写 ~/.npmrc,不受 bnpm registry/prefix 行影响,也不污染日工作具配置。
#
# 用法:
#   ./scripts/publish-npm.sh              # 用 .env 的 NPM_TOKEN 直发
#   ./scripts/publish-npm.sh login        # 走 web 会话(浏览器点一次 Approve),
#                                          会话 token 也只写 .npmrc.publish
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
NPMRC="$ROOT/.npmrc.publish"
TAG="${TAG:-rc.5}"
NPM_CONFIG_USERCONFIG="$NPMRC"
export NPM_CONFIG_USERCONFIG

# 每次现生成:registry 固定 npmjs;token 优先级=上次 web 登录会话(仍有效则保留) > .env;
# 修复:此前无条件重写 .npmrc.publish,login 会话 token 每次都被 .env 里的死 token 覆盖(rc.13 发布曾 404)
if grep -q _authToken "$NPMRC" 2>/dev/null && NPM_CONFIG_USERCONFIG="$NPMRC" npm whoami --registry=https://registry.npmjs.org/ >/dev/null 2>&1; then
  echo ">> 保留 .npmrc.publish 中仍有效的登录会话 token"
else
  {
    echo 'registry=https://registry.npmjs.org/'
    TOKEN="$(grep '^NPM_TOKEN=' .env 2>/dev/null | cut -d= -f2)"
    [ -n "$TOKEN" ] && echo "//registry.npmjs.org/:_authToken=$TOKEN"
  } > "$NPMRC"
fi

if [ "${1:-}" = "login" ]; then
  echo ">> web 登录:会话 token 只写 $NPMRC(全局 ~/.npmrc 不动)。浏览器点 Approve 后即可发布。"
  npm login --auth-type=web --registry=https://registry.npmjs.org/
fi

echo ">> 预编译 dist(Node 拒 strip node_modules 下的 .ts)"
node scripts/build-dist.mjs

echo ">> 隔离配置生效:registry=$(npm config get registry)"
npm whoami --registry=https://registry.npmjs.org/ || echo "  (未登录/无 token 权限,继续尝试 publish)"

echo ">> publish $(grep -o '"name": "[^"]*"' package.json | head -1)"
npm publish --access public --tag "$TAG" --registry=https://registry.npmjs.org/
echo "Done → npm view gotry --registry=https://registry.npmjs.org/"
