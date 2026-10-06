#!/bin/sh
# scripts/publish-npm.sh: 发 gotry 到 npmjs —— 与全局 ~/.npmrc 完全隔离
#
# 隔离方式(2026-08-22 founder 指示「单独弄个命令隔离开」):
#   NPM_CONFIG_USERCONFIG 指向仓内 .npmrc.publish(gitignored,每次由 .env 现生成)
#   —— 不读写 ~/.npmrc,不受 bnpm registry/prefix 行影响,也不污染日工作具配置。
#
# 用法:
#   TAG=latest ./scripts/publish-npm.sh   # dist-tag 必须显式传(issue #50①:曾默认 rc.5,
#                                          忘传会把新包发到陈旧 dist-tag,表面成功实则 latest 不可见)
#   ./scripts/publish-npm.sh login        # 只建 web 会话(浏览器点一次 Approve)即退出——
#                                          会话 token 只写 .npmrc.publish,后续发布/dist-tag
#                                          维护自动复用(发布时没有会话也会自动走一遍 login)
#   ./scripts/publish-npm.sh logout       # 撤销 web 会话并删 .npmrc.publish(发布成功后会自动做)
#   ./scripts/publish-npm.sh rmtag <t>…   # 删杂散 dist-tag(#50③ 维护面;每个 tag 一次浏览器批准)
#   --yes               确认人在浏览器前(非交互终端必带;交互终端省掉 Enter 提示)
#   --skip-preflight    跳过发布前预检(应急;预检拦的都是会让发布半途失败或发错的东西)
#   --no-verify         跳过回拉校验(应急;此后在跑过 verify-published.mjs 前不得说「已发布」)
#   --keep-session      发布成功后保留 web 会话(默认自动 npm logout 并删 .npmrc.publish)
#   --skip-changelog    跳过 changelog 闸(应急;publish-npm.sh 不应绕过)
#   --force-changelog   强制重建 CHANGELOG 段(默认顶部已含当前版本段就跳过)
#   环境变量 SKIP_CI_PROOF="<理由>" / ALLOW_DOWNGRADE=1 透传给预检(见 release-preflight.mjs)
#
# 流水线(完整操作手册见 docs/ops/npm-release-runbook.md):
#   预检 → changelog 闸 → 构建 dist → 记录预期构建 → 确认人在场 → (无会话则 web 登录)
#   → npm publish(点击)→ 回拉校验(verify-published.mjs)→ GitHub Release → 撤销会话
#   任一步失败即停;回拉未过绝不建 Release、绝不说「已发布」(AGENTS.md 发布闸,rc.16 教训)。
#
# 2026-08-30 changelog 闸(issue owner 拍板):发布前必跑
#   - scripts/build-changelog.ts → CHANGELOG.md(Keep a Changelog 1.1.0)
#   - 校验 CHANGELOG.md 顶部含 ## [<current-version>] 段
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
NPMRC="$ROOT/.npmrc.publish"
REGISTRY="https://registry.npmjs.org/"

SUBCOMMAND=""
case "${1:-}" in
  login|logout|rmtag) SUBCOMMAND="$1" ;;
  -*|"") ;;
  *)
    echo "!! 未知子命令 '$1'。发布用 TAG=latest ./scripts/publish-npm.sh;子命令只有 login / logout / rmtag(见脚本头部用法)" >&2
    exit 1
    ;;
esac

# 选项一次解析;拼错的选项直接拒绝(静默忽略 --keep-sesion 会在流程末尾撤销会话)
SKIP_CHANGELOG=0
FORCE_CHANGELOG=0
ASSUME_YES=0
SKIP_PREFLIGHT=0
SKIP_VERIFY=0
KEEP_SESSION=0
RMTAGS=""
for arg in "$@"; do
  case "$arg" in
    --skip-changelog) SKIP_CHANGELOG=1 ;;
    --force-changelog) FORCE_CHANGELOG=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --skip-preflight) SKIP_PREFLIGHT=1 ;;
    --no-verify) SKIP_VERIFY=1 ;;
    --keep-session) KEEP_SESSION=1 ;;
    -h|--help) sed -n '2,/^set -e$/p' "$0" | sed '$d'; exit 0 ;;
    login|logout|rmtag) ;;
    -*) echo "!! 未知选项 $arg(见脚本头部用法)" >&2; exit 1 ;;
    *) RMTAGS="$RMTAGS $arg" ;;
  esac
