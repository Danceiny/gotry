/**
 * GoTry Session Bridge — ISOLATED-world 桥(manifest 默认 world,document_start)。
 *
 * MAIN world(content-main.js)拿不到 chrome API;本脚本监听页面里的
 * gotry-ctrip-sniff 自定义事件,把响应文本经 chrome.runtime.sendMessage 转发给
 * Service Worker(onMessage 按 sender.tab.id 归属到对应 search job)。
 *
 * 附带页标题快报(gotry-page):SW 在嗅探超时/挑战判定(CHALLENGE_RE)时用它。
 *
 * Join 投递(2026-09-11,hotelbyte 产品定案):hotel-be portal 在员工已登录的
 * 页面里挂一段 `window.__gotryJoinTicket = {...}` 即可,本脚本负责:
 *   - 页面派发 ticket → SW 静默接收(员工全程不接触 URL/token);
 *   - ticket 未注入 → 静默 no-op(扩展安静等下次 portal 页加载);
 *   - portal 自己负责派发的合规性(token 由 portal 后端签发,扩展不验签,
 *     Node 侧 gotry-backend 经 Bearer 校验——信任链在 hotel-be ↔ gotry-backend 之间)。
 */
;(function () {
  if (window.__gotrySniffBridge) return
  window.__gotrySniffBridge = true

  function dispatchJoinTicket() {
    try {
      var t = window.__gotryJoinTicket
      if (!t || typeof t.bridgeUrl !== 'string' || !t.bridgeUrl) return
      chrome.runtime.sendMessage({ type: 'gotry-join', ticket: t }).catch(function () { /* SW 重启中 */ })
    } catch { /* 不抛 */ }
  }

  window.addEventListener('gotry-ctrip-sniff', function (ev) {
    try {
      var d = (ev && ev.detail) || {}
      if (!d.body) return
      chrome.runtime.sendMessage({
        type: 'gotry-sniff',
        url: d.url,
        body: d.body,
        title: document.title || '',
      }).catch(function () { /* SW 重启中,下一条嗅探再投 */ })
    } catch { /* 不抛 */ }
  })

  function sendPage() {
    try {
      chrome.runtime.sendMessage({
        type: 'gotry-page',
        title: document.title || '',
        url: location.href,
      }).catch(function () { /* SW 侧无等待者,常态丢弃 */ })
    } catch { /* 环境异常不抛 */ }
  }
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', function () { sendPage(); dispatchJoinTicket() }, { once: true })
  } else {
    sendPage()
    dispatchJoinTicket()
  }
})()