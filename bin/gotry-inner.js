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
 *      a. repo checkout / npm 安装 → root package 解析锁定的 @deepseek-ai/dsh
 *      b. legacy vendored fallback 已按 D-27 移除(issue #120)——root 缺失即
 *         fail-closed 报错指重装,不再有「解析成功却跑不起来」的玄学形态
 *   3. 运行时生成 patch(os.tmpdir):把 gotry-tools 插件路径重写为按本包
 *      位置解析的绝对路径 —— 仓内 cordis.gotry-patch.yml 里的 name 行只是
 *      占位(本机绝对路径),随 tarball 分发后对其他机器必错。
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import {
  benchmarkRuntimeSupported,
  resolveDshPackage,
  selectDshCwd,
  selectDshRuntime,
  supportsNodeVersion,
} from './gotry-runtime-resolution.js'
import { onboardingSkipReason } from './gotry-bootstrap.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const sourceCheckoutMode = existsSync(join(repoRoot, '.git'))
const require_ = createRequire(import.meta.url)
const rootRequire = createRequire(join(repoRoot, 'package.json'))

// --- 环境 .env 加载(provider-neutral) ---
// npm 安装模式优先读用户当前目录的 .env(包目录内不该有凭证);repo 检出读仓根。
const sourceDshEarly = resolveDshPackage(rootRequire)
const envCandidates = sourceCheckoutMode || sourceDshEarly
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
    # (interactive TTY) 启动前若发现可自动安装的可选能力,问一次是否配置;
    # 确认复用 doctor --fix 幂等安装,拒绝立即继续。CI/非 TTY/全健康不弹问。
    # 跳过该问: --no-onboarding 或 GOTRY_ONBOARDING_SKIP=1
  gotry setup                        # 扩展就位检查/指引(商店一键装)
  gotry setup calendar               # 可选日历(CalDAV 工作窗口)挂载开关:默认关;--off 关闭;--status 查看
  gotry doctor                       # 可选依赖体检:扩展/agent-reach/hbcli/flyai/sidebar 状态 + 补装指引
  gotry doctor --fix                 # 体检 + 按报告补装(hbcli 官方脚本 / agent-reach pip / sidebar 插件)
  gotry "一段完整任务..."            # headless 一问一答
  gotry help                         # this help
  gotry --version                    # 版本号(bug 报告必填项)

Detail: https://github.com/Danceiny/gotry — README
`)
  process.exit(0)
}

// repoRoot 在 npm 安装与源码检出两种形态下都是包根,version 统一从这里取
if (args[0] === '-v' || args[0] === '--version') {
  console.log(JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')).version)
  process.exit(0)
}

// mode 决定路径: 'web'/'setup'/'doctor'/'help' 是字面命令;否则第一段 args[0] 是任务本身的一部分
const literal = new Set(['web', 'setup', 'doctor', 'help', '-h', '--help'])
const isLiteral = literal.has(args[0])
const mode = isLiteral ? args[0] : 'headless'
const rest = isLiteral ? args.slice(1) : args

// setup/doctor:外部依赖自举与体检,不需要 dsh runtime 与 LLM key,同步分发后即退
if (mode === 'setup' || mode === 'doctor') {
  const r = spawnSync(process.execPath, [join(here, 'gotry-bootstrap.js'), mode, ...rest], { stdio: 'inherit' })
  process.exit(r.status ?? (r.error ? 1 : 0))
}

const benchmarkEnvironmentConfig = process.env.GOTRY_BENCHMARK_ENV_CONFIG
if (!supportsNodeVersion(process.versions.node)) {
  console.error('[gotry] Node.js 22.15 or newer is required')
  process.exit(1)
}

// --- dsh runtime 定位(D-27 清偿,issue #120):仅 root manifest/依赖解析;legacy vendored 回退已移除 ---
const installedPackageMode = !sourceCheckoutMode
const selectedDsh = selectDshRuntime({
  repoRoot,
  rootResolver: rootRequire,
  benchmark: Boolean(benchmarkEnvironmentConfig),
})
let dshBin = selectedDsh?.bin ?? ''
const dshSource = selectedDsh?.source ?? ''
const dshCwd = selectedDsh
  ? selectDshCwd({
      repoRoot,
      invocationCwd: process.cwd(),
      sourceCheckoutMode,
      benchmark: Boolean(benchmarkEnvironmentConfig),
    })
  : ''

if (!dshBin) {
  if (benchmarkEnvironmentConfig) {
    console.error('[gotry] benchmark dsh runtime unavailable')
    process.exit(1)
  }
  console.error('[gotry] 找不到 dsh runtime(依赖里没有 @deepseek-ai/dsh;legacy vendored 回退已按 D-27 移除)。')
  console.error('repo checkout: npm ci && npm --prefix ts ci && node scripts/build-dist.mjs;npm 安装: npm install(检查 node_modules)。')
  process.exit(1)
}
if (benchmarkEnvironmentConfig && !benchmarkRuntimeSupported(selectedDsh)) {
  console.error('[gotry] benchmark dsh runtime unavailable')
  process.exit(1)
}

// --- 运行时 patch:插件路径按本包位置重写为绝对路径 ---
// 安装包始终指向 dist/ 纯 JS(Node 拒绝 strip node_modules 下的 .ts)。
// repo 检出仅在显式 tsx loader 可用时走 .ts；否则
// 使用当前 worktree 已构建的 dist，避免 Node strip-only 拒绝参数属性语法。
const distEntry = join(repoRoot, 'dist/src/index.js')
const tsEntry = join(repoRoot, 'ts/src/index.ts')
const tsxLoaderActive = /(?:^|\s)--(?:import|loader)(?:=|\s)(?:"[^"]*tsx[^"]*"|'[^']*tsx[^']*'|\S*tsx\S*)/.test(process.env.NODE_OPTIONS ?? '')
const sourceTypeScriptMode = !installedPackageMode && tsxLoaderActive
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
  const projected = [...lines.slice(0, start + 1), ...gotry.split('\n'), ...lines.slice(end)]
  return projectBenchmarkSystemPrompt(projected).join('\n')
}

// The normal persona contains dynamic variables and product-only tool
// instructions.  They are not meaningful in the minimal benchmark kernel and
// can make dsh fail while assembling the first request.  Require the exact
// source shape before replacing it; malformed or ambiguous prompt config must
// fail closed rather than being partially interpreted.
function projectBenchmarkSystemPrompt(lines) {
  const rootStarts = lines.map((line, index) => /^-\s+/.test(line) ? index : -1).filter(index => index >= 0)
  const rootItems = rootStarts.map((itemStart, index) => lines.slice(itemStart, rootStarts[index + 1] ?? lines.length))
  if (rootItems.length !== 2) throw new Error('benchmark system-prompt root shape violation')
  const insertItems = rootItems.filter(item => /^- insert:\s*(?:#.*)?$/.test(item[0]))
  const systemItems = rootItems.filter(item => /^- id:\s*system-prompt\s*(?:#.*)?$/.test(item[0]))
  if (insertItems.length !== 1 || systemItems.length !== 1) throw new Error('benchmark system-prompt canonical shape violation')
  const start = rootStarts[rootItems.indexOf(systemItems[0])]
  let end = start + 1
  while (end < lines.length && (lines[end].trim() === '' || /^\s/.test(lines[end]) || lines[end].trim().startsWith('#'))) end += 1
  const item = lines.slice(start, end)
  const configIndexes = item.map((line, index) => /^ {2}config:\s*$/.test(line) ? index : -1).filter(index => index >= 0)
  const personaIndexes = item.map((line, index) => /^ {4}persona:\s*>-\s*$/.test(line) ? index : -1).filter(index => index >= 0)
  if (configIndexes.length !== 1 || personaIndexes.length !== 1 || personaIndexes[0] <= configIndexes[0]) {
    throw new Error('benchmark system-prompt config violation')
  }
  const persona = personaIndexes[0]
  const blockEnd = item.slice(persona + 1).findIndex(line => line.trim() !== '' && !/^\s{6,}/.test(line))
  const contentEnd = blockEnd < 0 ? item.length : persona + 1 + blockEnd
  if (contentEnd === persona + 1 || item.slice(persona + 1, contentEnd).some(line => line.trim() !== '' && !/^\s{6,}/.test(line))) {
    throw new Error('benchmark system-prompt persona violation')
  }
  const before = item.slice(1, configIndexes[0]).filter(line => line.trim() !== '' && !line.trim().startsWith('#'))
  const between = item.slice(configIndexes[0] + 1, persona).filter(line => line.trim() !== '' && !line.trim().startsWith('#'))
  const after = item.slice(contentEnd).filter(line => line.trim() !== '' && !line.trim().startsWith('#'))
  if (before.length !== 0 || between.length !== 0 || after.length !== 0) throw new Error('benchmark system-prompt shape violation')
  const replacement = [
    '- id: system-prompt',
    '  config:',
    '    persona: >-',
    '      You are GoTry, a task-agnostic travel planning assistant.',
    '      Use only the current conversation and tools available in this benchmark session.',
  ]
  return [...lines.slice(0, start), ...replacement, ...lines.slice(end)]
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

let benchmarkTerminalConfig = null
let benchmarkPatchProjection = null
let benchmarkChildDiagnostics = null
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
if (benchmarkEnvironmentConfig) {
  try {
    const diagnosticModule = distModuleMode && existsSync(join(repoRoot, 'dist/src/benchmark-headless-child-diagnostics.js'))
      ? join(repoRoot, 'dist/src/benchmark-headless-child-diagnostics.js')
      : join(repoRoot, 'ts/src/benchmark-headless-child-diagnostics.ts')
    benchmarkChildDiagnostics = await import(pathToFileURL(diagnosticModule).href)
  } catch {
    console.error('[gotry] benchmark environment configuration unavailable')
    process.exit(1)
  }
}
// dsh-map-tools 宿主插件(地图/路线/POI,零 key 走 OSM/OSRM):tarball 随包 vendor,
// repo 工作副本走 runtime workspace 链接/依赖解析;都找不到就整块剔除 patch 条目
// (缺地图不挡旅行规划)。不能改成 npm 依赖:其 peerDependencies 要求
// dsh-settings/dsh-tools >=0.1.2-rc.1,与本包锁定的 0.1.2-alpha.3 家族在 npm
// 严格 peer 解析下 ERESOLVE,会直接弄坏 npx 安装。
let mapEntry = ''
if (!benchmarkEnvironmentConfig) {
  const vendoredMap = join(repoRoot, 'ts/dsh-runtime/vendor/dsh-map-tools/lib/index.js')
    // (随 tarball 分发;source 布局同一份文件)
  const runtimeMap = join(repoRoot, 'ts/dsh-runtime/node_modules/dsh-map-tools/lib/index.js')
    // (ts/dsh-runtime pnpm workspace vendor/* 链接形态)
  if (existsSync(vendoredMap)) {
    mapEntry = vendoredMap
  } else if (existsSync(runtimeMap)) {
    mapEntry = runtimeMap
  } else {
    // npm 布局:子路径可能被 exports 挡(resolve 抛错不能留下旧值),裸包名返回真实入口
    try { mapEntry = require_.resolve('dsh-map-tools/lib/index.js') } catch { mapEntry = '' }
    if (!mapEntry) { try { mapEntry = require_.resolve('dsh-map-tools') } catch { mapEntry = '' } }
    if (!mapEntry) {
      // ts/node_modules 回退(source 模式:dsh-map-tools 安装在 ts/package.json)
      try { mapEntry = require_.resolve(join(repoRoot, 'ts/node_modules/dsh-map-tools')) } catch { mapEntry = '' }
    }
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

// dsh-calendar 宿主插件(CalDAV 工作窗口读取)——D-9 拍板(issue #106):默认不挂载。
// 未配置的日历工具是纯负资产(会话中段才撞「未配置 username」报错),gotry 对它的
// 唯一诉求(工作窗口)由访谈首轮覆盖。挂载与否由 **setup 状态面**决定(founder
// 2026-09-03 纠偏:禁止环境变量控制产品行为;可选依赖进 setup 状态管理,与扩展
// manifest 同居 ~/.gotry)——`npx gotry setup calendar` 写 ~/.gotry/calendar.json,
// `--off` 删除恢复默认;doctor 报告三态。
let calEnabled = false
try {
  calEnabled = JSON.parse(readFileSync(join(homedir(), '.gotry', 'calendar.json'), 'utf-8'))?.enabled === true
} catch { /* 缺文件/坏文件 = 默认不挂载 */ }
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
if (calEntry && calEnabled) {
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
let llmMaxTokens
if (process.env.GOTRY_LLM_MODEL) {
  const rawMax = process.env.LLM_MAX_TOKENS
  if (rawMax !== undefined && rawMax !== '') {
    llmMaxTokens = Number.parseInt(rawMax, 10)
    if (!Number.isSafeInteger(llmMaxTokens) || llmMaxTokens <= 0) {
      throw new Error(`invalid LLM_MAX_TOKENS: ${JSON.stringify(rawMax)} (expected a positive safe integer)`)
    }
  }
  const modelYaml = `'${process.env.GOTRY_LLM_MODEL.replace(/'/g, "''")}'`
  // LLM_MAX_TOKENS(Round 9,#100/#102):中转/兼容端点模型常带低于 dsh 未知模型
  // 默认 256K 预算的输出上限(MiniMax 2013 实测);目录条目 maxTokens 元数据是
  // dsh-llm-deepseek defaultMaxTokens 的官方通道(web UI 模型同源)。
  const maxTokensYaml = llmMaxTokens === undefined ? '' : `\n        maxTokens: ${llmMaxTokens}`
  patchRaw += `\n# LLM_MODEL 指定模型(issue #77):dsh 会话面默认模型 + 模型目录\n- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: ${modelYaml}\n- id: llm-deepseek\n  config:\n    models:\n      - id: ${modelYaml}\n        name: ${modelYaml}${maxTokensYaml}\n`
}
// Keep the patch private and short-lived. mkdtempSync creates a 0700 directory;
// wx prevents accidental reuse/races if a process is started concurrently.
const patchDir = mkdtempSync(join(tmpdir(), 'gotry-cordis-'))
const patchPath = join(patchDir, 'patch.yml')
writeFileSync(patchPath, patchRaw, { mode: 0o600, flag: 'wx' })
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
// LLM key 由 dsh 宿主管理(凭证是用户资产,UI 在 dsh 里;gotry 不拦截启动期,
// 不在用户面前展示任何 key 配置引导),此处直接放手 spawn dsh。
const binJs = mode === 'web'
  ? ['web', '--patch', patchPath, ...(process.argv.includes('--no-open') ? ['--no-open'] : [])]
  : ['--profile', 'headless', '--patch', patchPath, ...rest]

