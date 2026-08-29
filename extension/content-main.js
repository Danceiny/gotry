/**
 * GoTry Session Bridge — MAIN-world 网络嗅探(manifest world:"MAIN",document_start)。
 *
 * MAIN world 没有 chrome.runtime,只负责:hook 站点自己的 fetch/XHR,把命中
 * NETWORK_HINTS(batchSearch)的响应文本以 CustomEvent 派发到页面里;
 * ISOLATED 侧的 content-bridge.js 监听事件并经 chrome.runtime 转发给 Service Worker。
 *
 * 只读被动转发:不修改请求、不重放、不伪造(§2.3 反模式红线)——响应由站点自己的
 * 代码发出,我们只听。
 */
;(function () {
  if (window.__gotrySniffInstalled) return
  window.__gotrySniffInstalled = true

  /** 与 Node 侧 adapters/ctrip-flight.ts NETWORK_HINTS 对账(run-all §38 防漂移断言) */
  var HINT_RE = /search\/api\/search\/batchSearch/

  function dispatch(url, body) {
    try {
      window.dispatchEvent(new CustomEvent('gotry-ctrip-sniff', { detail: { url: String(url), body: String(body) } }))
    } catch { /* 页面环境异常不抛 */ }
  }

  var origFetch = window.fetch
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      return origFetch.apply(this, arguments).then(function (res) {
        try {
          var url = ''
          if (typeof input === 'string') url = input
          else if (input && typeof input.url === 'string') url = input.url
          if (HINT_RE.test(url)) {
            var clone = res.clone()
            clone.text().then(function (t) { dispatch(url, t) }).catch(function () { /* 流不可读则跳过 */ })
          }
        } catch { /* 嗅探失败不影响站点自身 */ }
        return res
      })
    }
  }

  var origOpen = XMLHttpRequest.prototype.open
  var origSend = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__gotryUrl = typeof url === 'string' ? url : String(url ?? '')
    return origOpen.apply(this, arguments)
  }
  XMLHttpRequest.prototype.send = function () {
    var xhr = this
    xhr.addEventListener('load', function () {
      try {
        if (!xhr.__gotryUrl || !HINT_RE.test(xhr.__gotryUrl)) return
        var body = ''
        if (xhr.responseType === '' || xhr.responseType === 'text') body = xhr.responseText
        else if (xhr.responseType === 'json') body = JSON.stringify(xhr.response)
        else return
        if (body) dispatch(xhr.__gotryUrl, body)
      } catch { /* 嗅探失败不影响站点 */ }
    })
    return origSend.apply(this, arguments)
  }
})()