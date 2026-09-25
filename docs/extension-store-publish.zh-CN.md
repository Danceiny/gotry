# Chrome Web Store 上架配置

一次性配置，让 `.github/workflows/extension-publish.yml` 能把 GoTry Session Bridge
扩展发布到 Chrome Web Store（分发通道 B，ADR-21；hotel-fe#3802 事故的后续——商店卡在
0.1.0 的根源正是发布全靠手工）。

## 1. 背景

流水线用 `scripts/package-extension.mjs` 打包 `extension/`，且**只有手动 dispatch 且
`dry_run=false`** 时才经 Chrome Web Store API 上传 store zip。发布需要四个 repo
secret，其余配置都已在 workflow 里。CWS 要求版本严格递增——商店现存 0.1.0，manifest
的 `version` 必须始终高于它。

发布路径全程可验证（2026-09-25，#346/#537）：publish job 先把 pack artifact 显式下载到
`dist-extension/`，并在任何 OAuth/网络调用之前对账三件套、版本与 SHA256
（`scripts/cws-publish-validate.mjs artifact`）；随后每一步 API 响应都按 v1.1 文档化语义
分类——HTTP 2xx 从不单独当作成功。上传、提审、商店在架是三个不同状态，提审受理不等于
商店发布（§5）。

## 2. 一次性 OAuth 配置

由 founder 用持有 CWS item 的 Google 账号（`danceiny@gmail.com`）做一次。Chrome Web
Store API 走 Google Cloud OAuth2 client credentials，不是 service account。

### 2a. GCP 项目与 API

在 https://console.cloud.google.com/ 用同一 Google 账号建（或复用）项目，然后在
APIs & Services → Library 里启用 Chrome Web Store API。

### 2b. OAuth client

在 APIs & Services → Credentials → Create credentials → OAuth client ID，应用类型选
**Desktop app**。记下 client ID 与 client secret。

### 2c. Refresh token

以 `access_type=offline&prompt=consent` 授权 scope
`https://www.googleapis.com/auth/chromewebstore`，并用 code 换 refresh token。Google
已废弃 `urn:ietf:wg:oauth:2.0:oob` redirect——改用 loopback redirect
（`http://localhost:PORT`）或 https://developers.google.com/oauthplayground
（Appendix → 勾选使用自己的凭据）。refresh token 按密码对待保存。

## 3. Repo secrets

在仓库 Settings → Secrets and variables → Actions 下加四个 secret（直连 REST API 不需要
publisher ID；早先的五 secret 表属于已退役的第三方 action 时代，作废）：

| Secret | 值 |
| --- | --- |
| `CHROME_EXTENSION_ID` | `oeajpiccmonococjcegddlooeeohlbgd` |
| `CHROME_CLIENT_ID` | 2b 的 OAuth client ID |
| `CHROME_CLIENT_SECRET` | 2b 的 OAuth client secret |
| `CHROME_REFRESH_TOKEN` | 2c 的 refresh token |

## 4. 首次发布

先以 `dry_run=true` dispatch 一次（只打包，验证版本守卫与产物），founder 确认后再以
`dry_run=false` dispatch。publish job 按序执行：artifact 预检 → token → upload →
publish，每步按 §5 fail-closed。CWS 审核需数小时到数天；商店回拉验证（商店页确实显示
新版本）完成前，任何权威文档都不得宣称已发布。

## 5. 发布响应语义（v1.1）

`scripts/cws-publish-validate.mjs` 对每个响应做分类；分类 fail-closed，失败输出只含固定
原因、HTTP 码与派生布尔/计数——绝不携带响应体、error_description 或 token（API 供应文本
一律不进 workflow 日志；access token 的唯一出口是被 `::add-mask::` 的
`--field access_token` 提取）。

| 步骤 | 接受（退出 0） | 拒绝（退出 1） |
| --- | --- | --- |
| token | JSON 体含非空、无空白的 `access_token` | 非 2xx；任意类型的 `error` 字段（如 `invalid_grant`）；缺失/空/含空白 token；畸形 JSON |
| upload | `uploadState: "SUCCESS"` 且 `itemError` 为空 | `FAILURE`/`IN_PROGRESS`/`NOT_FOUND`/未知值；`SUCCESS` 但 `itemError` 非空或格式不合法（不进入下一步）；非 2xx；畸形 JSON |
| publish | `status[]` 非空且**每个元素都是** `OK`（归类 `submitted` = 本次 dispatch 受理） | `OK` 与拒绝状态混合、非字符串元素、`NOT_AUTHORIZED`、`ITEM_NOT_FOUND`、`ITEM_TAKEN_DOWN`、未知值、缺 `status[]`；仅 `ITEM_PENDING_REVIEW` 是独立拒绝（见下） |

- `ITEM_PENDING_REVIEW` 表示此前可能已有一笔提审在审。它不是本版本已提审的凭证：该步
  以非零退出并附读回指引，不得盲目重试。先从 CWS 后台/API 读回 item 状态；若已存在手工
  提审，记录它并避免重复提审。
- 传输层失败（curl 超时/断连）把该步结果记为 UNCONFIRMED——先读回 item 状态再决定是否
  重试；workflow 绝不自动重试（盲目重提可能造成重复审核）。
- publish 请求使用 v1 文档化的 query 参数 `publishTarget=default`（v1 没有
  `publishMode`）。

## 6. 回滚

[CWS 后台回滚](https://developer.chrome.com/docs/webstore/rollback)会以新的版本号恢复上一个
已发布包，无须再次审核；待审与暂存的提审会被丢弃。先在本地验证兼容性，再由创始人确认
回滚动作与具体的新版本号，方可触发。读回后台和商店页面的版本后，才能声称回滚成功。
以更高版本号发布前向修复也是可选方案。

保留此前获批的上传包及校验和作为回滚凭证。从 `ext-*` 仓库标签重建的包只是重建产物，
在核实前不得声称它与获批上传包等同。

## 7. 维护

Refresh token 可能过期或被撤销。token 步骤报告 API 错误时，先核实凭据状态，必要时按第 2 节重新换发。
client secret 泄露时重做 2b/2c/3 轮换即可，CWS item 与扩展 ID 不受影响。

workflow 使用文档化的 [v1.1 API](https://developer.chrome.com/docs/webstore/api/v1)。将来若迁移 API，须同步更新工作流端点与响应分类器。
