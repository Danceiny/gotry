#!/usr/bin/env node
/**
 * gotry CLI 入口(v0.0.1-rc.2 起;rc.6 起支持 npm 安装运行):
 *   gotry web                          # dsh Web 浏览器界面(:3080)
 *   gotry "I want 2 days in Phuket"    # headless one-shot
 *   gotry help                         # help
 *
 * 工作流程:
 *   1. 解析 argv + .env(provider-neutral → DEEPSEEK_API_KEY)
 *   2. 定位 dsh runtime:
 *      a. repo checkout → vendored ts/dsh-runtime/node_modules/...
 *      b. npm 安装     → createRequire 解析依赖 @deepseek-ai/dsh(不走 npx:
 *         dsh cordis-loader 在子 cwd 求值 plugin name,必须绝对路径 patch)
 *   3. 运行时生成 patch(os.tmpdir):把 gotry-tools 插件路径重写为按本包
 *      位置解析的绝对路径 —— 仓内 cordis.gotry-patch.yml 里的 name 行只是
 *      占位(本机绝对路径),随 tarball 分发后对其他机器必错。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const require_ = createRequire(import.meta.url)

// --- 环境 .env 加载(provider-neutral) ---
// npm 安装模式优先读用户当前目录的 .env(包目录内不该有凭证);repo 检出读仓根。
const vendoredDshEarly = existsSync(join(repoRoot, 'ts/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'))
const envCandidates = vendoredDshEarly
  ? [join(repoRoot, '.env')]
  : [join(process.cwd(), '.env'), join(repoRoot, '.env')]
const envLines = []
for (const p of envCandidates) {
  if (existsSync(p)) envLines.push(...readFileSync(p, 'utf-8').split('\n'))
}
for (const line of envLines) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i)
  if (!m || line.trim().startsWith('#')) continue
  const k = m[1]; const v = m[2].trim().replace(/^["']|["']$/g, '')
  if (process.env[k] === undefined) process.env[k] = v
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

// --- dsh runtime 定位:repo checkout(vendored)优先,npm 安装走依赖解析 ---
const vendoredDsh = join(repoRoot, 'ts/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js')
let dshBin = ''
let dshCwd = ''
if (existsSync(vendoredDsh)) {
  dshBin = vendoredDsh
  dshCwd = join(repoRoot, 'ts/dsh-runtime')
} else {
  try {
    dshBin = require_.resolve('@deepseek-ai/dsh/lib/bin.js')
    dshCwd = process.cwd() // npm 安装:gotry-state 落在用户调用目录
  } catch {
    dshBin = ''
  }
}

if (!dshBin) {
  console.error(`[gotry] 找不到 dsh runtime(既无 vendored ${vendoredDsh},依赖里也没有 @deepseek-ai/dsh)。`)
  console.error('repo checkout: cd ts/dsh-runtime && pnpm install;npm 安装: npm install(检查 node_modules)。')
  process.exit(1)
}

// --- 运行时 patch:插件路径按本包位置重写为绝对路径 ---
// npm 模式指向 dist/ 纯 JS(Node 拒绝 strip node_modules 下的 .ts);
// repo 检出指向 .ts 源码(vendored runtime 下天然可行)。
const distEntry = join(repoRoot, 'dist/src/index.js')
const tsEntry = join(repoRoot, 'ts/src/index.ts')
const npmMode = !existsSync(vendoredDsh)
const pluginEntry = npmMode && existsSync(distEntry) ? distEntry : tsEntry
const staticPatch = join(repoRoot, 'cordis.gotry-patch.yml')
if (!existsSync(staticPatch)) {
  console.error(`[gotry] 找不到 patch 配置: ${staticPatch}`)
  process.exit(1)
}
if (!existsSync(pluginEntry)) {
  console.error(`[gotry] 找不到插件入口: ${pluginEntry}(包不完整?)`)
  process.exit(1)
}
// dsh-map-tools 宿主插件(地图/路线/POI,零 key 走 OSM/OSRM):repo 用 vendored,
// npm 用依赖解析;都找不到就整块剔除 patch 条目(缺地图不挡旅行规划)
let mapEntry = ''
const vendoredMap = join(repoRoot, 'ts/dsh-runtime/node_modules/dsh-map-tools/lib/index.js')
if (existsSync(vendoredMap)) {
  mapEntry = vendoredMap
} else {
  // npm 布局:子路径可能被 exports 挡(resolve 抛错不能留下旧值),裸包名返回真实入口
  try { mapEntry = require_.resolve('dsh-map-tools/lib/index.js') } catch { mapEntry = '' }
  if (!mapEntry) { try { mapEntry = require_.resolve('dsh-map-tools') } catch { mapEntry = '' } }
}
// 结构化澄清卡(T2):ask_user_question 工具 + user-questions 服务,从 dsh 包
// 上下文解析(pnpm 嵌套布局下只有 dsh 自己看得见这些依赖);失败整块剔除
// 澄清卡注入(T2):web 用 dsh 原生卡片;headless+TTY 用 gotry 的 stdio 提供方
// (终端渲染选择题);headless 非 TTY(CI/管道)不注入——工具收到 NO_PROVIDER
// 错误,人格契约 (5) 退化文本。GOTRY_ASK_STDIO=1 强制启用(测试/外接答复)。
const stdioAsk = mode === 'headless' && (process.stdin.isTTY || process.env.GOTRY_ASK_STDIO === '1')
  ? join(here, 'gotry-stdio-ask.js') : ''
let askUserInsert = ''
if (mode === 'web' || stdioAsk) try {
  const reqFromDsh = createRequire(dshBin)
  // 裸包名解析(这些包的 exports 不暴露 ./lib/index.js 子路径,但裸名返回真实入口)
  // userQuestions 服务默认树已注册(重复插入会崩),只插工具消费者
  const at = reqFromDsh.resolve('@deepseek-ai/dsh-tool-ask-user')
  askUserInsert = (stdioAsk ? `    - id: gotry-stdio-ask\n      name: '${stdioAsk}'\n` : '')
    + `    - id: dsh-tool-ask-user\n      name: '${at}'`
} catch { /* 缺件不挡启动 */ }

