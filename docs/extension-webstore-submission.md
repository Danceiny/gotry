# GoTry Session Bridge — Chrome Web Store 上架材料(ADR-21 分发 B 轨)

> 状态:**已上架(2026-09-02,v0.1.0 过审发布)**。商店页:
> https://chromewebstore.google.com/detail/gotry-session-bridge/oeajpiccmonococjcegddlooeeohlbgd
> 产物:`node scripts/package-extension.mjs` → `dist-extension/gotry-session-bridge-store.zip`
> (manifest 在 zip 根,商店后台直传)。图标商店单独上传,不在 zip 内。
>
> **上架实测(预案坐实)**:商店用自己生成的签名 key 重签,**不认 manifest 里的固定 key**——
> 商店版扩展 ID = `oeajpiccmonococjcegddlooeeohlbgd`(item ID,即商店页 URL 末段),
> 与 unpacked 固定 ID `olpgkofjhhiiiahdkkbcninhjmegghfe` 不同。影响面收口与本文档预言一致:
> 本机桥 Origin 白名单改双通道同信(`extension-bridge.ts` 的 `EXTENSION_ORIGINS`,
> run-all §38 回归);扩展代码与 manifest 无需改动(端口池/host 白名单不随通道漂移)。

## 为什么走商店(平台约束)

Chrome 禁止普通用户从任意 URL 安装打包 CRX:GitHub Releases 只能改善「下载」,
消不掉「开发者模式 → 加载已解压」的 3 次点击。**一键安装 + 自动更新只有 Chrome Web Store
一条路**。商店版与 unpacked 版扩展 ID 不同(商店重签,见上),两个 ID 同为
founder 控制的同一扩展,桥侧白名单双收;端口池(8791-8795)与 host 白名单不变。

## 单一用途声明(Single Purpose,审核必填)

> 在用户自己的携程航班检索页面上,只读嗅探页面自身发出的检索回包与登录票据
> cookie 的**名称**,经本机回环端口(127.0.0.1)交给用户本机的 GoTry 程序,
> 用于在用户明示授权下复用其登录态做行程数据交叉验证。扩展零写行为、零数据外传。

## 权限逐条理由(Permission Justifications,审核必填)

| 权限 | 理由(可直接粘贴) |
|---|---|
| `cookies` | 仅读取 cookie **名称**判断登录态(「已登录才检索」的用户门)。绝不读取、存储或传输 cookie 值;登录永远在携程官网由用户完成。 |
| `alarms` | MV3 Service Worker 保活(长轮询取活间隔的调度),不涉及任何数据面。 |
| `http://127.0.0.1:8791-8795/*` | 与用户本机 GoTry 进程的回环通信(检索任务下发/回包上交)。仅本机,不涉外网。 |
| `https://*.ctrip.com/*` | 被动嗅探 flights.ctrip.com 页面**自己发出**的 batchSearch 检索回包(MAIN-world 被动监听,扩展不发起、不修改任何请求);cookie 名读取也在该域。 |
| content_scripts(flights.ctrip.com,双 world) | MAIN world 被动嗅探 + isolated world 桥接本机回环;两者都不改写页面、不注入 UI。 |

## 隐私披露(Privacy tab)

- 不收集个人身份信息;不出售、不共享、不用于第三方目的;无分析/广告 SDK。
- 唯一数据流向:页面检索回包片段与 cookie **名** → 127.0.0.1 本机 GoTry 进程,不落云。
- 隐私政策 URL(后台必填):`https://github.com/Danceiny/gotry/blob/main/docs/extension-privacy.md`

## 商店文案(可直接粘贴)

- **名称**:GoTry Session Bridge
- **简述**(≤132 字符):在你自己的登录态里只读嗅探航班检索结果,交给本机 GoTry 做行程交叉验证。零凭证经手,零写行为,零数据外传。
- **描述**:GoTry 是本地优先的 AI 旅行助手。本扩展是它的可选数据桥:安装一次后,GoTry 可以在你**自己的**携程登录态里做只读航班检索(交叉验证官方通道结果),不再需要开启浏览器调试端口,也没有系统级权限弹窗。只读:嗅探页面自身的检索回包,只取 cookie 名称判断登录态,绝不读值、绝不写、绝不上传。随时可在扩展卡片一键关闭。详见仓库 README。
- **类目**:Travel;**语言**:中文(简体)+ English

## founder 提交清单(顺序)——已走完(2026-09-02 上架)

1. ~~Chrome Web Store 开发者注册(一次性 $5,Google 账号)。~~
2. ~~`node scripts/package-extension.mjs` 产 store zip;准备 128×128 图标与 1280×800 截图(商店后台单独上传)。~~
3. ~~新建 item → 上传 zip → 粘贴上文文案/权限理由/隐私披露 → 隐私政策 URL 指向 `docs/extension-privacy.md` 的 GitHub 链接。~~
4. ~~提交审核~~ → 过审发布(v0.1.0)。
5. 过审后落地:桥 Origin 白名单双通道同信(已落,`EXTENSION_ORIGINS` + §38);wizard/README 文案商店优先(已落);「已装商店版自动跳过 dev-mode 三步」的 wizard 检测仍后置(D-24 残余)。GitHub Releases 通道(A 轨)保留为免审核/版本化/回滚/镜像通道。

## 后续发版(商店通道)

- 商店版更新:升 `extension/manifest.json` 的 `version` → `node scripts/package-extension.mjs` → devconsole 上传新 zip 提审。
- GitHub 通道更新:`ext-*` 标签 release 资产三件套(tar.gz/store-zip/dist-manifest),用户侧 `npx gotry setup --extension-from=github` 拉取。

## 三通道关系

| | Chrome Web Store(推荐) | GitHub Releases(免审核) | npm 包内副本(离线兜底) |
|---|---|---|---|
| 一键安装 | ✓ | ✗(开发者模式 3 次点击) | ✗(同左) |
| 自动更新 | ✓(随商店发版) | ✗(`--extension-from=github` 手动拉新版) | ✗(随 npm 发版) |
| 审核成本 | 注册 + 审核 | 无 | 无 |
| 版本化/回滚/镜像 | ✗(商店节奏) | ✓(Release 资产 + SHA256) | ✗ |
| 扩展 ID | `oeajpiccmonococjcegddlooeeohlbgd` | `olpgkofjhhiiiahdkkbcninhjmegghfe` | `olpgkofjhhiiiahdkkbcninhjmegghfe` |