const childEnv = { ...process.env }
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
if (benchmarkEnvironmentConfig) childEnv.GOTRY_BENCHMARK_DIAGNOSTIC_FD = '3'
const childStdio = mode === 'web'
  ? 'inherit'
  : benchmarkStdout
    ? ['pipe', 'pipe', 'pipe', 'pipe']
    : process.stdin.isTTY
      ? 'inherit'
      : ['pipe', 'inherit', 'inherit']
let benchmarkCapturedBytes = 0
let benchmarkDiagnosticBuffer = Buffer.alloc(0)
let benchmarkOutputTruncated = false
// issue #258:`gotry web` 启动前的一次性交互式 onboarding(仅交互式 TTY + 有可自动安装
// 缺项时问一次;y 复用 doctor --fix 幂等安装器,不建第二套;n 立即继续 web)。
// CI/benchmark/非 TTY/全健康/GOTRY_SETUP_SKIP=1/GOTRY_ONBOARDING_SKIP=1/--no-onboarding
// 均零 prompt 零安装,仍启 web;永不 postinstall 或后台任务里安装。
// bootstrap 以 `onboarding --result-file=…` 同步 inherit 跑;result JSON 告知是否 prompt
// 过,用以抑制重复的启动摘要行(design §3.1③,#114)。
let onboardingPrompted = false
const onboardingSkip = onboardingSkipReason({
  mode,
  benchmark: Boolean(benchmarkEnvironmentConfig),
  env: process.env,
  argv: process.argv,
  isTTY: process.stdin.isTTY,
})
if (!onboardingSkip) {
  let resultFile = null
  try {
    resultFile = join(tmpdir(), `gotry-onboarding-${process.pid}-${Date.now()}.json`)
    spawnSync(process.execPath, [join(here, 'gotry-bootstrap.js'), 'onboarding', `--result-file=${resultFile}`], {
      stdio: 'inherit',
      timeout: 300_000,
    })
    // onboarding 永不挡 web:忽略 exit code;仅读 result 判断是否 prompt 过
    if (existsSync(resultFile)) {
      try { onboardingPrompted = JSON.parse(readFileSync(resultFile, 'utf-8'))?.prompted === true }
      catch { /* 坏 result 不挡 */ }
    }
  } catch { /* onboarding 不可用不挡 web */ } finally {
    if (resultFile) { try { rmSync(resultFile, { force: true }) } catch { /* ignore */ } }
  }
}
// 启动一次性 doctor 摘要(issue #114,design §3.1③):分离子进程后台跑只读体检,
// 有待处理项打一行 stderr(stderr 继承,不污染 stdout;benchmark 面保持零杂音)。
// onboarding 已 prompt 时抑制重复摘要行(已向用户展示缺项与结果)。
if (!benchmarkEnvironmentConfig && !onboardingPrompted) {
  try {
    spawn(process.execPath, [join(here, 'gotry-bootstrap.js'), 'doctor', '--summary'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'inherit'],
    }).unref()
  } catch { /* 体检不可用不挡启动 */ }
}
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
  child.stdio?.[3]?.on('data', chunk => {
    benchmarkDiagnosticBuffer = benchmarkChildDiagnostics.appendBoundedChildDiagnostic(
      benchmarkDiagnosticBuffer,
      Buffer.from(chunk),
    )
  })
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
let benchmarkFailureReported = false
const reportBenchmarkFailure = reason => {
  if (benchmarkFailureReported) return
  benchmarkFailureReported = true
  process.exitCode = 1
  process.stderr.write(`[gotry] benchmark terminal output unavailable (${reason})\n`)
}

