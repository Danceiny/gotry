[English](README.md) | [简体中文](README.zh-CN.md)

# Stai 浏览器扩展

Stai（原名 GoTry Session Bridge）将已支持的旅行检索页面连接至 GoTry。商店版与本地加载版的扩展 ID 不同，但使用相同的桥接合同。

## 功能

- 观察已支持的携程机票及酒店、12306 火车、Dida 供应商门户页面的匹配检索回包。扩展只选取指定登录 cookie 的**名称**，不转发 cookie 值。
- 桌面形态将检索结果及状态发送到本机 GoTry 桥。已认证的 HotelByte 员工门户也可提供短期票据，接入其后端桥；此时检索数据可能离开设备。
- 门户提供获准的一次性 Dida 登录凭据时，扩展在内存中处理，打开白名单内的登录页，填写并提交表单。扩展还可操作 Dida 检索控件。扩展不在持久化存储中保存凭据，也不执行预订或付款。

数据和去向的现行说明见[隐私政策](https://github.com/Danceiny/gotry/blob/main/docs/ops/extension-privacy.zh-CN.md)。

## 安装

1. [Chrome Web Store](https://chromewebstore.google.com/detail/gotry-session-bridge/oeajpiccmonococjcegddlooeeohlbgd)：一键安装，商店自动更新。依赖 Dida／HotelByte 能力前，请核对**商店页显示的版本**；审核期间商店版可能晚于源码与 GitHub 包。
2. GitHub Releases：运行 `npx @danceiny/gotry setup --extension-from=github`；或下载并校验对应 `ext-*` 标签的 `gotry-session-bridge.tar.gz`，解压后在 `chrome://extensions` 开启开发者模式并加载目录。
3. npm 包内兜底：运行 `npx @danceiny/gotry setup`，再到 `chrome://extensions` 加载 `~/.gotry/extension`。npm 包可能晚于源码和 GitHub 扩展 Release。

商店版 ID 为 `oeajpiccmonococjcegddlooeeohlbgd`；本地加载版 ID 为 `olpgkofjhhiiiahdkkbcninhjmegghfe`。桌面形态的 GoTry 本机桥监听 `127.0.0.1` 的 8791—8795 端口。