let patchRaw = readFileSync(staticPatch, 'utf-8')
  .replace(/(name:\s*)'[^']*ts\/src\/index\.ts'/, `$1'${pluginEntry}'`)
  .replace(/^\s*# \{ask-user-insert\}.*\n(\s*# .*\n)?/m, askUserInsert ? askUserInsert + '\n' : '')
if (mapEntry) {
  patchRaw = patchRaw.replace(/(name:\s*)'placeholder\/dsh-map-tools'/, `$1'${mapEntry}'`)
} else {
  // 整块剔除(缺地图不挡旅行规划);对齐极简条目形状
  patchRaw = patchRaw.replace(/\n\s*- id: dsh-map-tools\n\s*name: 'placeholder\/dsh-map-tools'\n/, '\n')
}
const patchPath = join(tmpdir(), `cordis.gotry.${process.pid}.yml`)
writeFileSync(patchPath, patchRaw)
if (!process.env.DEEPSEEK_API_KEY && mode !== 'help') {
  console.error('[gotry] 缺少 LLM API key —— 两种方式任选其一后重跑:')
  console.error(`  1) 在当前目录创建 .env 写入一行: LLM_API_KEY=<你的 DeepSeek key>(key 从 https://platform.deepseek.com 获取)`)
  console.error('  2) 或临时环境变量: export LLM_API_KEY=<key>')
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
  cwd: dshCwd,
})
if (process.env.GOTRY_DEBUG) {
  console.error('[gotry-debug] exec:', process.execPath, dshBin)
  console.error('[gotry-debug] argv:', binJs)
  console.error('[gotry-debug] cwd:', dshCwd)
  console.error('[gotry-debug] patch exists:', existsSync(patchPath), patchPath)
}
child.on('exit', (code, signal) => {
  if (code !== 0 || signal) {
    // D-NEW 护栏:dsh 异常退出也写一条 incident,留现场而非沉默
    // npm 模式 import dist JS(node_modules 下的 .ts 会被 Node 拒 strip)
    const incidentModule = npmMode && existsSync(join(repoRoot, 'dist/capabilities/incident-log.js'))
      ? '../dist/capabilities/incident-log.js'
      : '../ts/capabilities/incident-log.ts'
    import(incidentModule).then(({ recordIncident }) => {
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
