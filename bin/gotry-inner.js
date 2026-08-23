/**
 * gotry CLI 入口(v0.0.1-rc.2 起):
 *   gotry web                          # dsh Web 浏览器界面(:3080)
 *   gotry "I want 2 days in Phuket"    # headless one-shot
 *   gotry help                         # help
 *
 * 工作流程:
 *   1. 解析 argv + .env(provider-neutral → DEEPSEEK_API_KEY)
 *   2. spawn vendored dsh(`ts/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js`)
 *      —— 不是 npx。原因:corids patch 把 plugin 路径硬编码到仓库根。
 *   3. --patch 指向仓库根的 cordis.gotry-patch.yml
 *
 * 路线选择说明: 为什么不用 `npx dsh`?
 *   dsh 0.1.1-rc.2 的 cordis-loader 在子进程 cwd(~/.dsh/profiles/web/)求值 plugin name;
 *   而 patch name 用 './ts/src/index.ts' 或 '@gotry/plugin' 都会因为 cwd 不在仓库
 *   而失败。最稳的方案就是走 vendored runtime。要走 npx 一键启 dsh 需要 dsh 上游
 *   修 cordis 的 cwd 解析(或我们写一个 dsh-cwd-plugin);留到下个 tick。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

// --- 环境 .env 加载(provider-neutral) ---
const envPath = join(repoRoot, '.env')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i)
    if (!m || line.trim().startsWith('#')) continue
    const k = m[1]; const v = m[2].trim().replace(/^["']|["']$/g, '')
    if (process.env[k] === undefined) process.env[k] = v
  }
}
if (process.env.LLM_API_KEY && !process.env.DEEPSEEK_API_KEY) {
  process.env.DEEPSEEK_API_KEY = process.env.LLM_API_KEY
}

// --- argv 解析 ---
const args = process.argv.slice(2)
const help = args.length === 0 || args[0] === '-h' || args[0] === '--help' || args[0] === 'help'

if (help) {
  console.log(`GoTry — dsh-driven AI travel agent

Usage:
  gotry web                          # dsh Web UI on http://127.0.0.1:3080
  gotry "一段完整任务..."            # headless 一问一答
  gotry help                         # this help

Prerequisites:
  • Node 22+
  • \`.env\` 里 LLM_API_KEY (DeepSeek / OpenAI 兼容均可)

Detail: https://github.com/Danceiny/gotry — README
`)
  process.exit(0)
}

// mode 决定路径: 'web'/'help'/'help' 是字面命令;否则第一段 args[0] 是任务本身的一部分
const literal = new Set(['web', 'help', '-h', '--help'])
const isLiteral = literal.has(args[0])
const mode = isLiteral ? args[0] : 'headless'
const rest = isLiteral ? args.slice(1) : args

const patchPath = join(repoRoot, 'cordis.gotry-patch.yml')
const dshBin = join(repoRoot, 'ts/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js')

if (!existsSync(dshBin)) {
  console.error(`[gotry] 找不到 vendored dsh runtime: ${dshBin}`)
  console.error('请确认你 clone 了完整仓库(ts/dsh-runtime/ 应存在)。')
  console.error('或运行: cd ts/dsh-runtime && pnpm install')
  process.exit(1)
}
if (!existsSync(patchPath)) {
  console.error(`[gotry] 找不到 patch 配置: ${patchPath}`)
  console.error('请确认你在仓库根目录运行。')
  process.exit(1)
}
if (!process.env.DEEPSEEK_API_KEY && mode !== 'help') {
  console.error('[gotry] 需要 DEEPSEEK_API_KEY(或 LLM_API_KEY)— 检查 .env 或环境变量。')
  process.exit(1)
}

// --- 调 vendored dsh 二进制(不走 npx)---
// headless: 第一个非 -- 之后的参数是 task —— gotry argv 0 是 headless 触发,其余都算 task;
const binJs = mode === 'web'
  ? ['web', '--patch', patchPath, ...(process.argv.includes('--no-open') ? ['--no-open'] : [])]
  : ['--profile', 'headless', '--patch', patchPath, ...rest]

const child = spawn(process.execPath, [dshBin, ...binJs], {
  stdio: 'inherit',
  env: process.env,
  cwd: join(repoRoot, 'ts/dsh-runtime'),
})
if (process.env.GOTRY_DEBUG) {
  console.error('[gotry-debug] exec:', process.execPath, dshBin)
  console.error('[gotry-debug] argv:', binJs)
  console.error('[gotry-debug] cwd:', join(repoRoot, 'ts/dsh-runtime'))
  console.error('[gotry-debug] patch exists:', existsSync(patchPath), patchPath)
}
child.on('exit', (code, signal) => {
  if (code !== 0 || signal) {
    // D-NEW 护栏:dsh 异常退出也写一条 incident,留现场而非沉默
    import('../ts/capabilities/incident-log.ts').then(({ recordIncident }) => {
      recordIncident({
        ts: new Date().toISOString(),
        kind: 'plugin_error',
        message: `gotry spawn exit: ${mode} code=${code} signal=${signal}`,
        source: 'gotry-cli',
      }, repoRoot).catch(() => {})
    }).catch(() => {}) // module 找不到时静默
  }
  process.exit(code ?? 1)
})
child.on('error', (e) => {
  console.error(`[gotry] dsh 启动失败: ${e.message}`)
  console.error('尝试: node -v 看 Node 版本(需 22+),或查看 ts/dsh-runtime/node_modules/。')
  process.exit(1)
})