child.on('close', (code, signal) => {
  cleanupPatch()
  if (benchmarkStdout) {
    const captured = Buffer.concat(benchmarkStdout).toString('utf8')
    if (code !== 0 || signal || benchmarkOutputTruncated) {
      const reason = benchmarkChildDiagnostics.classifyBenchmarkChildFailure({
        code,
        signal,
        diagnostic: benchmarkDiagnosticBuffer.toString('utf8'),
        outputTruncated: benchmarkOutputTruncated,
      })
      reportBenchmarkFailure(reason)
      return
    }
    const parserModule = distModuleMode && existsSync(join(repoRoot, 'dist/src/benchmark-agent-conformance.js'))
      ? join(repoRoot, 'dist/src/benchmark-agent-conformance.js')
      : join(repoRoot, 'ts/src/benchmark-agent-conformance.ts')
    import(pathToFileURL(parserModule).href).then(async ({ parseBenchmarkTerminal }) => {
      const parsed = parseBenchmarkTerminal(captured, benchmarkTerminalConfig)
      if (!parsed || parsed.ok !== true) {
        reportBenchmarkFailure('child_terminal_invalid')
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
      reportBenchmarkFailure('child_lifecycle_failure')
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
  if (benchmarkEnvironmentConfig) {
    reportBenchmarkFailure('child_spawn_failure')
    return
  }
  console.error(`[gotry] dsh 启动失败: ${e.message}`)
  console.error('尝试: node -v 看 Node 版本(需 22.15+),或查看 ts/dsh-runtime/node_modules/。')
  process.exit(1)
})
