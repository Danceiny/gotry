/**
 * GoTry Session Bridge — options 页(远程桥配置)。
 * 保存远程地址时按需申请该源的 host 权限(optional_host_permissions 运行时授权),
 * 令牌只进 chrome.storage.local,永不出本机。
 */
'use strict'

const $ = (id) => document.getElementById(id)

function show(msg, ok) {
  const el = $('msg')
  el.textContent = msg
  el.style.color = ok ? '#188038' : '#d93025'
}

chrome.storage.local.get('gotryRemoteBridge', (data) => {
  const v = data && data.gotryRemoteBridge
  if (v && typeof v.baseUrl === 'string') {
    $('baseUrl').value = v.baseUrl
    $('token').value = typeof v.token === 'string' ? v.token : ''
  }
})

$('save').addEventListener('click', async () => {
  const baseUrl = $('baseUrl').value.trim().replace(/\/+$/, '')
  const token = $('token').value.trim()
  if (!baseUrl) {
    await chrome.storage.local.remove('gotryRemoteBridge')
    show('已保存:同机 loopback 模式', true)
    return
  }
  let origin
  try {
    origin = new URL(baseUrl).origin
    if (!/^https?:$/.test(new URL(baseUrl).protocol)) throw new Error('bad protocol')
  } catch {
    show('桥地址不是合法 http(s) URL', false)
    return
  }
  // 远程源按需授权(optional_host_permissions);用户拒绝则不入库,避免静默失效
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => false)
  if (!granted) {
    show('未授予该源的访问权限,配置未保存', false)
    return
  }
  await chrome.storage.local.set({ gotryRemoteBridge: { baseUrl, token } })
  show(`已保存:远程桥 ${baseUrl}(扩展将在 5s 内重连)`, true)
})

$('clear').addEventListener('click', async () => {
  await chrome.storage.local.remove('gotryRemoteBridge')
  $('baseUrl').value = ''
  $('token').value = ''
  show('已清除:回到同机 loopback 模式', true)
})
