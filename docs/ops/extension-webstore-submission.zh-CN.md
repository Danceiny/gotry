[English](extension-webstore-submission.md) | [简体中文](extension-webstore-submission.zh-CN.md)

# Stai — Chrome Web Store 上架材料（ADR-21 分发 B 轨）

> 状态：**已上架（2026-09-02，v0.1.0 过审发布）**。商店页：
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

- **名称**：Stai（原名 GoTry Session Bridge）。
- **简述**（≤132 字符）：连接获准的旅行检索与 GoTry，可经本机或员工门户后端传递结果，并辅助供应商登录。
- **描述**：Stai 将获准的携程机票及酒店、12306 火车、Dida 供应商门户检索连接至 GoTry。扩展观察页面的匹配检索回包，仅选取指定登录 cookie 的名称，不转发 cookie 值。桌面形态把结果交给本机 GoTry；已认证的 HotelByte 员工门户可以连接其后端桥，检索数据因此可能离开设备。门户可以提供一次性 Dida 凭据供扩展在内存中代填并提交登录表单；扩展不持久保存该凭据。扩展可操作 Dida 检索控件，但不执行预订或付款。用户可在 Chrome 中停用扩展。详见隐私政策。
- **类目**：Travel；**语言**：中文（简体）+ English

## 审核访问

后台的**测试说明**目前为空。审核员可按公开的 GoTry 安装步骤及自有携程会话检查桌面形态；HotelByte 员工门户 join 与 Dida 一次性登录则需要单独的审核测试账号。若审核覆盖该路径，应直接在后台私密的凭据字段填写专用账号，并在**其他说明**中写清有限步骤。不得把凭据写进本仓库或公开 issue。

## founder 提交清单（顺序）——已走完（2026-09-02 上架）

1. ~~Chrome Web Store 开发者注册（一次性 $5，Google 账号）。~~
2. ~~`node scripts/package-extension.mjs` 产 store zip；准备 128×128 图标与 1280×800 截图（商店后台单独上传）。~~
3. ~~新建 item → 上传 zip → 填写商店文案与隐私披露。~~ 当前商店隐私政策 URL 仍指向已迁移的旧路径；下次提审前须在后台改为 [extension-privacy.md](extension-privacy.zh-CN.md)。
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

## Stai 待提审变更（候选版本 0.2.0.26）

- 线上商店仍为 GoTry Session Bridge 0.1.0。GitHub Release 的 0.2.0.25 早于 Stai 更名，当前 main 却仍使用该版本；不同内容需要新版本号。0.2.0.26 只是准备候选，尚未获准或提审。
- 后台文案与隐私问题须如实覆盖 Dida／HotelByte 权限、门户 join 和登录行为，并记录构建源码 SHA 与 zip 校验值。目前仓库 Actions 未配置 CWS secrets；准确版本与窗口获创始人确认后，可走商店后台手动上传，或由账号所有者配置工作流凭据。
- **商店提交流程由 [#346](https://github.com/Danceiny/gotry/issues/346) 跟踪**；**founder 决策 whether / when / 升哪个 version**（founder-confirm 制，见 `tech-strategy.md` §11 与 `AGENTS.md` 发布纪律）；**版本打包 / devconsole 上传 / 状态跟踪 / 验证**由 release executor 在仓库发布纪律下执行；founder 仅完成账户侧必要的本人审批/2FA。提审前商店版用户调 dida 会得到 needs-extension（与全新站点一致），不影响既有 ctrip/12306 车道。
- unpacked/GitHub Releases 通道不受商店审核影响，`feat/session-dida-portal` 分支合并即生效（PR #297 已 merge，代码与 manifest 已就位）。
- **当前证据边界**：尚无此次后台提审或商店回拉回执。上传、提审受理、商店在架是不同状态，由 [#346](https://github.com/Danceiny/gotry/issues/346) 与 [#537](https://github.com/Danceiny/gotry/issues/537) 跟踪。
