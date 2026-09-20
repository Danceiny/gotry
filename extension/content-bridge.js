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

  function dispatchJoinTicket() {
    try {
      var t = window.__gotryJoinTicket
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
    return false
  })

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