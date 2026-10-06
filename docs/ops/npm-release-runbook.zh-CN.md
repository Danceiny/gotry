[English](npm-release-runbook.md) | [简体中文](npm-release-runbook.zh-CN.md)

# npm 发布操作手册

> 定位：`@danceiny/gotry` 发布到 npm 的端到端流程——谁点什么、执行 agent 跑什么、什么才能证明一次发布是真的。
> 状态：living
> 上游：[AGENTS.md](../../AGENTS.zh-CN.md) 发布纪律（founder 确认、发布闸、回拉规则），[tokens.md](../tokens.zh-CN.md)（凭据路径与 npm 2FA 事实）
> 下游：`scripts/publish-npm.sh`、`scripts/release-preflight.mjs`、`scripts/verify-published.mjs`、`scripts/post-release-docs.mjs`、`scripts/release-notes.mjs`
> 最近更新：2026-10-06
> 边界：本文承载流程；凭据获取与 npm 策略事实留在 tokens.md，发布闸的判据留在 AGENTS.md。§4 的回拉回执出现之前，任何文档都不得写「已发布」。

## 速览

- 一次发布就是在发布 tag 的干净检出里跑一条命令：`TAG=latest ./scripts/publish-npm.sh`。
- 第一次点击之前能知道的一切都先查，一次过，所有问题一并列出。
- founder 只负责浏览器批准：web 登录一次、发布一次、每次 dist-tag 写操作再一次。
- 每个批准链接约 7 分钟过期，所以命令启动前 founder 必须已在浏览器前。
- `scripts/verify-published.mjs` 通过之前不叫「已发布」：registry 提供的正是本地构建的那份字节，并且干净环境安装能跑通。
- GitHub Release 只在回拉通过之后创建，web 会话在最后撤销。
- 中途停下不丢东西：重跑是安全的，因为 changelog 闸幂等、已发布的版本会被识别、回拉也可以单独跑。

## 1. 第一条命令之前

1. founder 已确认发不发、发哪个版本（AGENTS.md）。
2. 版本号 bump PR 已合并，其中带有包版本、lockfile、扩展 manifest、两份 release-notes 与生成的 `CHANGELOG.md` 段。
3. 合并后的提交已打 tag 并推送：`git tag v<version> <commit> && git push origin v<version>`。
4. 备好发布树：在该 tag 上建 detached worktree，并带自己物理存在的根 `node_modules`。

```sh
git worktree add --detach /tmp/gotry-release v<version>
cd /tmp/gotry-release
npm ci --no-audit --no-fund --strict-peer-deps
# 或克隆一份现成的安装（APFS；Linux 用 cp -a --reflink=auto）：
cp -cR <other-tree>/node_modules ./node_modules
```

构建会有意拒绝符号链接或被提升（hoist）的 `node_modules`，因为 dist 字节必须来自本树自己的 TypeScript。只需要根目录的安装；`ts/node_modules` 服务于回归套件，不服务于发布。

## 2. 执行

```sh
TAG=latest ./scripts/publish-npm.sh
```

dist-tag 永远显式传入（#50①）。各阶段按下表顺序执行，第一个失败即停：

| 阶段 | 做什么 | 何时停 |
|---|---|---|
| 预检 | `release-preflight.mjs` 检查版本、tag、干净树、文档、CI 证明与 registry | tag 不在远端的 HEAD 上或不在 `main` 上；有已跟踪文件被改；某份发布文档缺该版本；tag 提交没有绿色 CI；该版本已发布；dist-tag 会倒退 |
| changelog 闸 | `CHANGELOG.md` 顶部段含该版本；没有其他未提交改动 | 缺该段或树不干净 |
| 构建 | `build-dist.mjs`，随后把 `npm pack` 预测的 shasum 与文件数记入 `.release-expected.json` | 编译器守卫拒绝（§5） |
| 在场确认 | 询问 founder 是否在浏览器前；`--yes` 即代为回答 | 非交互终端且未带 `--yes` |
| 登录 | 没有有效会话时做 web 登录——点击 1 | 链接过期 |
| 发布 | `npm publish --tag $TAG`——点击 2 | 链接过期（§5） |
| 回拉 | `verify-published.mjs`：registry 可见性、tarball 字节对照预测，然后在干净环境跑 `doctor`、插件加载、`web` 启动与一次性运行 | 任何一项不一致；不创建 Release |
| GitHub Release | 用 `release-notes.mjs` 的输出执行 `gh release create` | 从不致命；脚本会打印手动命令 |
| 会话 | web 会话先 `npm logout`，再删除 `.npmrc.publish` | 从不致命 |

