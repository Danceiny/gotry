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
 *
 * 代填登录(2026-09-21,hotel-fe#3713 形态 A「免密进入门户」):
 *   - portal 页把**一次性凭据载荷**({site,loginUrl,username,password,字段名})经
 *     `window.__gotryPortalLogin` + 同名事件投给 SW;SW 打开登录页后回派本脚本填表。
 *   - 载荷只在本脚本/本次调用内存活:不写 DOM 之外的面、不回传账密、不落持久存储
 *     (扩展无 storage 权限,见 §38 合同);填完即弃。
 *   - 站点配方(dida 等):勾选协议框 + 触发原生提交,避免 React 受控输入吞值。
 */
;(function () {
  if (window.__gotrySniffBridge) return
  window.__gotrySniffBridge = true

  function dispatchJoinTicket(ev) {
    try {
      // 本脚本跑在隔离世界:页面主世界设置的 window 属性读不到,票据本体必须
      // 走事件的 detail(2026-09-21 hotel-fe#3713 E2E 实证);window 属性仅作
      // MAIN-world 观察面兜底,取不到就安静等下一次事件。
      var t = (ev && ev.detail && ev.detail.ticket) || window.__gotryJoinTicket
      if (!t || typeof t.bridgeUrl !== 'string' || !t.bridgeUrl) return
      chrome.runtime.sendMessage({ type: 'gotry-join', ticket: t }).catch(function () { /* SW 重启中 */ })
    } catch { /* 不抛 */ }
  }

  /** portal 页投递的一次性凭据载荷 → SW(载荷随消息过手即弃,不落任何存储) */
  function dispatchPortalLogin(ev) {
    try {
      var p = (ev && ev.detail && ev.detail.payload) || window.__gotryPortalLogin
      if (!p || typeof p.loginUrl !== 'string' || !p.loginUrl) return
      chrome.runtime.sendMessage({ type: 'gotry-portal-login', payload: p }).catch(function () {})
    } catch { /* 不抛 */ }
  }

  /** 原生设值:React 受控 input 需走原型 setter + input/change 事件,直接赋 value 会被吞 */
  function setNativeValue(el, value) {
    var desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')
    if (desc && desc.set) desc.set.call(el, value)
    else el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  /** 按站点配方填表并提交;返回结果不含任何账密(红线:只有布尔/错误文案) */
  function fillLogin(payload) {
    var uf = payload.usernameField || 'username'
    var pf = payload.passwordField || 'password'
    var user = document.querySelector('input[name="' + uf + '"]')
      || document.querySelector('input[type="text"], input[type="email"]')
    var pass = document.querySelector('input[name="' + pf + '"]')
      || document.querySelector('input[type="password"]')
    if (!user || !pass) return { ok: false, error: 'login inputs not found' }
    setNativeValue(user, payload.username)
    setNativeValue(pass, payload.password)
    // 协议框:登录页常见「已阅读并同意」前置,未勾选则点选(按文案匹配,不靠下标)
    var boxes = document.querySelectorAll('input[type="checkbox"]')
    for (var i = 0; i < boxes.length; i++) {
      var box = boxes[i]
      if (box.checked) continue
      var label = ''
      try { label = ((box.closest('label,div') || box.parentElement || {}).textContent || '') } catch { label = '' }
      if (/agree|agreement|terms|service|协议|同意/i.test(label)) box.click()
    }
    var btn = null
    var buttons = document.querySelectorAll('button, input[type="submit"]')
    for (var j = 0; j < buttons.length; j++) {
      var b = buttons[j]
      if ((b.type === 'submit' || b.tagName === 'BUTTON') && /log\s*-?\s*in|sign\s*-?\s*in|登录/i.test(b.textContent || b.value || '')) { btn = b; break }
    }
    if (btn) btn.click()
    else {
      var form = user.form || (user.closest && user.closest('form'))
      if (form && typeof form.requestSubmit === 'function') form.requestSubmit()
      else if (form) form.submit()
      else return { ok: false, error: 'no submit target' }
    }
    return { ok: true, filled: true }
  }

  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (msg && msg.type === 'gotry-fill-login') {
      var result
      try { result = fillLogin(msg.payload || {}) } catch (e) { result = { ok: false, error: String((e && e.message) || e).slice(0, 120) } }
      sendResponse && sendResponse(result)
      return false
    }
    if (msg && msg.type === 'gotry-dida-search') {
      // 驱动 dida 门户目的地搜索(2026-09-21 实测定型:目的地组首项 + button[name=search])
      runDidaSearch(msg.params || {})
        .then(function (r) { sendResponse && sendResponse(r) })
        .catch(function (e) { sendResponse && sendResponse({ ok: false, error: String((e && e.message) || e).slice(0, 120) }) })
      return true // 异步响应
    }
    return false
  })

  /**
   * dida 门户「目的地搜索」配方(2026-09-21 Chrome 实测跑通)。
   * 步骤:关 cookie 授权弹窗 → 填城市 → 点「目的地」组首项 → 点查询按钮 → 等跳 /hotel/list。
   * 返回落地 URL(含 regionID/日期/入住参数)——日期不驱动(门户用自身默认值),
   * 由调用方按落地 URL 的参数格式重写日期后再导航,避免与门户日期选择器耦合。
   */
  function runDidaSearch(params) {
    var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
    var norm = function (t) { return String(t || '').replace(/\s+/g, ' ').trim() }
    var log = []

    function closeCookieModal() {
      var wrap = document.querySelector('.ant-modal-wrap')
      if (!wrap) return
      var btn = Array.prototype.slice.call(wrap.querySelectorAll('button')).find(function (b) { return /确定|接受所有Cookie|Accept/i.test(norm(b.textContent)) })
      if (btn) { btn.click(); log.push('cookie-modal-closed') }
    }

    function setNativeValueState(el, value) {
      var desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')
      if (desc && desc.set) desc.set.call(el, value); else el.value = value
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }

    closeCookieModal()
    return sleep(500).then(function () {
      var tries = 0
      return new Promise(function (resolve) {
        (function waitInput() {
          var el = document.querySelector('input[placeholder*="城市"]')
          if (el) return resolve(el)
          if (++tries > 40) return resolve(null)
          setTimeout(waitInput, 500)
        })()
      })
    }).then(function (input) {
      if (!input) return { ok: false, step: 'city-input', log: log }
      input.focus(); input.click()
      setNativeValueState(input, String(params.city || ''))
      log.push('city-typed')
      return sleep(3500)
    }).then(function () {
      // 目的地候选:优先「目的地」组首项,退化为第一个候选
      var deadline = Date.now() + 12000
      return new Promise(function (resolve) {
        (function tryPick() {
          var groups = Array.prototype.slice.call(document.querySelectorAll('.nd-suggestion-result__group'))
          var item = null
          for (var i = 0; i < groups.length; i++) {
            var first = groups[i].querySelector('.nd-suggestion-item')
            if (!first) continue
            if (!item) item = first
            var label = norm((groups[i].querySelector('.nd-suggestion-search__label') || {}).textContent)
            if (label === '目的地') { item = first; break }
          }
          if (!item) item = document.querySelector('.nd-suggestion-item')
          if (item) { var label2 = norm(item.textContent).slice(0, 40); item.click(); log.push('picked:' + label2); return resolve({ ok: true, picked: label2 }) }
          if (Date.now() > deadline) return resolve({ ok: false, step: 'suggestion', log: log })
          setTimeout(tryPick, 400)
        })()
      })
    }).then(function (pick) {
      if (!pick.ok) return pick
      return sleep(1500).then(function () {
        var btn = document.querySelector('button[name="search"]') || document.querySelector('.hotel-search__search-button')
        if (!btn) return { ok: false, step: 'search-button', picked: pick.picked, log: log }
        btn.click(); log.push('search-clicked')
        var tries = 0
        return new Promise(function (resolve) {
          (function waitList() {
            if (/\/hotel\/list/.test(location.pathname)) return resolve({ ok: true, picked: pick.picked, url: location.href, log: log })
            if (++tries > 40) return resolve({ ok: false, step: 'navigation', url: location.href, log: log })
            setTimeout(waitList, 500)
          })()
        })
      })
    })
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
  // 页面派发新票据时重取(2026-09-11,hotel-be 侧 C16 落地配套):
  // portal 的票据是**异步**取回的(fetch bridgeTicket),通常晚于 DOMContentLoaded,
  // 上面那次一次性读取会错过;hotel-be 每次写入/刷新 window.__gotryJoinTicket 都会
  // 在 window 上派发该事件 → 这里重取一次即可(不需要轮询,也不引入任何配置面)。
  window.addEventListener('gotry-join-ticket-available', dispatchJoinTicket)
  window.addEventListener('gotry-portal-login-available', dispatchPortalLogin)

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', function () { sendPage(); dispatchJoinTicket(); dispatchPortalLogin() }, { once: true })
  } else {
    sendPage()
    dispatchJoinTicket()
    dispatchPortalLogin()
  }
})()