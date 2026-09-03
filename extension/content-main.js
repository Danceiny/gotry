/**
 * GoTry Session Bridge — MAIN-world 网络嗅探(manifest world:"MAIN",document_start)。
 *
 * MAIN world 没有 chrome.runtime,只负责:hook 站点自己的 fetch/XHR,把命中
 * 嗅探面的响应文本以 CustomEvent 派发到页面里;ISOLATED 侧的 content-bridge.js
 * 监听事件并经 chrome.runtime 转发给 Service Worker。
 *
 * 嗅探面(与 Node 侧 adapters/ctrip-flight.ts NETWORK_HINTS、adapters/ctrip-hotel.ts
 * HOTEL_NETWORK_HINTS、adapters/rail-12306.ts TRAIN_NETWORK_HINTS 对账,run-all §38
 * 防漂移断言守住):
 *   - 机票:search/api/search/batchSearch(精确接口)
 *   - 酒店(2026-09-03 实装):URL hint 多版接口名 + **形状嗅探兜底**——响应体
 *     JSON 含酒店清单签名即转发,对接口改名免疫(接口名公开资料多版并存,首个
 *     真会话后校准,D-13 同款边界)
 *
 * 只读被动转发:不修改请求、不重放、不伪造(§2.3 反模式红线)——响应由站点自己的
 * 代码发出,我们只听。
 */
;(function () {
  if (window.__gotrySniffInstalled) return
  window.__gotrySniffInstalled = true

  var FLIGHT_HINT_RE = /search\/api\/search\/batchSearch/
  var HOTEL_HINT_RE = /hotels\.ctrip\.com\/(hotels\/api|domestic\/pc\/api)|GetHotelListBySOA|GetHotelListByCity|HotelSearch|hotelsearch/i
  /** 火车(2026-09-03 实装):12306 余票查询 XHR(负载均衡变体 queryG/Z/A/U 全命中) */
  var TRAIN_HINT_RE = /leftTicket\/query/i
  /** 形状嗅探(酒店页兜底;与 Node 侧 looksLikeHotelListBody 签名一致) */
  var HOTEL_BODY_SIG_RE = /"hotelList"|"hotelMatchInfos"|"hotelName"/
  var HOTEL_BODY_MAX = 2_000_000
  var isHotelPage = /(^|\.)hotels\.ctrip\.com$/.test(location.hostname)
  var isTrainPage = /(^|\.)12306\.cn$/.test(location.hostname)

  function dispatch(url, body) {
    try {
      window.dispatchEvent(new CustomEvent('gotry-ctrip-sniff', { detail: { url: String(url), body: String(body) } }))
    } catch { /* 页面环境异常不抛 */ }
  }

  function hotelPageWants(url) {
    return isHotelPage && (HOTEL_HINT_RE.test(url) || FLIGHT_HINT_RE.test(url))
  }
  function trainPageWants(url) {
    return isTrainPage && TRAIN_HINT_RE.test(url)
  }

  var origFetch = window.fetch
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      return origFetch.apply(this, arguments).then(function (res) {
        try {
          var url = ''
          if (typeof input === 'string') url = input
          else if (input && typeof input.url === 'string') url = input.url
          var urlHint = FLIGHT_HINT_RE.test(url) || hotelPageWants(url) || trainPageWants(url)
          var isPost = false
          try { isPost = String((init && init.method) || (input && input.method) || 'GET').toUpperCase() === 'POST' } catch { /* ignore */ }
          var capOk = true
          try {
            var len = Number(res.headers && res.headers.get('content-length'))
            if (isHotelPage && !urlHint && len > HOTEL_BODY_MAX) capOk = false
          } catch { /* 头不可读则放行小体兜底 */ }
          if (urlHint || (isHotelPage && isPost && capOk)) {
            var clone = res.clone()
            clone.text().then(function (t) {
              try {
                if (urlHint || (t.length <= HOTEL_BODY_MAX && HOTEL_BODY_SIG_RE.test(t))) dispatch(url, t)
              } catch { /* 嗅探失败不影响站点自身 */ }
            }).catch(function () { /* 流不可读则跳过 */ })
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
    this.__gotryMethod = typeof method === 'string' ? method.toUpperCase() : 'GET'
    return origOpen.apply(this, arguments)
  }
  XMLHttpRequest.prototype.send = function () {
    var xhr = this
    xhr.addEventListener('load', function () {
      try {
        if (!xhr.__gotryUrl) return
        var urlHint = FLIGHT_HINT_RE.test(xhr.__gotryUrl) || hotelPageWants(xhr.__gotryUrl) || trainPageWants(xhr.__gotryUrl)
        if (!urlHint && !(isHotelPage && xhr.__gotryMethod === 'POST')) return
        var body = ''
        if (xhr.responseType === '' || xhr.responseType === 'text') body = xhr.responseText
        else if (xhr.responseType === 'json') body = JSON.stringify(xhr.response)
        else return
        if (!body) return
        if (urlHint || (body.length <= HOTEL_BODY_MAX && HOTEL_BODY_SIG_RE.test(body))) dispatch(xhr.__gotryUrl, body)
      } catch { /* 嗅探失败不影响站点 */ }
    })
    return origSend.apply(this, arguments)
  }
})()