CI 证明指 tag 提交自己的检查运行；push CI 被并发取消时，则取树完全相同的已合并 PR 头。发布点击之后，registry 通常还要约 4 分钟回拉才看得到该版本（rc.28），回拉最多轮询 10 分钟。

## 3. 从 agent 会话中驱动

- 在 Terminal 面板里跑命令，那是真 PTY。没有 TTY 时，`npm login --auth-type=web` 会掉进 `Username:` 提示。
- 启动之前先在聊天里问 founder 此刻能不能点。没人点的链接是最常见的失败原因：rc.27 因此丢了两次，rc.28 丢了一次。
- founder 说可以之后再带 `--yes` 启动命令，因为在场确认提示无法从 agent 一侧作答。
- 读面板，并在批准链接出现的当下把它贴进聊天。先出现的是登录链接；founder 第一次点击之后才出现发布链接。
- founder 自己在终端里跑时无需额外操作：在提示处按 Enter，然后点两次。

## 4. 通过之后

脚本最后会点明回执 `.release-verified.json`。在主检出里，树干净、新开分支：

```sh
node scripts/post-release-docs.mjs --receipt <publish-tree>/.release-verified.json
node scripts/check-docs-i18n.mjs && node scripts/check-doc-readability.mjs
```

脚本会给两份 release-notes 加上「已发布」段；若是发布到 `latest`，还会改写 README、user-guide 与 roadmap 里的版本基线。每一对文档要么一起改、要么都不改，再跑一次不会有变化，`--check` 只报告待办而不写入。提交改动的文件（发布到 `latest` 时是八个），开 docs PR，然后用 `git worktree remove --force <publish-tree>` 删掉发布树。

## 5. 中途停下时

| 现象 | 含义 | 处理 |
|---|---|---|
| 以 `!! 预检未过` 结尾的预检清单 | 预检发现了问题并全部列出 | 逐项修好；不要跳过 |
| npm 在 `/-/v1/done?authId=…` 上报 `E404` | 批准链接已过期或从未被点击；什么都没发布 | 确认 founder 在浏览器前后重跑；登录会话仍有效时，只需重点发布那一次 |
| `cannot publish over the previously published versions` | 该版本已在 registry 上，说明上一次运行在发布之后才中断 | 跑 `node scripts/verify-published.mjs --tag <tag>`；绝不重发 |
| `TypeScript must resolve within root node_modules` | `node_modules` 是符号链接或被提升 | `npm ci`，或克隆一份安装（§1） |
| 回拉提示该版本尚不可见 | registry 传播比 10 分钟轮询更慢 | 重跑 `verify-published.mjs --tag <tag> --wait 900` |
| 回拉报告 shasum 不一致 | registry 的字节与本树构建不同 | 停；查明原因之前不创建 Release、不写「已发布」 |
| tag 提交没有绿色 CI 证明 | push CI 被取消，且没有树相同的已合并 PR 头 | 若该 tag 带有 `workflow_dispatch` 触发器，跑 `gh workflow run CI --ref <tag>`；否则把 PR 头证据写成 `SKIP_CI_PROOF="<reason>"` 传入 |
| dist-tag 会倒退 | 正在把较旧的版本发到更靠前的 tag | 确认意图后设置 `ALLOW_DOWNGRADE=1` |
| `gh release create` 失败 | 包已经验证过；只是缺 Release | 执行脚本打印的手动命令 |

存在三个应急开关，每个都会让它对应的结论保持未证明：`--skip-preflight`、`--skip-changelog` 与 `--no-verify`。`--no-verify` 之后脚本不创建 Release、保留会话，在 `verify-published.mjs` 通过之前不得有任何文档说「已发布」。

## 6. dist-tag 与会话

- 重指向 dist-tag 用 `.env` 里的 granular token 即可；删除则需要 web 会话：`./scripts/publish-npm.sh rmtag <tag>…`，每个 tag 一次批准，`latest` 会被拒绝。事实与来龙去脉见 [tokens.md](../tokens.zh-CN.md)。
- 发布成功后会话会被撤销。`--keep-session` 为一批维护操作保留会话，`./scripts/publish-npm.sh logout` 结束会话。
- 与 `.env` 里 `NPM_TOKEN` 相同的 `.npmrc.publish` token 永不撤销，因为那是长期 token；只删除该文件。
- 用 GitHub Actions 的 Trusted Publishing 替代点击是已规划的方向（tokens.md 路径 C）。在它建立并验证之前，本文就是路径。
