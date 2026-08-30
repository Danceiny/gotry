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
#   ./scripts/publish-npm.sh --skip-changelog   # 跳过 changelog 闸(应急;publish-npm.sh 不应绕过)
#
# 2026-08-30 changelog 闸(issue owner 拍板):发布前必跑
#   - scripts/build-changelog.ts → CHANGELOG.md(Keep a Changelog 1.1.0)
#   - 校验 CHANGELOG.md 顶部含 ## [<current-version>] 段
#   - publish 成功后 gh release create 自动建 GitHub Release
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
NPMRC="$ROOT/.npmrc.publish"
TAG="${TAG:-rc.5}"
NPM_CONFIG_USERCONFIG="$NPMRC"
export NPM_CONFIG_USERCONFIG

# changelog 闸开关:默认开;--skip-changelog 应急(已发包后无法重生成时)
SKIP_CHANGELOG=0
for arg in "$@"; do
  case "$arg" in
    --skip-changelog) SKIP_CHANGELOG=1 ;;
    login) ;; # 透传给 npm login
  esac
done

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

# ---- changelog 闸:发布前必跑 build-changelog + 校验顶部段 ----
if [ "$SKIP_CHANGELOG" = "0" ]; then
  echo ">> changelog 闸:重新生成 CHANGELOG.md(从上一 tag 到 HEAD)"
  CURRENT_VERSION="$(node -e "console.log(require('./package.json').version)")"
  # 自动取上一 tag(同 build-changelog.ts 的逻辑)
  PREV_TAG="$(git tag -l 'v*' --sort=-v:refname | grep -v "^v${CURRENT_VERSION}\$" | head -1)"
  [ -z "$PREV_TAG" ] && PREV_TAG="$(git tag -l 'v*' --sort=-v:refname | tail -1)"
  DATE="$(date +%Y-%m-%d)"
  (cd ts && npx tsx scripts/build-changelog.ts --version "$CURRENT_VERSION" --date "$DATE" --since "$PREV_TAG" --write) || {
    echo "!! build-changelog 失败;用 --skip-changelog 跳过(不推荐)"
    exit 1
  }
  # 校验顶部含当前版本段
  if ! head -30 CHANGELOG.md | grep -q "^## \[${CURRENT_VERSION}\]"; then
    echo "!! CHANGELOG.md 顶部缺 ## [${CURRENT_VERSION}] 段;请重跑 build-changelog 或 --skip-changelog 绕过"
    exit 1
  fi
  # 校验发布后 git 已 commit CHANGELOG.md(避免未追踪的 changelog 被 tarball 漏)
  if [ -n "$(git status --porcelain CHANGELOG.md)" ]; then
    echo "!! CHANGELOG.md 有未提交修改;请先 git commit 再 publish(防 tarball 漏最新 changelog)"
    exit 1
  fi
  echo ">> changelog 闸通过(顶部 ## [${CURRENT_VERSION}] 段已就位)"
fi

echo ">> 预编译 dist(Node 拒 strip node_modules 下的 .ts)"
node scripts/build-dist.mjs

echo ">> 隔离配置生效:registry=$(npm config get registry)"
npm whoami --registry=https://registry.npmjs.org/ || echo "  (未登录/无 token 权限,继续尝试 publish)"

echo ">> publish $(grep -o '"name": "[^"]*"' package.json | head -1)"
npm publish --access public --tag "$TAG" --registry=https://registry.npmjs.org/

echo ">> Done → npm view $(grep -o '"name": "[^"]*"' package.json | head -1) --registry=https://registry.npmjs.org/"

# ---- 发布成功后自动建 GitHub Release(从 CHANGELOG.md 抓新版本段)----
if [ "$SKIP_CHANGELOG" = "0" ] && command -v gh >/dev/null 2>&1; then
  CURRENT_VERSION="$(node -e "console.log(require('./package.json').version)")"
  echo ">> 创建 GitHub Release v${CURRENT_VERSION}"
  # 抓 CHANGELOG.md 中 ## [<ver>] 段的整段(到下一个 ## [ 或 EOF)
  RELEASE_NOTES="$(awk "/^## \\[${CURRENT_VERSION//./\\.}\\]/{flag=1;next}/^## \\[/&&flag{flag=0;exit}flag" CHANGELOG.md)"
  if [ -n "$RELEASE_NOTES" ]; then
    # 同步 release-notes.md 的同版本段(founder 手写段落作为 GitHub Release notes 主体)
    if [ -f docs/release-notes.md ]; then
      RN_SECTION="$(awk "/^## v${CURRENT_VERSION//./\\.}/{flag=1;next}/^## /&&flag{flag=0;exit}flag" docs/release-notes.md)"
      [ -n "$RN_SECTION" ] && RELEASE_NOTES="$RN_SECTION"$'\n\n---\n\n'"$RELEASE_NOTES"
    fi
    # 写临时 notes 文件
    NOTES_FILE="$(mktemp -t gotry-release-notes-XXXXXX)"
    printf '%s\n' "$RELEASE_NOTES" > "$NOTES_FILE"
    gh release create "v${CURRENT_VERSION}" \
      --title "v${CURRENT_VERSION}" \
      --notes-file "$NOTES_FILE" \
      --target "$(git rev-parse HEAD)" \
      || echo "  (gh release create 失败;手动补:gh release create v${CURRENT_VERSION} --notes-file <>)"
    rm -f "$NOTES_FILE"
  else
    echo "  (CHANGELOG.md 中找不到 ## [${CURRENT_VERSION}] 段,跳过 gh release create)"
  fi
fi
