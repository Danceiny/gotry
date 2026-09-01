#!/usr/bin/env node
/**
 * gotry CLI 入口(v0.0.1-rc.2 起;rc.6 起支持 npm 安装运行):
 *   gotry web                          # dsh Web 浏览器界面(:3080)
 *   gotry "I want 2 days in Phuket"    # headless one-shot
 *   gotry help                         # help
 *
 * 工作流程:
 *   1. 解析 argv + .env(provider-neutral → DEEPSEEK_API_KEY/DEEPSEEK_BASE_URL)
 *   2. 定位 dsh runtime:
 *      a. repo checkout → vendored ts/dsh-runtime/node_modules/...
 *      b. npm 安装     → createRequire 解析依赖 @deepseek-ai/dsh(不走 npx:
 *         dsh cordis-loader 在子 cwd 求值 plugin name,必须绝对路径 patch)
 *   3. 运行时生成 patch(os.tmpdir):把 gotry-tools 插件路径重写为按本包
 *      位置解析的绝对路径 —— 仓内 cordis.gotry-patch.yml 里的 name 行只是
 *      占位(本机绝对路径),随 tarball 分发后对其他机器必错。
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
// base 同点映射(issue #48):dsh 侧 llm-deepseek 读 DEEPSEEK_BASE_URL 并拼
// `${base}/chat/completions`(与 ts/src/dsh-llm.ts 同语义,自定义端点一般含 /v1);
// 只映射 key 不映射 base 时,OpenAI 兼容 key 会被发往 DeepSeek 官方端点必然 401。
if (process.env.LLM_BASE_URL && !process.env.DEEPSEEK_BASE_URL) {
  process.env.DEEPSEEK_BASE_URL = process.env.LLM_BASE_URL
}
// model 映射(issue #77):LLM_MODEL 显式存在时让它真正驱动 dsh 会话面——
// ① 这里映射为 GOTRY_LLM_MODEL 传给 gotry-tools 插件,在 agent/request 瀑布做
//    内存覆盖(dsh settings 用户层 ~/.dsh 压过 composition 层,单靠 patch 不够;
//    覆盖零持久化,进程退即散,不改写用户设置);
// ② 下方运行时 patch 追加两条 by-id 覆盖:agent-default-model 默认模型 +
//    llm-deepseek 目录条目(web UI 模型页可见、元数据可记账)。
// 不设 LLM_MODEL 则两条都不动——默认路径(组合配置或用户 web 设置)面不变。
if (process.env.LLM_MODEL && !process.env.GOTRY_LLM_MODEL) {
  process.env.GOTRY_LLM_MODEL = process.env.LLM_MODEL
}

// --- argv 解析 ---
const args = process.argv.slice(2)
const help = args.length === 0 || args[0] === '-h' || args[0] === '--help' || args[0] === 'help'

if (help) {
  console.log(`GoTry — dsh-driven AI travel agent

Usage:
  gotry web                          # dsh Web UI on http://127.0.0.1:3080
  gotry setup                        # 安装可选外部依赖(hbcli 官方脚本 / agent-reach pip;装时已自动跑过)
  gotry "一段完整任务..."            # headless 一问一答
  gotry help                         # this help

Prerequisites:
  • Node 22+
  • \`.env\` 里 LLM_API_KEY (DeepSeek / OpenAI 兼容均可;自定义端点另配 LLM_BASE_URL,一般以 /v1 结尾;指定模型另配 LLM_MODEL,同时驱动 dsh 会话面与仓内脚本)

Detail: https://github.com/Danceiny/gotry — README
`)
  process.exit(0)
}

// mode 决定路径: 'web'/'setup'/'help' 是字面命令;否则第一段 args[0] 是任务本身的一部分
const literal = new Set(['web', 'setup', 'help', '-h', '--help'])
const isLiteral = literal.has(args[0])
const mode = isLiteral ? args[0] : 'headless'
const rest = isLiteral ? args.slice(1) : args

// setup:外部依赖自举(hbcli/agent-reach),不需要 dsh runtime 与 LLM key,同步分发后即退
if (mode === 'setup') {
  const r = spawnSync(process.execPath, [join(here, 'gotry-bootstrap.js'), ...rest], { stdio: 'inherit' })
  process.exit(r.status ?? (r.error ? 1 : 0))
}

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
// 安装包始终指向 dist/ 纯 JS(Node 拒绝 strip node_modules 下的 .ts)。
// repo 检出仅在 vendored runtime 或显式 tsx loader 可用时走 .ts；否则
// 使用当前 worktree 已构建的 dist，避免 Node strip-only 拒绝参数属性语法。
const distEntry = join(repoRoot, 'dist/src/index.js')
const tsEntry = join(repoRoot, 'ts/src/index.ts')
const installedPackageMode = !existsSync(join(repoRoot, '.git'))
const tsxLoaderActive = /(?:^|\s)--(?:import|loader)(?:=|\s)(?:"[^"]*tsx[^"]*"|'[^']*tsx[^']*'|\S*tsx\S*)/.test(process.env.NODE_OPTIONS ?? '')
const sourceTypeScriptMode = !installedPackageMode && (existsSync(vendoredDsh) || tsxLoaderActive)
const pluginEntry = !sourceTypeScriptMode && existsSync(distEntry) ? distEntry : tsEntry
const distModuleMode = pluginEntry === distEntry
const staticPatch = join(repoRoot, 'cordis.gotry-patch.yml')
if (!existsSync(staticPatch)) {
  console.error(`[gotry] 找不到 patch 配置: ${staticPatch}`)
  process.exit(1)
}
if (!existsSync(pluginEntry)) {
  console.error(`[gotry] 找不到插件入口: ${pluginEntry}(包不完整?)`)
  process.exit(1)
}

// Benchmark mode projects the patch before any optional host plugin is
// resolved/imported. Non-GoTry (including unknown/future) insert entries are
// safely discarded; a missing/duplicate gotry-tools entry fails closed.
function projectBenchmarkPatch(raw, entryPath, configPath) {
  const lines = raw.split('\n')
  const rootInsertKey = /(?:^|[,{}]\s*)(?:insert|'insert'|"insert")\s*:/
  const rootInsertLines = lines
    .map((line, index) => {
      const rootItem = line.match(/^-\s+(.*)$/)?.[1]?.trim()
      const directProperty = line.match(/^ {2}(.*)$/)?.[1]?.trim()
      return rootInsertKey.test(rootItem ?? '') || /^(?:insert|'insert'|"insert")\s*:/.test(directProperty ?? '') ? index : -1
    })
    .filter(index => index >= 0)
  const canonicalInsertStarts = lines
    .map((line, index) => /^- insert:\s*(?:#.*)?$/.test(line) ? index : -1)
    .filter(index => index >= 0)
  if (rootInsertLines.length !== 1 || canonicalInsertStarts.length !== 1 || rootInsertLines[0] !== canonicalInsertStarts[0]) {
    throw new Error('benchmark insert block violation')
  }
  const start = canonicalInsertStarts[0]
  let end = start + 1
  while (end < lines.length) {
    const line = lines[end]
    if (line.trim() !== '' && !/^\s/.test(line) && !line.trim().startsWith('#')) break
    end += 1
  }
  const body = lines.slice(start + 1, end)
  const firstItem = body.find(line => line.trim() !== '' && !line.trim().startsWith('#'))
  const firstItemMatch = firstItem?.match(/^(\s*)-\s+/)
  if (!firstItemMatch) throw new Error('invalid insert sequence')
  const itemIndent = firstItemMatch[1].length
  const itemStarts = []
  for (let index = 0; index < body.length; index += 1) {
    const line = body[index]
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const indent = line.match(/^\s*/)?.[0].length ?? 0
    if (indent < itemIndent || (indent === itemIndent && !/^\s*-\s+/.test(line))) {
      throw new Error('invalid insert sequence')
    }
    if (indent === itemIndent) itemStarts.push(index)
  }
  if (itemStarts.length === 0) throw new Error('empty insert sequence')

  const parseId = value => {
    const quoted = value.trim().match(/^(['"])([A-Za-z0-9._-]+)\1(?:\s+#.*)?$/)
    if (quoted) return quoted[2]
    return value.trim().match(/^([A-Za-z0-9._-]+)(?:\s+#.*)?$/)?.[1] ?? null
  }
  const itemId = item => {
    const header = item[0].slice(itemIndent + 2).trim()
    const canonical = header.match(/^id:\s*(.+)$/)
    if (canonical) return parseId(canonical[1])
    if (header.startsWith('{')) {
      const inline = header.match(/(?:^\{\s*|,\s*)id\s*:\s*(['"]?)([A-Za-z0-9._-]+)\1(?=\s*[,}])/)
      if (inline) return inline[2]
    }
    const propertyIndent = ' '.repeat(itemIndent + 2)
    const directIds = item.slice(1)
      .map(line => line.startsWith(`${propertyIndent}id:`) ? parseId(line.slice(propertyIndent.length + 3)) : null)
      .filter(Boolean)
    if (directIds.length > 1) throw new Error('duplicate insert id')
    return directIds[0] ?? null
  }
  const items = itemStarts.map((itemStart, index) => body.slice(itemStart, itemStarts[index + 1] ?? body.length))
  const gotryItems = items.filter(item => itemId(item) === 'gotry-tools')
  if (gotryItems.length !== 1) throw new Error('benchmark insert allowlist violation')
  let gotry = gotryItems[0].join('\n')
  gotry = rewriteBenchmarkPluginEntry(gotry, entryPath)
  gotry = injectBenchmarkEnvironmentConfig(gotry, configPath)
  return [...lines.slice(0, start + 1), ...gotry.split('\n'), ...lines.slice(end)].join('\n')
}

function rewriteBenchmarkPluginEntry(raw, entryPath) {
  const itemIndent = raw.match(/^(\s*)-\s+/)?.[1].length
  if (itemIndent === undefined) throw new Error('benchmark plugin item unavailable')
  const propertyIndent = ' '.repeat(itemIndent + 2)
  const anchorPattern = new RegExp(`^(${propertyIndent}name:\\s*)'[^'\\r\\n]*ts\\/src\\/index\\.ts'(\\s*(?:#.*)?)$`, 'gm')
  const anchors = [...raw.matchAll(anchorPattern)]
  if (anchors.length !== 1 || anchors[0].index === undefined) throw new Error('benchmark plugin anchor unavailable')
  const anchor = anchors[0]
  const escapedEntry = entryPath.replace(/'/g, "''")
  const replacement = `${anchor[1]}'${escapedEntry}'${anchor[2]}`
  const rewritten = `${raw.slice(0, anchor.index)}${replacement}${raw.slice(anchor.index + anchor[0].length)}`
  if (!rewritten.includes(replacement)) throw new Error('benchmark plugin rewrite unavailable')
  return rewritten
}

function injectBenchmarkEnvironmentConfig(raw, configPath) {
  const itemIndent = raw.match(/^(\s*)-\s+/)?.[1].length
  if (itemIndent === undefined) throw new Error('benchmark config item unavailable')
  const propertyIndent = ' '.repeat(itemIndent + 2)
  const configIndent = ' '.repeat(itemIndent + 4)
  const configAnchors = raw.match(new RegExp(`^${propertyIndent}config:\\s*(?:#.*)?$`, 'gm')) ?? []
  if (configAnchors.length !== 1) throw new Error('benchmark config block unavailable')
  if ((raw.match(new RegExp(`^${configIndent}benchmarkEnvironmentConfigPath\\s*:`, 'gm')) ?? []).length !== 0) {
    throw new Error('duplicate benchmark config path')
  }
  const anchorPattern = new RegExp(`^(${configIndent})hbcliBin:\\s*'[^'\\r\\n]*'\\s*(?:#.*)?$`, 'gm')
  const anchors = [...raw.matchAll(anchorPattern)]
  if (anchors.length !== 1 || anchors[0].index === undefined) throw new Error('benchmark config anchor unavailable')
  const anchor = anchors[0]
  const escapedPath = configPath.replace(/'/g, "''")
  const insertAt = anchor.index + anchor[0].length
  const injected = `${raw.slice(0, insertAt)}\n${anchor[1]}benchmarkEnvironmentConfigPath: '${escapedPath}'${raw.slice(insertAt)}`
  if ((injected.match(new RegExp(`^${configIndent}benchmarkEnvironmentConfigPath\\s*:`, 'gm')) ?? []).length !== 1) {
    throw new Error('benchmark config injection unavailable')
  }
  return injected
}

const benchmarkEnvironmentConfig = process.env.GOTRY_BENCHMARK_ENV_CONFIG
let benchmarkTerminalConfig = null
let benchmarkPatchProjection = null
if (benchmarkEnvironmentConfig !== undefined && benchmarkEnvironmentConfig !== '') {
  let validBenchmarkEnvironmentConfig = false
  try {
    const bridgeModule = distModuleMode && existsSync(join(repoRoot, 'dist/src/benchmark-environment-bridge.js'))
      ? join(repoRoot, 'dist/src/benchmark-environment-bridge.js')
      : join(repoRoot, 'ts/src/benchmark-environment-bridge.ts')
    const { loadBenchmarkEnvironmentConfig } = await import(pathToFileURL(bridgeModule).href)
    const loadedConfig = benchmarkEnvironmentConfig.length > 0
      && benchmarkEnvironmentConfig.length <= 4096
      && !benchmarkEnvironmentConfig.includes('\0')
      && !benchmarkEnvironmentConfig.includes('\r')
      && !benchmarkEnvironmentConfig.includes('\n')
      ? loadBenchmarkEnvironmentConfig(benchmarkEnvironmentConfig)
      : null
    validBenchmarkEnvironmentConfig = loadedConfig !== null
    benchmarkTerminalConfig = loadedConfig?.terminal_output ?? null
    if (validBenchmarkEnvironmentConfig) {
      benchmarkPatchProjection = projectBenchmarkPatch(readFileSync(staticPatch, 'utf-8'), pluginEntry, benchmarkEnvironmentConfig)
    }
  } catch { validBenchmarkEnvironmentConfig = false }
  if (!validBenchmarkEnvironmentConfig) {
    console.error('[gotry] benchmark environment configuration unavailable')
    process.exit(1)
  }
}
if (benchmarkEnvironmentConfig && mode !== 'headless') {
  console.error('[gotry] benchmark environment requires headless mode')
  process.exit(1)
}
// dsh-map-tools 宿主插件(地图/路线/POI,零 key 走 OSM/OSRM):repo 用 vendored,
// npm 用依赖解析;都找不到就整块剔除 patch 条目(缺地图不挡旅行规划)
let mapEntry = ''
if (!benchmarkEnvironmentConfig) {
  const vendoredMap = join(repoRoot, 'ts/dsh-runtime/node_modules/dsh-map-tools/lib/index.js')
  if (existsSync(vendoredMap)) {
    mapEntry = vendoredMap
  } else {
    // npm 布局:子路径可能被 exports 挡(resolve 抛错不能留下旧值),裸包名返回真实入口
    try { mapEntry = require_.resolve('dsh-map-tools/lib/index.js') } catch { mapEntry = '' }
    if (!mapEntry) { try { mapEntry = require_.resolve('dsh-map-tools') } catch { mapEntry = '' } }
  }
}
// 结构化澄清卡(T2):ask_user_question 工具 + user-questions 服务,从 dsh 包
// 上下文解析(pnpm 嵌套布局下只有 dsh 自己看得见这些依赖);失败整块剔除
// 澄清卡注入(T2):web 用 dsh 原生卡片;headless+TTY 用 gotry 的 stdio 提供方
// (终端渲染选择题);headless 非 TTY(CI/管道)不注入——工具收到 NO_PROVIDER
// 错误,人格契约 (5) 退化文本。GOTRY_ASK_STDIO=1 强制启用(测试/外接答复)。
const stdioAsk = mode === 'headless' && (process.stdin.isTTY || process.env.GOTRY_ASK_STDIO === '1')
  ? join(here, 'gotry-stdio-ask.js') : ''
let askUserInsert = ''
if (!benchmarkEnvironmentConfig && (mode === 'web' || stdioAsk)) try {
  const reqFromDsh = createRequire(dshBin)
  // 裸包名解析(这些包的 exports 不暴露 ./lib/index.js 子路径,但裸名返回真实入口)
  // userQuestions 服务默认树已注册(重复插入会崩),只插工具消费者
  const at = reqFromDsh.resolve('@deepseek-ai/dsh-tool-ask-user')
  askUserInsert = (stdioAsk ? `    - id: gotry-stdio-ask\n      name: '${stdioAsk}'\n` : '')
    + `    - id: dsh-tool-ask-user\n      name: '${at}'`
} catch { /* 缺件不挡启动 */ }

const unboundPatch = benchmarkPatchProjection ?? readFileSync(staticPatch, 'utf-8')
let patchRaw = benchmarkPatchProjection ?? unboundPatch.replace(/(name:\s*)'[^']*ts\/src\/index\.ts'/, `$1'${pluginEntry}'`)
patchRaw = patchRaw.replace(/^\s*# \{ask-user-insert\}.*\n(\s*# .*\n)?/m, askUserInsert ? askUserInsert + '\n' : '')

// Owner-local benchmark environment opt-in. Keep the path out of tool input
// and logs; it is only injected into the local plugin config as YAML data.
if (mapEntry) {
  patchRaw = patchRaw.replace(/(name:\s*)'placeholder\/dsh-map-tools'/, `$1'${mapEntry}'`)
} else {
  patchRaw = patchRaw.replace(/\n\s*- id: dsh-map-tools\n\s*name: 'placeholder\/dsh-map-tools'\n/, '\n')
}

// dsh-calendar 宿主插件(CalDAV 工作窗口读取;未配置时工具报错降级,不挡启动)
let calEntry = ''
if (!benchmarkEnvironmentConfig) {
  const vendoredCal = join(repoRoot, 'ts/dsh-runtime/node_modules/dsh-calendar/lib/index.js')
  if (existsSync(vendoredCal)) {
    calEntry = vendoredCal
  } else {
    try { calEntry = require_.resolve('dsh-calendar/lib/index.js') } catch { calEntry = '' }
    if (!calEntry) { try { calEntry = require_.resolve('dsh-calendar') } catch { calEntry = '' } }
  }
}
if (calEntry) {
  patchRaw = patchRaw.replace(/(name:\s*)'placeholder\/dsh-calendar'/, `$1'${calEntry}'`)
} else {
  patchRaw = patchRaw.replace(/\n\s*- id: dsh-calendar\n\s*name: 'placeholder\/dsh-calendar'\n/, '\n')
}

// LLM_MODEL 指定模型(issue #77)②:composition 层 by-id 覆盖。cordis patch 语义
// (dsh-app-boot applyEntryPatches):非 insert 的 {id, ...overrides} 对目标条目做浅层
// 键赋值,config 整体替换;id 不存在只 warn+skip 不崩(上游改名时优雅退化)。
// 两条目标在 headless/web profile 均有(dsh-base 声明 llm-deepseek、两 profile 均声明
// agent-default-model)。llm-deepseek 目录整体替换为单条目:显式指定模型的场景多为
// 中转/兼容端点,默认 v4-* 目录对其是误导;不硬编码上游 DEFAULT_MODELS 防漂移。
if (process.env.GOTRY_LLM_MODEL) {
  const modelYaml = `'${process.env.GOTRY_LLM_MODEL.replace(/'/g, "''")}'`
  patchRaw += `\n# LLM_MODEL 指定模型(issue #77):dsh 会话面默认模型 + 模型目录\n- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: ${modelYaml}\n- id: llm-deepseek\n  config:\n    models:\n      - id: ${modelYaml}\n        name: ${modelYaml}\n`
}
// Keep the patch private and short-lived. mkdtempSync creates a 0700 directory;
// wx prevents accidental reuse/races if a process is started concurrently.
const patchDir = mkdtempSync(join(tmpdir(), 'gotry-cordis-'))
const patchPath = join(patchDir, 'patch.yml')
writeFileSync(patchPath, patchRaw, { mode: 0o600, flag: 'wx' })
const headlessKeepalivePath = join(patchDir, 'headless-keepalive.cjs')
if (mode === 'headless') {
  writeFileSync(headlessKeepalivePath, `
const hold = setInterval(() => {
  if (process.exitCode !== undefined) clearInterval(hold)
}, 50)
`, { mode: 0o600, flag: 'wx' })
}
let patchCleaned = false
const cleanupPatch = () => {
  if (patchCleaned) return
  patchCleaned = true
  rmSync(patchDir, { recursive: true, force: true })
}
process.once('exit', cleanupPatch)
let child = null
const terminateOnSignal = (signal, listener) => {
  cleanupPatch()
  if (child && !child.killed) child.kill(signal)
  process.off(signal, listener)
  process.kill(process.pid, signal)
}
const onSigint = () => terminateOnSignal('SIGINT', onSigint)
const onSigterm = () => terminateOnSignal('SIGTERM', onSigterm)
process.once('SIGINT', onSigint)
process.once('SIGTERM', onSigterm)
if (!process.env.DEEPSEEK_API_KEY && mode !== 'help') {
  console.error('[gotry] 缺少 LLM API key —— 两种方式任选其一后重跑:')
  console.error(`  1) 在当前目录创建 .env 写入一行: LLM_API_KEY=<你的 DeepSeek key>(key 从 https://platform.deepseek.com 获取)`)
  console.error('  2) 或临时环境变量: export LLM_API_KEY=<key>')
  cleanupPatch()
  process.exit(1)
}

// --- 调 vendored dsh 二进制(不走 npx)---
// headless: 第一个非 -- 之后的参数是 task —— gotry argv 0 是 headless 触发,其余都算 task;
const binJs = mode === 'web'
  ? ['web', '--patch', patchPath, ...(process.argv.includes('--no-open') ? ['--no-open'] : [])]
  : ['--profile', 'headless', '--patch', patchPath, ...rest]

const childEnv = { ...process.env }
if (mode === 'headless') {
  childEnv.NODE_OPTIONS = [childEnv.NODE_OPTIONS, `--require=${headlessKeepalivePath}`].filter(Boolean).join(' ')
}
// The benchmark config is parent-only metadata. Never make its path visible to
// dsh or any plugin loaded by the child.
delete childEnv.GOTRY_BENCHMARK_ENV_CONFIG
if (benchmarkEnvironmentConfig) {
  for (const key of [
    'GOTRY_BENCHMARK_BRIDGE_PARENT_SECRET',
    'DATABASE_URL',
    'SSH_AUTH_SOCK',
    'AWS_PROFILE',
    'HTTPS_PROXY',
  ]) delete childEnv[key]
}
const benchmarkStdout = benchmarkEnvironmentConfig ? [] : null
const childStdio = mode === 'web'
  ? 'inherit'
  : benchmarkStdout
    ? ['pipe', 'pipe', 'pipe']
    : process.stdin.isTTY
      ? 'inherit'
      : ['pipe', 'inherit', 'inherit']
let benchmarkCapturedBytes = 0
let benchmarkOutputTruncated = false
child = spawn(process.execPath, [dshBin, ...binJs], {
  stdio: childStdio,
  env: childEnv,
  cwd: dshCwd,
})
if (benchmarkStdout) {
  const maxBytes = Math.max(1, Number(benchmarkTerminalConfig?.max_bytes ?? 1))
  child.stdout?.on('data', chunk => {
    if (benchmarkCapturedBytes + Buffer.byteLength(chunk) > maxBytes) benchmarkOutputTruncated = true
    if (benchmarkCapturedBytes < maxBytes) {
      const bytes = Buffer.from(chunk)
      benchmarkStdout.push(bytes.subarray(0, Math.max(0, maxBytes - benchmarkCapturedBytes)))
      benchmarkCapturedBytes += Math.min(bytes.length, maxBytes - benchmarkCapturedBytes)
    }
  })
  child.stderr?.resume()
}
if (process.env.GOTRY_DEBUG) {
  if (benchmarkEnvironmentConfig) {
    console.error('[gotry-debug] benchmark headless child configured(details redacted)')
  } else {
    console.error('[gotry-debug] exec:', process.execPath, dshBin)
    console.error('[gotry-debug] argv:', binJs)
    console.error('[gotry-debug] cwd:', dshCwd)
    console.error('[gotry-debug] patch exists:', existsSync(patchPath), patchPath)
  }
}
child.on('close', (code, signal) => {
  cleanupPatch()
  if (benchmarkStdout) {
    const captured = Buffer.concat(benchmarkStdout).toString('utf8')
    if (code !== 0 || signal || benchmarkOutputTruncated) {
      console.error('[gotry] benchmark terminal output unavailable')
      process.exit(1)
    }
    const parserModule = distModuleMode && existsSync(join(repoRoot, 'dist/src/benchmark-agent-conformance.js'))
      ? join(repoRoot, 'dist/src/benchmark-agent-conformance.js')
      : join(repoRoot, 'ts/src/benchmark-agent-conformance.ts')
    import(pathToFileURL(parserModule).href).then(async ({ parseBenchmarkTerminal }) => {
      const parsed = parseBenchmarkTerminal(captured, benchmarkTerminalConfig)
      if (!parsed || parsed.ok !== true) {
        console.error('[gotry] benchmark terminal output unavailable')
        process.exitCode = 1
        return
      }
      await new Promise((resolve, reject) => {
        const onError = error => {
          process.stdout.off('error', onError)
          reject(error)
        }
        process.stdout.once('error', onError)
        process.stdout.write(captured, () => {
          process.stdout.off('error', onError)
          resolve()
        })
      })
      process.exitCode = 0
    }).catch(() => {
      console.error('[gotry] benchmark terminal output unavailable')
      process.exitCode = 1
    })
    return
  }
  if (code !== 0 || signal) {
    // D-NEW 护栏:dsh 异常退出也写一条 incident,留现场而非沉默
    // dist 模式 import JS(node_modules 下的 .ts 会被 Node 拒 strip)
    const incidentModule = distModuleMode && existsSync(join(repoRoot, 'dist/capabilities/incident-log.js'))
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
  cleanupPatch()
  console.error(`[gotry] dsh 启动失败: ${e.message}`)
  console.error('尝试: node -v 看 Node 版本(需 22+),或查看 ts/dsh-runtime/node_modules/。')
  process.exit(1)
})