done

# dist-tag 必须显式传入,未传即拒发(issue #50① 脚枪根治:默认值 rc.5 曾把新包发到陈旧通道)。
# 豁免 login/logout/rmtag:纯认证/维护子命令不发布任何东西,不应被发布意图闸拦截
# (2026-09-08 实测:`publish-npm.sh login` 裸跑被此闸拒绝,web 会话流程走不通)。
if [ -z "$SUBCOMMAND" ] && [ -z "${TAG:-}" ]; then
  echo "!! TAG 未指定,拒绝发布。用法:TAG=latest ./scripts/publish-npm.sh(dist-tag 是显式意图,无默认值)" >&2
  exit 1
fi
if [ -z "$SUBCOMMAND" ] && [ -n "$RMTAGS" ]; then
  echo "!! 发布不接受位置参数:$RMTAGS(dist-tag 用 TAG=… 环境变量传入)" >&2
  exit 1
fi
NPM_CONFIG_USERCONFIG="$NPMRC"
export NPM_CONFIG_USERCONFIG

# 人在浏览器前才能往下走:批准链接约 7 分钟过期,没人点就白发一次(还会被 npm 误报成 E404)。
confirm_presence() {
  [ "$ASSUME_YES" = "1" ] && return 0
  if [ -t 0 ] && [ -t 1 ]; then
    printf '>> %s 批准链接约 7 分钟过期。人在浏览器前了吗?按 Enter 继续,Ctrl-C 取消: ' "$1"
    read -r _ || exit 1
    return 0
  fi
  echo "!! 非交互终端:$1 批准链接约 7 分钟过期,没人点就白发一次。确认人在浏览器前后加 --yes 重跑。" >&2
  exit 1
}

# 撤销本脚本的 web 会话并删 .npmrc.publish。.npmrc.publish 里的 token 若就是 .env 的 NPM_TOKEN
# (没有有效会话时由它生成),那是长期 token,绝不撤销——只删文件(下次会重新生成)。
end_session() {
  [ -f "$NPMRC" ] || return 0
  SESSION_TOKEN="$(grep '_authToken=' "$NPMRC" 2>/dev/null | head -1 | sed 's/^[^=]*=//')"
  ENV_TOKEN="$(grep '^NPM_TOKEN=' .env 2>/dev/null | head -1 | sed 's/^[^=]*=//')"
  if [ -n "$SESSION_TOKEN" ] && [ "$SESSION_TOKEN" != "$ENV_TOKEN" ]; then
    npm logout --registry="$REGISTRY" >/dev/null 2>&1 \
      || echo "  (npm logout 没成功:到 npmjs.com → Access Tokens 手动撤销本次会话)"
  fi
  rm -f "$NPMRC"
}

# 每次现生成:registry 固定 npmjs;token 优先级=上次 web 登录会话(仍有效则保留) > .env;
# 修复:此前无条件重写 .npmrc.publish,login 会话 token 每次都被 .env 里的死 token 覆盖(rc.13 发布曾 404)
# logout 不走这里:它只撤销现存会话,不该先把 .env 的 token 写进来再撤销它。
if [ "$SUBCOMMAND" != "logout" ]; then
  if grep -q _authToken "$NPMRC" 2>/dev/null && NPM_CONFIG_USERCONFIG="$NPMRC" npm whoami --registry="$REGISTRY" >/dev/null 2>&1; then
    echo ">> 保留 .npmrc.publish 中仍有效的登录会话 token"
  else
    {
      echo "registry=$REGISTRY"
      TOKEN="$(grep '^NPM_TOKEN=' .env 2>/dev/null | cut -d= -f2)"
      [ -n "$TOKEN" ] && echo "//registry.npmjs.org/:_authToken=$TOKEN"
    } > "$NPMRC"
  fi
fi

