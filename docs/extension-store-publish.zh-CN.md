# Chrome Web Store 上架配置

一次性配置,让 `.github/workflows/extension-publish.yml` 能把 GoTry Session Bridge
扩展发布到 Chrome Web Store(分发通道 B,ADR-21;hotel-fe#3802 事故的后续——商店卡在
0.1.0 的根源正是发布全靠手工)。

## 1. 背景

流水线用 `scripts/package-extension.mjs` 打包 `extension/`,且**只有手动 dispatch 且
`dry_run=false`** 时才经 Chrome Web Store API 上传 store zip。发布需要五个 repo
secret,其余配置都已在 workflow 里。CWS 要求版本严格递增——商店现存 0.1.0,manifest
的 `version` 必须始终高于它。

## 2. 一次性 OAuth 配置

由 founder 用持有 CWS item 的 Google 账号(`danceiny@gmail.com`)做一次。Chrome Web
Store API 走 Google Cloud OAuth2 client credentials,不是 service account。

### 2a. GCP 项目与 API

在 https://console.cloud.google.com/ 用同一 Google 账号建(或复用)项目,然后在
APIs & Services → Library 里启用 Chrome Web Store API。

### 2b. OAuth client

在 APIs & Services → Credentials → Create credentials → OAuth client ID,应用类型选
**Desktop app**。记下 client ID 与 client secret。

### 2c. Refresh token

以 `access_type=offline&prompt=consent` 授权 scope
`https://www.googleapis.com/auth/chromewebstore`,并用 code 换 refresh token。Google
已废弃 `urn:ietf:wg:oauth:2.0:oob` redirect——改用 loopback redirect
(`http://localhost:PORT`)或 https://developers.google.com/oauthplayground
(Appendix → 勾选使用自己的凭据)。refresh token 按密码对待保存。

## 3. Repo secrets

在仓库 Settings → Secrets and variables → Actions 下加五个 secret:

| Secret | 值 |
| --- | --- |
| `CHROME_EXTENSION_ID` | `oeajpiccmonococjcegddlooeeohlbgd` |
| `CHROME_PUBLISHER_ID` | CWS dashboard → Account 里的 publisher ID |
| `CHROME_CLIENT_ID` | 2b 的 OAuth client ID |
| `CHROME_CLIENT_SECRET` | 2b 的 OAuth client secret |
| `CHROME_REFRESH_TOKEN` | 2c 的 refresh token |

## 4. 首次发布

先以 `dry_run=true` dispatch 一次(只打包,验证版本守卫与产物),founder 确认后再以
`dry_run=false` dispatch。CWS 审核需数小时到数天;确认商店页版本更新后才能宣称已发布。

## 5. 维护

Refresh token 连续六个月不用会过期——每年至少 dispatch 两次发布,或重新换发 token。
client secret 泄露时重做 2b/2c/3 轮换即可,CWS item 与扩展 ID 不受影响。
