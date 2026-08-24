# GoTry Token 手册(唯一 token 权威面)

> 定位:**所有外部凭证的精准获取步骤 + 统一存放位置**。founder 给过的 token 永远在这里查得到——不重问、不丢失。
> 纪律(2026-08-24 founder 锐评后确立):token 进 `.env`(gitignored),不进 `~/.npmrc` 全局、不进 git 跟踪文件、不进 docs 明文。

---

## 统一存放:仓库根 `.env`(gitignored)

```
LLM_API_KEY=...          # DeepSeek(已存,2026-08-22 给)
NPM_TOKEN=...            # npmjs(已存,2026-08-24 给,见下)
TWITTER_AUTH_TOKEN=      # agent-reach 渠道(未给,给即填)
TWITTER_CT0=
XHS_COOKIES=             # 小红书 Cookie-Editor JSON
```

**founder 给 token 的格式**:对话里直接贴(任何格式都行),我自动写 `.env` 并立刻用。

---

## npm(npmjs.org)— 当前唯一阻塞项

### 你已给过的 token
`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` → 已存 `.env` 的 `NPM_TOKEN`。
`npm whoami` 返 `danceiny` ✓ 鉴权通;**publish 撞 403**(原因见下)。

### 403 的精确原因(npm 2026-07-31 政策,已实测验证)

| 操作 | 这个 classic token | 原因 |
|---|---|---|
| `npm whoami` | ✅ 通 | 读操作不受限 |
| `npm profile get` | ❌ 403 | 2026-07-31 起 bypass-2FA token 禁做账户管理 |
| `npm publish` | ❌ 403 | classic token 无 2FA 能力;需 web 会话或 bypass token |

政策原文:<https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/>
direct publish 的 token 限制 target 2027-01;当前可行路径是**web 会话(推荐)**或 **Granular bypass token**。

### 路径 A:web 会话(最简,10 秒,无需生成任何 token)

我随时能生成一次性链接,你在浏览器点一次 Approve:

```sh
# 我跑这个,把输出的链接给你,你浏览器打开点确认
npm login --auth-type=web --registry=https://registry.npmjs.org/
# 链接形如 https://www.npmjs.com/login?next=/login/cli/<uuid>
# 你点完 → 我这边会话建立 → 立即 npm publish(会话自带 2FA 授权)
```

链接时效约 5 分钟;过期我重新生成就行,零成本。

### 路径 B:Granular Access Token(一劳永逸,约 60 秒)

1. 浏览器开 <https://www.npmjs.com/settings/danceiny/tokens>
2. **Generate New Token → Granular Access Token**
3. 表单关键三处:
   - Expiration: 选短期(7 天足够)
   - Packages and scopes: **Read and write**
   - **勾选 "Allow token to bypass two-factor authentication"**(页面下方,不勾等于白建)
4. 生成后复制 `npm_` 开头的串,贴给我 → 我写 `.env` → `./scripts/publish-npm.sh` 发

### 路径 C(长期):GitHub Actions OIDC trusted publishing

包首次发上去后,在 npmjs 包设置页关联 GitHub 仓库 + workflow,
之后 CI 自动发布,**永久无 token 无 2FA**。首次发布前用不了——先走 A 或 B。

### 发布脚本(已就位)

```sh
./scripts/publish-npm.sh          # 读 .env 的 NPM_TOKEN
NPM_TOKEN=npm_xxx ./scripts/publish-npm.sh   # 或临时注入
```

---

## LLM(DeepSeek)

已存 `.env` 的 `LLM_API_KEY`(2026-08-22 给,`sk-f2f5...83d8`)。
获取新 key:<https://platform.deepseek.com/api_keys> → Create new key → 直接贴给我。

---

## agent-reach 渠道(全部选配,给即接,不催)

| 渠道 | 需要什么 | 获取步骤 | 给我格式 |
|---|---|---|---|
| Twitter/X | 2 个 cookie 值 | 浏览器登录 x.com → F12 → Application → Cookies → 复制 `auth_token` 和 `ct0` | 对话里贴两行 |
| 小红书 | Cookie JSON | Chrome 装 Cookie-Editor 插件 → 登录小红书 → 插件 Export(JSON) | 贴 JSON |
| Reddit | rdt-cli cookie | OpenCLI 浏览器登录态(桌面版) | 我检测 OpenCLI 存在即用 |
| B站字幕 | (可选)OpenCLI | 桌面装 OpenCLI 登录 B站 | 自动检测 |
| 雪球/股票 | 登录 Cookie | `.venv/bin/agent-reach configure --from-browser chrome --platform xueqiu`(上游指引原样透传) | 配好即用,`gotry_agent_reach` 反射调 get_stock_quote |
| YouTube 字幕 | yt-dlp | `brew install yt-dlp` | 装完即用,无需给我任何东西 |
| GitHub 私有仓 | gh 登录 | `brew install gh && gh auth login` | 已装即用 |
| 全网语义搜索 | mcporter+exa | `npm i -g mcporter && mcporter config add exa https://mcp.exa.ai/mcp --scope home`(免费无 key) | 装完即用 |

**零配置已通的**(无需任何操作):web 读页(r.jina.ai)/ RSS / V2EX / B站搜索。

---

## 安全基线(不啰嗦,只列事实)

- `.env` 在 `.gitignore` ✓(git 跟踪文件无 token,已验证)
- `~/.npmrc` 全局**不放** npmjs token(上 tick 误写已清;公司 bnpm 的留着,那是内网必需)
- git 历史里有一份 npm token 明文(2026-08-22/24 写进 decisions-needed.md 后推送,私有仓)——按 founder 指示**不再展开此话题**;要换随时 npmjs 网页 revoke

---

## 修订史

| 日期 | 变更 |
|---|---|
| 2026-08-24 | 立 v1:npm 三路径(A web 会话/B granular bypass/C OIDC)+ agent-reach 8 渠道获取表 + 统一 .env 存放 |
| 2026-08-22 | 雪球行纠正:实测需 cookie(上游 check warn + configure 指引),非零门槛 |
