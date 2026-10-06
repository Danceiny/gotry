// Shared by the npm CLI and gotry_doctor. Disk presence proves installation,
// while only a fresh, trusted-origin heartbeat on the existing bridge proves
// connection. This diagnostic never starts a bridge or sends a heartbeat.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { get } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

const IDS = ['oeajpiccmonococjcegddlooeeohlbgd', 'olpgkofjhhiiiahdkkbcninhjmegghfe']
const PORTS = [8791, 8792, 8793, 8794, 8795]
const STORE_URL = `https://chromewebstore.google.com/detail/gotry-session-bridge/${IDS[0]}`

function json(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}
function directories(path) {
  try { return readdirSync(path, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name) } catch { return [] }
}

function browserRoots(home, platform, env) {
  if (platform === 'darwin') {
    const base = join(home, 'Library', 'Application Support')
    return ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Canary', 'Chromium', 'Microsoft Edge', 'BraveSoftware/Brave-Browser'].map(path => join(base, path))
  }
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    return ['Google/Chrome/User Data', 'Google/Chrome Beta/User Data', 'Google/Chrome SxS/User Data', 'Chromium/User Data', 'Microsoft/Edge/User Data', 'BraveSoftware/Brave-Browser/User Data'].map(path => join(base, path))
  }
  const base = env.XDG_CONFIG_HOME || join(home, '.config')
  return ['google-chrome', 'google-chrome-beta', 'google-chrome-unstable', 'chromium', 'microsoft-edge', 'BraveSoftware/Brave-Browser'].map(path => join(base, path))
}

function installedProfiles(home, platform, env) {
  const found = []
  for (const root of browserRoots(home, platform, env)) {
    for (const name of directories(root)) {
      const profile = join(root, name)
      const matches = IDS.filter(id => directories(join(profile, 'Extensions', id)).some(version => {
        const manifest = json(join(profile, 'Extensions', id, version, 'manifest.json'))
        return manifest?.manifest_version === 3 && typeof manifest.version === 'string'
      }))
      if (!matches.length) continue
      const secure = json(join(profile, 'Secure Preferences'))?.extensions?.settings
      const preferences = json(join(profile, 'Preferences'))?.extensions?.settings
      for (const id of matches) {
        const settings = secure?.[id] ?? preferences?.[id]
        // Uninstall/update may leave version directories behind. Require the
        // browser's current registration as well as its on-disk manifest.
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) continue
        const disabled = (typeof settings?.state === 'number' && settings.state !== 1)
          || (Array.isArray(settings?.disable_reasons) && settings.disable_reasons.length > 0)
        found.push({ profile, disabled })
      }
    }
  }
  return found
}

function bridgeStatus(port, timeoutMs) {
  return new Promise(resolve => {
    let done = false
    const finish = value => { if (!done) { done = true; clearTimeout(timer); resolve(value) } }
    const req = get({ hostname: '127.0.0.1', port, path: '/status' }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => {
        body += chunk
        if (body.length > 16_384) { finish(null); req.destroy() }
      })
      res.on('error', () => finish(null))
      res.on('end', () => {
        try {
          const status = JSON.parse(body)
          if (res.statusCode !== 200 || status.ok !== true || status.protocol !== 'session-bridge.v1'
              || typeof status.extensionConnected !== 'boolean') { finish(null); return }
          finish({ port, connected: status.extensionConnected === true
            && Number.isFinite(status.lastSeenMsAgo) && status.lastSeenMsAgo >= 0 && status.lastSeenMsAgo < 45_000 })
        } catch { finish(null) }
      })
    })
    const timer = setTimeout(() => { finish(null); req.destroy() }, timeoutMs)
    req.on('error', () => finish(null))
  })
}

export async function checkExtensionStatus(opts = {}) {
  const home = opts.homeDir ?? homedir()
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const bridges = await Promise.all((opts.ports ?? PORTS).map(port => bridgeStatus(port, opts.timeoutMs ?? 400)))
  const connected = bridges.find(status => status?.connected)
  if (connected) return {
    status: 'ok', detail: `已连接（本机桥端口 ${connected.port}，近期扩展心跳已确认）`,
  }
  const profiles = installedProfiles(home, platform, env)
  if (profiles.length) {
    const enabled = profiles.find(profile => !profile.disabled)
    return {
      status: 'degraded',
      detail: enabled ? `已安装（浏览器配置：${enabled.profile}）；当前连接未确认，离线安装检查不代表会话检索已就绪`
        : `已安装，但已停用（浏览器配置：${profiles[0].profile}）；当前连接未确认`,
      fix: '打开安装扩展的浏览器，在 chrome://extensions 启用 Stai Travel Bridge；启动 `npx @danceiny/gotry web`，在对话中发起账号会话检索并按提示授权以启动连接；保持会话运行时重跑 doctor，检索以 gotry_session_search 的结果为准',
    }
  }
  if (existsSync(join(home, '.gotry', 'extension', 'manifest.json'))) return {
    status: 'degraded', detail: '本地扩展文件已就位，浏览器加载及当前连接未确认',
    fix: '推荐从商店安装：' + STORE_URL + '；或在 chrome://extensions 加载 ~/.gotry/extension；启动 `npx @danceiny/gotry web`，在对话中发起账号会话检索并按提示授权以启动连接',
  }
  return {
    status: 'degraded', detail: '未检测到浏览器安装记录，当前连接未确认（浏览器可能使用其他配置目录）；无法仅凭文件判断安装状态。影响面：账号会话检索需扩展在线，机票 FlyAI、酒店 hbcli、地图、天气等其它工具不受影响',
    fix: '已安装时：打开对应浏览器，在 chrome://extensions 确认已启用；启动 `npx @danceiny/gotry web`，在对话中发起账号会话检索并按提示授权以启动连接；保持会话运行时复检。首次安装：' + STORE_URL,
  }
}
