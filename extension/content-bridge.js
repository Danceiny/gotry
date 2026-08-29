/**
 * GoTry Session Bridge — ISOLATED-world 桥(manifest 默认 world,document_start)。
 *
 * MAIN world(content-main.js)拿不到 chrome API;本脚本监听页面里的
 * gotry-ctrip-sniff 自定义事件,把响应文本经 chrome.runtime.sendMessage 转发给
 * Service Worker(onMessage 按 sender.tab.id 归属到对应 search job)。
 *
 * 附带页标题快报(gotry-page):SW 在嗅探超时/挑战判定(CHALLENGE_RE)时用它。
 */
;(function () {
  if (window.__gotrySniffBridge) return
  window.__gotrySniffBridge = true

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
    window.addEventListener('DOMContentLoaded', sendPage, { once: true })
  } else {
    sendPage()
  }
})()