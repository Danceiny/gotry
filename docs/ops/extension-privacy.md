# GoTry Session Bridge Privacy Policy / 隐私政策

**Last updated / 最后更新:2026-08-30**

GoTry Session Bridge ("the extension") is an optional local data bridge for the
GoTry travel assistant. This policy explains what the extension does and does
not do with data.

## Summary(English)

- The extension passively observes flight-search responses **that the page
  itself loads** on `flights.ctrip.com`, and reads only the **names** of login
  cookies to detect whether you are signed in.
- Cookie **values are never read, stored, or transmitted**. Login always
  happens on the airline/OTA website itself, performed by you.
- The only data destination is the GoTry process on **your own machine**
  (loopback `127.0.0.1`, ports 8791-8795). Nothing leaves your machine; there
  is no cloud, no analytics, no ads, no third-party SDK.
- The extension performs **zero writes** on any website: it does not send
  requests to, or modify content of, any page beyond observing responses the
  page itself produced.
- Every GoTry session search still requires your explicit in-session approval
  (GoTry's own consent gate), and the extension can be turned off at any time
  from its browser card, independently of this policy.

## 要点(中文)

- 扩展只**被动嗅探** `flights.ctrip.com` 页面自己发出的航班检索回包;仅读取登录
  cookie 的**名称**判断登录态。
- cookie **值从不被读取、存储或传输**;登录永远由你在携程官网亲自完成。
- 唯一数据去向是**你本机**的 GoTry 进程(回环 `127.0.0.1`,端口 8791-8795);
  不上云、无统计、无广告、无第三方 SDK。
- 扩展对任何网站**零写行为**:不代发请求、不修改页面内容。
- 每次会话检索仍需你在 GoTry 会话内明示授权(gotry 授权闸);扩展卡片可随时
  一键关闭,与本政策相互独立。

## Contact / 联系

Issues: https://github.com/Danceiny/gotry/issues
