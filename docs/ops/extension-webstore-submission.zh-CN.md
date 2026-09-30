[English](extension-webstore-submission.md) | [简体中文](extension-webstore-submission.zh-CN.md)

# Stai Travel Bridge — Chrome Web Store 上架材料（ADR-21 分发 B 轨）

> 状态：**v0.2.0.26（listing 名称 Stai）于 2026-09-25 提审，2026-09-26 被拒——内容政策
> 「提供的元数据与观察到的功能无关」（参考 ID Red Potassium）；线上仍为 v0.1.0**。
> 2026-09-30 founder 拍板改名为 **Stai Travel Bridge**（Travel 对齐机票/酒店/火车检索面，
> Bridge 对齐桥接功能）并以 v0.2.0.27 重新提审。商店页：
> https://chromewebstore.google.com/detail/gotry-session-bridge/oeajpiccmonococjcegddlooeeohlbgd
> 产物：`node scripts/package-extension.mjs` → `dist-extension/gotry-session-bridge-store.zip`
> （manifest 在 zip 根，商店后台直传）。图标商店单独上传，不在 zip 内。
>
> **上架实测（预案坐实）**：商店用自己生成的签名 key 重签，**不认 manifest 里的固定 key**——
> 商店版扩展 ID = `oeajpiccmonococjcegddlooeeohlbgd`（item ID，即商店页 URL 末段），
> 与 unpacked 固定 ID `olpgkofjhhiiiahdkkbcninhjmegghfe` 不同。影响面收口与本文档预言一致：
> 本机桥 Origin 白名单改双通道同信（`extension-bridge.ts` 的 `EXTENSION_ORIGINS`，
> run-all §38 回归）；扩展代码与 manifest 无需改动（端口池/host 白名单不随通道漂移）。

## 为什么走商店（平台约束）

Chrome 禁止普通用户从任意 URL 安装打包 CRX：GitHub Releases 只能改善「下载」，
消不掉「开发者模式 → 加载已解压」的 3 次点击。**一键安装 + 自动更新只有 Chrome Web Store
一条路**。商店版与 unpacked 版扩展 ID 不同（商店重签，见上），两个 ID 同为
founder 控制的同一扩展，桥侧白名单双收；端口池（8791-8795）与 host 白名单不变。

## 单一用途声明（Single Purpose，审核必填）

> Stai 将获准的携程机票及酒店、12306 火车、Dida 供应商门户检索连接至 GoTry。
> 扩展把页面产生的检索结果与指定登录 cookie 的**名称**交给本机桥，或员工门户
> 提供的已认证后端桥。员工门户还可提供一次性 Dida 登录载荷，供扩展填写并提交
> 登录表单。扩展不执行预订或付款。

## 权限逐条理由（Permission Justifications，审核必填）

| 权限 | 理由（可直接粘贴） |
|---|---|
| `cookies` | 选取指定 cookie 的**名称**判断携程或 Dida 登录态；不把 cookie 值放进桥接结果或持久化扩展存储。 |
| `alarms` | MV3 Service Worker 保活（长轮询取活间隔的调度），不涉及任何数据面。 |
| `http://127.0.0.1:8791-8795/*` | 桌面形态的本机 GoTry 桥健康检查、任务轮询与结果交付。 |
| `https://*.ctrip.com/*` | 携程机票及酒店页面回包观察和登录态 cookie 名称检查。 |
| `https://*.dida.com/*`、`https://dida.com/*`、`http://*.dida.com/*`、`http://dida.com/*` | Dida 门户回包观察与 cookie 名称检查，包含非 Secure 会话 cookie 的域变体。 |
| `https://portal.hotelbyte.com/*`、`https://portal-test.hotelbyte.com/*` | 员工门户 join ticket 与一次性供应商登录载荷交接；门户签发同源桥路径，该形态的检索结果和状态可能离开设备。 |
| 携程、12306、Dida 与 HotelByte 页面上的内容脚本 | 观察匹配回包、传递门户数据、操作获准的 Dida 检索，以及代填并提交门户提供的 Dida 登录。 |

## 隐私披露（Privacy tab）