if [ "$SUBCOMMAND" = "login" ]; then
  echo ">> web 登录:会话 token 只写 $NPMRC(全局 ~/.npmrc 不动)。浏览器点 Approve 后本命令即完成(链接约 7 分钟过期)。"
  npm login --auth-type=web --registry="$REGISTRY"
  # login 是终态子命令:认证完成即退出,不顺势滑进发布流程(发布恒走 TAG=… 的显式形态)
  exit 0
fi

if [ "$SUBCOMMAND" = "logout" ]; then
  echo ">> 撤销 web 会话并删除 $NPMRC"
  end_session
  exit 0
fi

if [ "$SUBCOMMAND" = "rmtag" ]; then
  # dist-tag 维护面(#50③):automation token 对 dist-tag DELETE 是 403,删除需 web 会话。
  # 每个 tag 的删除是一次独立的浏览器批准。走本仓隔离 userconfig,不碰全局 ~/.npmrc。
  if [ -z "$RMTAGS" ]; then
    echo "!! rmtag 需要至少一个通道名。用法:./scripts/publish-npm.sh rmtag rc.5 rc.11 …" >&2
    exit 1
  fi
  for t in $RMTAGS; do
    if [ "$t" = "latest" ]; then
      echo "!! 拒绝删除 latest:npx @danceiny/gotry 不带版本时就靠它(要移动它,发新版本时 TAG=latest)" >&2
      exit 1
    fi
  done
  NTAGS=$(echo $RMTAGS | wc -w | tr -d ' ')
  confirm_presence "要删 ${NTAGS} 个 dist-tag,每个一次浏览器批准。"
  if ! NPM_CONFIG_USERCONFIG="$NPMRC" npm whoami --registry="$REGISTRY" >/dev/null 2>&1; then
    echo ">> 无有效会话:web 登录(链接约 7 分钟过期)"
    npm login --auth-type=web --registry="$REGISTRY"
  fi
  for t in $RMTAGS; do
    echo ">> dist-tag rm @danceiny/gotry $t(浏览器批准)"
    NPM_CONFIG_USERCONFIG="$NPMRC" npm dist-tag rm "@danceiny/gotry" "$t" --registry="$REGISTRY"
  done
  exit 0
fi

PKG_NAME="$(node -e "console.log(require('./package.json').name)")"
CURRENT_VERSION="$(node -e "console.log(require('./package.json').version)")"

# ---- 发布前预检:tag/CI 证明/版本一致/dist-tag 方向——人点浏览器之前就该知道的都在这里一次报完 ----
run_preflight() {
  set -- --tag "$TAG"
  if [ -n "${SKIP_CI_PROOF:-}" ]; then set -- "$@" --skip-ci-proof "$SKIP_CI_PROOF"; fi
  if [ "${ALLOW_DOWNGRADE:-0}" = "1" ]; then set -- "$@" --allow-downgrade; fi
  node scripts/release-preflight.mjs "$@"
}
if [ "$SKIP_PREFLIGHT" = "1" ]; then
  echo "!! --skip-preflight:发布前预检被跳过(tag/CI 证明/版本一致都没人替你看了)"
else
  echo ">> 发布前预检(scripts/release-preflight.mjs)"
  run_preflight || {
    echo "!! 预检未过(上面逐项列出)。修好再跑;应急才用 --skip-preflight" >&2
    exit 1
  }
fi

