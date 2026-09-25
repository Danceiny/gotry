[English](extension-privacy.md) | [简体中文](extension-privacy.zh-CN.md)

# Stai 浏览器扩展隐私政策

**最后更新：2026-09-25**

Stai（原名 GoTry Session Bridge）支持获准的旅行检索与供应商门户登录。本文说明扩展自身的行为；网站和 GoTry 后端各自处理其接收的数据。

## 数据与去向

- 对已支持的携程机票及酒店、12306 火车、Dida 供应商门户检索，扩展观察页面自身产生的匹配回包。扩展可将回包文本、页面 URL、标题和挑战标记交给当前连接的 GoTry 桥。
- 为判断登录态，扩展只选取指定 cookie 的**名称**。Chrome 的 cookie API 会返回 cookie 对象，但扩展不会把 cookie 值放入桥接结果，也不会持久保存 cookie 值。
- 桌面形态的桥是本机 `127.0.0.1` 的 8791—8795 端口。在 HotelByte 员工门户形态中，已认证的门户提供短期 join ticket 与自身同源的桥路径；检索结果及状态经门户发送到后端。**后端形态可能将检索数据发出设备。**扩展没有统计或广告 SDK。

## 供应商门户登录

员工门户提供获准的一次性 Dida 登录载荷时，扩展会在内存中处理用户名和密码，打开白名单内的 Dida 登录页，填写并提交表单。供应商通过登录表单接收这些凭据。扩展不将载荷写入持久化扩展存储或通常的桥接结果，也不读取或转发 cookie 值。门户检索还可能操作页面控件以发起查询。这些操作不包括预订或付款；扩展不执行交易。

## 有限使用与联系

Stai 仅将通过 Chrome API 获得的信息用于本文所述的用户可见功能。这些信息的使用遵循 [Chrome Web Store 用户数据政策及 Limited Use 要求](https://developer.chrome.com/docs/webstore/program-policies/limited-use/)。扩展不出售数据、不用于广告；除政策允许的情形外，不允许人工审阅。

GoTry 桌面会话检索遵循 GoTry 的授权闸。用户可随时在 Chrome 中停用扩展。如有问题，请访问 https://github.com/Danceiny/gotry/issues。