- 准确申报页面检索内容、页面 URL／标题、登录 cookie 名称、可选后端传输，以及一次性供应商登录凭据处理；不得再声称「零凭证经手」「仅本机」「零写行为」。
- 数据使用清单勾选**身份验证信息**与**网站内容**。供应商用户名可能是邮箱，另勾选**个人身份信息**；桥可能收到当前页面 URL 与标题，另勾选**网络记录**。没有证据的其他类别不勾选。
- 扩展没有统计或广告 SDK，也不执行预订、付款。
- 门户把桥地址限制在自身同源。旧版全网 HTTP／HTTPS 可选主机权限没有被实际使用，本候选版本已移除。
- 隐私政策 URL（后台必填）：`https://github.com/Danceiny/gotry/blob/main/docs/ops/extension-privacy.md`

## 商店文案（可直接粘贴）

- **名称**：Stai Travel Bridge（原名 GoTry Session Bridge；v0.2.0.26 以裸品牌名 Stai 提审被拒，2026-09-30 改名重提）。
- **简述**（≤132 字符）：连接获准的旅行检索与 GoTry，可经本机或员工门户后端传递结果，并辅助供应商登录。
- **描述**：Stai 将获准的携程机票及酒店、12306 火车、Dida 供应商门户检索连接至 GoTry。扩展观察页面的匹配检索回包，仅选取指定登录 cookie 的名称，不转发 cookie 值。桌面形态把结果交给本机 GoTry；已认证的 HotelByte 员工门户可以连接其后端桥，检索数据因此可能离开设备。门户可以提供一次性 Dida 凭据供扩展在内存中代填并提交登录表单；扩展不持久保存该凭据。扩展可操作 Dida 检索控件，但不执行预订或付款。用户可在 Chrome 中停用扩展。详见隐私政策。
- **类目**：Travel；**语言**：中文（简体）+ English

## 审核访问

后台的**其他说明**已写入公开 GoTry 安装步骤与审核员自有携程／12306 会话的桌面路径，也明确说明受限的 HotelByte 员工门户 join 与 Dida 一次性登录路径尚未提供审核凭据。若审核需要覆盖该路径，应直接在后台私密的凭据字段填写专用测试账号。不得把凭据写进本仓库或公开 issue。

## founder 提交清单（顺序）——已走完（2026-09-02 上架）

1. ~~Chrome Web Store 开发者注册（一次性 $5，Google 账号）。~~
2. ~~`node scripts/package-extension.mjs` 产 store zip；准备 128×128 图标与 1280×800 截图（商店后台单独上传）。~~
3. ~~新建 item → 上传 zip → 填写商店文案与隐私披露。~~ v0.2.0.26 提审时已把隐私政策 URL 改为 [extension-privacy.md](extension-privacy.zh-CN.md)；v0.1.0 线上页可能要等新版发布后才更新。
4. ~~提交审核~~ → 过审发布（v0.1.0）。
5. 过审后落地：桥 Origin 白名单双通道同信（已落，`EXTENSION_ORIGINS` + §38）；Node 侧保留 extension 文件/`manifest.key` 预检，`sessionFlightSearch`/`sessionLogin` 在 `needs-extension` 时以 `installUrl`/`installAction` 交 dsh UI，旧 wizard 不再承担安装职责。GitHub Releases 通道（A 轨）保留为免审核/版本化/回滚/镜像通道。

## 后续发版（商店通道）

- 商店版更新：升 `extension/manifest.json` 的 `version` → `extension-publish.yml` 流水线在
  `extension/**` 推送时自动打包；publish job（手动 dispatch、`dry_run=false`、founder
  确认制）经 CWS REST API 上传并提审——配置、响应语义与 fail-closed 规则见
  [extension-store-publish.zh-CN.md](../extension-store-publish.zh-CN.md)。devconsole 手工
  上传保留为兜底；仓库发布纪律（AGENTS.md）与商店回拉验证要求不变。
- GitHub 通道更新：`ext-*` 标签 release 资产三件套（tar.gz/store-zip/dist-manifest），用户侧 `npx @danceiny/gotry setup --extension-from=github` 拉取。