# ---- changelog 闸:发布前必跑 build-changelog + 校验顶部段 ----
if [ "$SKIP_CHANGELOG" = "0" ]; then
  echo ">> changelog 闸:重新生成 CHANGELOG.md(从上一 tag 到 HEAD)"
  # 幂等保护:顶部已含当前版本段时跳过再生成——build-changelog 是前置插入,重跑必双写
  # (rc.19×3 段/rc.16×5 段即发布脚本「首跑因 auth 失败停在半途、重跑无条件重建」累积;
  #  强制重建用 --force-changelog)
  if [ "$FORCE_CHANGELOG" = "0" ] && head -30 CHANGELOG.md | grep -q "^## \[${CURRENT_VERSION}\]"; then
    echo ">> 顶部已含 ## [${CURRENT_VERSION}] 段,跳过再生成(幂等;--force-changelog 强制)"
  else
    # 自动取上一 tag(同 build-changelog.ts 的逻辑)
    PREV_TAG="$(git tag -l 'v*' --sort=-v:refname | grep -v "^v${CURRENT_VERSION}\$" | head -1)"
    [ -z "$PREV_TAG" ] && PREV_TAG="$(git tag -l 'v*' --sort=-v:refname | tail -1)"
    DATE="$(date +%Y-%m-%d)"
    # 写入 CHANGELOG 前先 commit(否则 build-changelog 写盘后 git dirty 触发闸自检)
    (cd ts && npx tsx scripts/build-changelog.ts --version "$CURRENT_VERSION" --date "$DATE" --since "$PREV_TAG" --write) || {
      echo "!! build-changelog 失败;用 --skip-changelog 跳过(不推荐)"
      exit 1
    }
  fi
  # 校验顶部含当前版本段
  if ! head -30 CHANGELOG.md | grep -q "^## \[${CURRENT_VERSION}\]"; then
    echo "!! CHANGELOG.md 顶部缺 ## [${CURRENT_VERSION}] 段;请重跑 build-changelog 或 --skip-changelog 绕过"
    exit 1
  fi
  # 校验除 CHANGELOG.md(本脚本自动改)外无其他未提交修改(防 tarball 漏开发者改动)
  # --untracked-files=no 排除 worktree 的 dev-only symlink(ts/node_modules)等
  OTHER_DIRTY="$(git status --porcelain --untracked-files=no ':!CHANGELOG.md')"
  if [ -n "$OTHER_DIRTY" ]; then
    echo "!! 工作区有未提交改动(非 CHANGELOG.md),请先 git commit/stash 再 publish"
    echo "$OTHER_DIRTY"
    exit 1
  fi
  # CHANGELOG.md 由 build-changelog 自动写盘,publish 前自动 commit,确保 tarball 含新版本段
  if [ -n "$(git status --porcelain CHANGELOG.md)" ]; then
    echo ">> 自动 commit CHANGELOG.md(本脚本自动生成)"
    git add CHANGELOG.md
    git commit -m "docs(changelog): 自动生成 v${CURRENT_VERSION} 段" || true
  fi
  echo ">> changelog 闸通过(顶部 ## [${CURRENT_VERSION}] 段已就位 + git committed)"
fi

echo ">> 预编译 dist(Node 拒 strip node_modules 下的 .ts)"
node scripts/build-dist.mjs

# 记录「这棵树打出来的包」的 shasum/文件数:回拉校验用它证明 registry 上就是这个包(npm pack 是确定性的)
node scripts/release-preflight.mjs --write-expected --tag "$TAG" || {
  echo "!! 记录预期构建失败(npm pack 不出包?),不往下发" >&2
  exit 1
}

echo ">> 隔离配置生效:registry=$(npm config get registry)"

# 从这里起每一步都可能要人点浏览器:先确认人在。预检/构建已经过了,没人在场就不白发。
confirm_presence "接下来要登录(若无会话)并发布,共 1~2 次浏览器批准。"

if ! npm whoami --registry="$REGISTRY" >/dev/null 2>&1; then
  echo ">> 无有效会话:web 登录(点击 1)"
  npm login --auth-type=web --registry="$REGISTRY"
fi

echo ">> publish ${PKG_NAME}@${CURRENT_VERSION} --tag $TAG(点击:发布批准)"
# 日志写到专用目录而不是管道 tee:npm 的批准链接要原样打到终端,管道会改 isatty 行为。
PUBLISH_LOGS="$(mktemp -d "${TMPDIR:-/tmp}/gotry-publish-logs.XXXXXX")"
if npm publish --access public --tag "$TAG" --registry="$REGISTRY" --logs-dir "$PUBLISH_LOGS"; then
  rm -rf "$PUBLISH_LOGS"
