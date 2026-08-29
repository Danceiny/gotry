# GoTry Session Bridge(浏览器扩展)

一次性安装的会话检索数据面(issue #21 传输层方案 C,2026-08-29 founder 定案):在你**自己的** Chrome 登录态里,只读嗅探携程机票检索回包([会话:ctrip-flight]。gotry 不再需要逐连接弹 Chrome 权限框,也不需要开 `chrome://inspect` 远程调试。

## 它做什么 / 不做什么

- ✅ 检索:你(或 agent)发起会话检索时,后台标签页打开携程机票列表页,被动嗅探页面自己发出的 `batchSearch` 响应,文本回传给本机的 gotry。收尾自动关闭自己开的标签。
- ✅ 登录检查:只读登录票据 cookie 的**名字**(cticket/uid/uname/passport),判断「是否已登录」这个布尔事实。
- ✅ 登录引导:把登录入口页**置前台**打开,登录由你在携程官网完成。
- ❌ **不读取、不存储、不回传任何 cookie 值,不接触密码/验证码**;
- ❌ 不向任何站点发起请求(检索请求由站点页面自己发出,扩展只听不写);
- ❌ 不动你已打开的任何标签页(只创建/关闭自己的检索标签;登录标签留给你)。

## 安装(每台浏览器一次,约 30 秒)

1. 跑一次 `npx gotry setup`(或手动:把本目录整体拷到任意固定位置,建议 `~/.gotry/extension/`);
2. Chrome 地址栏打开 `chrome://extensions`;
3. 右上角开启「开发者模式」;
4. 点「加载已解压的扩展程序」,选择本目录(manifest.json 所在目录)。

装好即生效,无任何系统弹窗。卸载/随时可停:扩展卡片上的开关即是总闸(仍受 gotry 授权闸 `sessionAccess` 双重控制)。

## 自检

- 扩展 ID 应为固定的 `olpgkofjhhiiiahdkkbcninhjmegghfe`(manifest 带 `key`,跨机器稳定)——若不一致,说明 manifest 被改动过,不要安装;
- gotry 侧运行 `npx gotry` 后发起一次会话检索,扩展图标应出现(无需点击);桥状态可看 `curl http://127.0.0.1:8791/status`(仅本机回环)。