## 三通道关系

| | Chrome Web Store（推荐） | GitHub Releases（免审核） | npm 包内副本（离线兜底） |
|---|---|---|---|
| 一键安装 | ✓ | ✗（开发者模式 3 次点击） | ✗（同左） |
| 自动更新 | ✓（随商店发版） | ✗（`--extension-from=github` 手动拉新版） | ✗（随 npm 发版） |
| 审核成本 | 注册 + 审核 | 无 | 无 |
| 版本化/回滚/镜像 | ✗（商店节奏） | ✓（Release 资产 + SHA256） | ✗ |
| 扩展 ID | `oeajpiccmonococjcegddlooeeohlbgd` | `olpgkofjhhiiiahdkkbcninhjmegghfe` | `olpgkofjhhiiiahdkkbcninhjmegghfe` |

## Stai v0.2.0.26 审核回执

- 创始人已确认 v0.2.0.26 并要求立即提审。[PR #586](https://github.com/Danceiny/gotry/pull/586) 合并后的提交为 `3925d1a5963a32c8708d358d14ed70999580d967`；该提交构建的商店 zip SHA-256 为 `7c88b2e21a7546c99917b96ba16b37b5d6674f93ab9461dd26d12573af57e7a2`。相同版本的 [ext-v0.2.0.26 GitHub Release](https://github.com/Danceiny/gotry/releases/tag/ext-v0.2.0.26) 资产已回拉校验。
- 商店后台接受 zip，草稿显示 `version_name` 为 `0.2.0-rc.26`（`version` 为 `0.2.0.26`）。文案、权限理由、数据使用清单及隐私政策 URL 已按 Dida／HotelByte 实际行为更新。2026-09-25，后台返回「已将您的扩展程序提交送审」，状态为「待审核」。已选择过审后自动发布；上线前不能做 Chrome Web Store 回拉验证。仓库 Actions 目前未配置 CWS secrets，故本次使用后台上传。
- **商店提交流程由 [#346](https://github.com/Danceiny/gotry/issues/346) 跟踪**；**founder 决策 whether / when / 升哪个 version**（founder-confirm 制，见 `tech-strategy.md` §11 与 `AGENTS.md` 发布纪律）；**版本打包 / devconsole 上传 / 状态跟踪 / 验证**由 release executor 在仓库发布纪律下执行；founder 仅完成账户侧必要的本人审批/2FA。提审前商店版用户调 dida 会得到 needs-extension（与全新站点一致），不影响既有 ctrip/12306 车道。
- unpacked/GitHub Releases 通道不受商店审核影响，`feat/session-dida-portal` 分支合并即生效（PR #297 已 merge，代码与 manifest 已就位）。
- **当前证据边界**：提审已受理，但线上商店仍为 v0.1.0。须待 v0.2.0.26 过审、上线并完成商店回拉验证后，才能关闭 [#346](https://github.com/Danceiny/gotry/issues/346) 或 [#537](https://github.com/Danceiny/gotry/issues/537)。

## Stai v0.2.0.26 拒审回执与 v0.2.0.27 重提（2026-09-30）

- **拒审事实**（2026-09-30 后台直读，账号 danceiny@gmail.com）：v0.2.0.26 草稿状态「已拒绝」，违规日期 2026-09-26，类型=内容政策，违规=「提供的元数据与观察到的功能无关」，纠正指引=元数据须准确描述产品实际功能，参考 ID `Red Potassium`；后台保留申诉入口（未使用）。
- **归因**：listing/manifest 名称是裸品牌词 `Stai`，与审核员观察到的行为（机票/酒店/火车检索回包观察、登录 cookie 名检查、供应商门户一次性登录代填、loopback 桥接）之间无可读关联；描述文案虽已具体，名称层面的「功能词缺失」足以触发元数据不相关判定。
- **处置**：founder 2026-09-30 拍板改名 **Stai Travel Bridge**（Travel 对齐检索面，Bridge 对齐桥接）并重提，不做申诉。v0.2.0.27 = manifest name 改名 + 版本推进（version `0.2.0.27` / version_name `0.2.0-rc.27`），listing 文案、权限理由、隐私申报沿用 v0.2.0.26 已修正版本（「零凭证经手」类旧表述已在 #586 清除）。
- **重提回执（2026-09-30）**：PR #597 合并（main `ecfd4c8`），exact-SHA 重建 zip SHA-256 `65bdb8f37ae87386d3d710f18bf59c174d296fd2150a1ecbafb0d70e7bb7e347`，[ext-v0.2.0.27 Release](https://github.com/Danceiny/gotry/releases/tag/ext-v0.2.0.27) 三资产已发布；dashboard 上传后软件包中的标题显示 Stai Travel Bridge、草稿版本 `0.2.0-rc.27`，「提请审核 → 提交审核」完成，状态 **待审核**。CWS secrets 仍空配，本次仍为 dashboard 路径。操作配方：包内 file input 忽略合成 click（无 user activation），经页面 JS DataTransfer 注入 File 后派发 change 事件完成上传；「提请审核」在 /edit 落地页头部，签名密钥提示以「知道了」关闭。

## 过审后品牌 Chrome 验收矩阵

仅在线上商店提供 v0.2.0.26 后执行。将证据存入私有且带日期的目录，例如 `~/.gotry/evidence/extension/stai-0.2.0.26/<timestamp>/`；公开 issue 仅记录脱敏裁决和产物哈希。不得保存 cookie 值、join ticket、一次性凭据、个人行程或供应商原始回包。使用普通 Chrome 中商店签名的 `oeajpiccmonococjcegddlooeeohlbgd`，不用解压安装版 ID 或 Chrome for Testing 配置。记录 Chrome 版本、扩展版本、商店页版本、桥协议和测试时间，以便复现。

| 闸门 | 可复现操作 | 证据及通过条件 |
|---|---|---|
| 公开回拉 | 打开公开商店条目，在普通 Chrome 安装或更新 Stai。核对已安装版本及携程、Dida、HotelByte 权限；只启用一条 Stai 通道。 | 商店公开版与已安装版均为 `0.2.0.26`，条目 ID 仍为商店 ID。分别记录旧 v0.1.0 自动更新与全新安装的结果。后台草稿获批本身不算通过。 |
| 桌面连接 | 启动 GoTry 本机桥后，只读查询 `http://127.0.0.1:8791/health` 和 `/status`；必要时打开受支持页面唤醒扩展。 | 健康检查返回 `session-bridge.v1`；状态返回 `extensionConnected: true` 且心跳时间足够近。类型化不可用结果记为失败或降级观察，不记为命中。 |
| 员工门户 join | 在获准的员工账号下打开 `https://portal.hotelbyte.com/` 或对应测试站，按正常流程 join。通过获准界面只读查询门户后端的 `bridge/status`。 | 门户发出一次性 join ticket 后，状态为 `extensionConnected: true`。只记录布尔值、时间和端点类别；不导出 ticket 或 bearer token。没有员工账号时标记为**未执行**。 |
| Dida 登录及 D-37 | 账号持有人从门户按正常流程在普通 Chrome 完成 Dida 登录。只读查询获准的 `sessionChannel/status`，再执行一次有界的只读 Dida 检索。 | 观察到 `loggedIn: true` 和类型化命中或明确未命中；真实退出登录时返回 `needs-login`。记录 cookie 名称级检测是否与页面会话一致。本商店验收不得使用 Chrome for Testing 的跳过登录闸参数。遇到挑战立即停止。 |

门户 join 与 Dida 闸门需要获准使用该供应商的员工门户账号；若登录需要介入，则由账号持有人完成，或仅在商店后台的私密字段提供专用审核凭据。这些是测试前置条件，不得将凭据写入仓库。[#346](https://github.com/Danceiny/gotry/issues/346) 在公开回拉、权限、更新和桌面连接检查通过后关闭。[#537](https://github.com/Danceiny/gotry/issues/537) 还须完整通过门户 join 与 Dida 登录链路。[#272](https://github.com/Danceiny/gotry/issues/272) 的真实适配器验收范围更广，须另有证据才能关闭。