else
  PUBLISH_STATUS=$?
  # 批准链接没人点/已过期时 npm 报的是 E404(GET /-/v1/done?authId=…)——看着像包或 registry 的问题,其实不是。
  if cat "$PUBLISH_LOGS"/*.log 2>/dev/null | grep -q -- '-/v1/done'; then
    echo "!! npm 在等浏览器批准时拿到 404(/-/v1/done?authId=…):批准链接过期(约 7 分钟)或没人点。这是 npm 的误导性报错,与包/版本无关;什么都没发布,确认人在浏览器前后重跑即可。" >&2
  elif cat "$PUBLISH_LOGS"/*.log 2>/dev/null | grep -qi 'cannot publish over the previously published'; then
    echo "!! 该版本已发布过(registry 不允许覆盖)。若是上次发布成功而本脚本中途停了:直接跑 node scripts/verify-published.mjs --tag $TAG 回拉校验,不要重发。" >&2
  else
    echo "!! npm publish 失败(退出码 $PUBLISH_STATUS),npm 日志在 $PUBLISH_LOGS" >&2
  fi
  exit "$PUBLISH_STATUS"
fi

echo ">> Done → npm view ${PKG_NAME} --registry=$REGISTRY"

# ---- 回拉校验:AGENTS.md 发布闸——没有回拉,任何权威文档都不得说「已发布」 ----
if [ "$SKIP_VERIFY" = "1" ]; then
  echo "!! --no-verify:未回拉校验,因此不建 GitHub Release、不撤销会话。在跑过 node scripts/verify-published.mjs --tag $TAG 之前不得说「已发布」。" >&2
  exit 0
fi
echo ">> 回拉校验(registry 可见性 + tarball 字节 + 干净机器 npx 实跑;registry 传播可能要几分钟)"
node scripts/verify-published.mjs --tag "$TAG" || {
  echo "!! 回拉校验未过——不建 GitHub Release,不得说「已发布」。会话保留着,排查后可重跑 node scripts/verify-published.mjs --tag $TAG。" >&2
  exit 1
}

# ---- 回拉过了才建 GitHub Release(notes = docs/release-notes.md 同版本块 + CHANGELOG 段,同一份脚本组装) ----
if [ "$SKIP_CHANGELOG" = "0" ] && command -v gh >/dev/null 2>&1; then
  echo ">> 创建 GitHub Release v${CURRENT_VERSION}"
  NOTES_FILE="$(mktemp "${TMPDIR:-/tmp}/gotry-release-notes.XXXXXX")"
  if node scripts/release-notes.mjs --version "$CURRENT_VERSION" --out "$NOTES_FILE"; then
    # --verify-tag(不是 --target):发布闸要求 tag 已推远端;`--target` 只接受分支名或完整 commit SHA,
    # 传 tag 名会被 GitHub 以 HTTP 422 `target_commitish is invalid` 拒收(rc.27 发布实测,npm 已发而 Release 没建出来),
    # 且 tag 不存在时它会静默在 main 上新建 tag。--verify-tag 则在 tag 缺失时直接中止。
    gh release create "v${CURRENT_VERSION}" \
      --title "v${CURRENT_VERSION}" \
      --notes-file "$NOTES_FILE" \
      --verify-tag \
      || echo "  (gh release create 失败;手动补:node scripts/release-notes.mjs --out /tmp/notes.md && gh release create v${CURRENT_VERSION} --title v${CURRENT_VERSION} --notes-file /tmp/notes.md --verify-tag)"
  else
    echo "  (CHANGELOG.md 中找不到 ## [${CURRENT_VERSION}] 段,跳过 gh release create)"
  fi
  rm -f "$NOTES_FILE"
fi

# ---- 全部做完才撤销会话:点击都已发生,不会在批准中途掐掉 ----
if [ "$KEEP_SESSION" = "1" ]; then
  echo ">> --keep-session:会话保留在 $NPMRC;用完请 ./scripts/publish-npm.sh logout"
else
  end_session
  echo ">> 已撤销 web 会话并删除 .npmrc.publish"
fi

echo ""
echo ">> 已发布并通过回拉校验:${PKG_NAME}@${CURRENT_VERSION}(dist-tag $TAG),回执 $ROOT/.release-verified.json"
echo ">> 收尾——文档只能在这之后写「已发布」。在 main 的干净工作树里:"
echo "     node scripts/post-release-docs.mjs --receipt $ROOT/.release-verified.json"
echo "   然后过 check-docs-i18n / check-doc-readability,开一个 docs PR。"
