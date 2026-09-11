/**
 * 可选依赖体检(doctor)——工具层与 CLI(npx @danceiny/gotry doctor)共用的状态面。
 *
 * 背景(2026-09-02 迪拜 session 轨迹复盘):8953be5 把 hbcli/agent-reach 装配从
 * setup 挪出后,工具层仍按「包内 .venv 已装配」运行 → gotry_agent_reach /
 * gotry_web_search(web.read)全量 not-installed,且报错指引指向已失效的文档。
 * founder 拍板:可选依赖不撒手——doctor 统一显示状态、给精确补装指引。
 *
 * 契约(与 capabilities/* 同构):
 *   - `runDoctorChecks` 永远只读;显式 repair 另经会话 scope 审批后复用 bootstrap 幂等安装器;
 *   - 永不抛错:单项检查失败降级为 status='degraded',不拖垮整体报告;
 *   - 可注入:repoRoot/homeDir/env 可替换(CI/离线确定性测试);
 *   - LLM key 永不体检——那是 dsh 宿主的管辖面(founder 2026-09-02 明确)。
 *
 * @module capabilities/doctor
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readLatestChannelEvents } from './channel-health.ts'

export type DoctorStatus = 'ok' | 'missing' | 'degraded'

export interface DoctorItem {
  /** 稳定 id(报告/测试锚点) */
  id: 'node' | 'extension' | 'agent-reach' | 'hbcli' | 'flyai' | 'sidebar' | 'llm-key' | 'calendar' | 'map-tools' | 'ask-user'
  /** 展示名 */
  label: string
  status: DoctorStatus
  /** 一句话现状(人话,不带行话) */
  detail: string
  /** status !== 'ok' 时的修复指引(精确到可复制执行的命令) */
  fix?: string
}

export interface DoctorReport {
  ok: boolean
  items: DoctorItem[]
  /** 人话总结(工具面 summary 直接用) */
  summary: string
}

export interface DoctorOptions {
  repoRoot?: string
  homeDir?: string
  env?: NodeJS.ProcessEnv
  /** 状态根(读通道健康事件 channel-health.jsonl;缺省不读) */
  stateRoot?: string
}

/** hbcli 已知安装位(与 capabilities/hbcli.ts hbcliBinCandidates 同清单) */
function hbcliCandidates(homeDir: string): string[] {
  return ['hbcli', join(homeDir, '.local/bin/hbcli'), join(homeDir, '.staicli/current/hbcli')]
}

/** 静默探测命令可执行(带超时;探测失败不抛错) */
function probe(bin: string, args: string[], timeoutMs = 8_000): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const child = spawn(bin, args, { stdio: 'ignore', env: process.env })
    let done = false
    const timer = setTimeout(() => {
      if (!done) { done = true; try { child.kill('SIGKILL') } catch { /* ignore */ } resolveProbe(false) }
    }, timeoutMs)
    child.on('error', () => { if (!done) { done = true; clearTimeout(timer); resolveProbe(false) } })
    child.on('exit', (code) => { if (!done) { done = true; clearTimeout(timer); resolveProbe(code === 0) } })
  })
}

/** 探测命令 stdout(--version),失败返回 null */
function probeStdout(bin: string, args: string[], timeoutMs = 8_000): Promise<string | null> {
  return new Promise((resolveProbe) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'], env: process.env })
    let out = ''
    let done = false
    const timer = setTimeout(() => {
      if (!done) { done = true; try { child.kill('SIGKILL') } catch { /* ignore */ } resolveProbe(null) }
    }, timeoutMs)
    child.on('error', () => { if (!done) { done = true; clearTimeout(timer); resolveProbe(null) } })
    child.stdout?.on('data', (d) => { out += d.toString() })
    child.on('exit', (code) => { if (!done) { done = true; clearTimeout(timer); resolveProbe(code === 0 ? out.trim() : null) } })
  })
}

/** 解析语义化版本号 "1.2.3" → [1,2,3];失败 null */
function parseVersion(v: string | null): [number, number, number] | null {
  const m = String(v || '').match(/(\d+)\.(\d+)\.(\d+)/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function versionAtLeast(v: [number, number, number] | null, min: string): boolean {
  const a = v; const b = parseVersion(min)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i] }
  return true
}

/** Node ≥ 22.15(与 bin/gotry-inner.js supportsNodeVersion 同口径) */
export function nodeOk(version: string): boolean {
  const [maj = '0', min = '0'] = version.split('.')
  return Number(maj) > 22 || (Number(maj) === 22 && Number(min) >= 15)
}

/** hbcli 最低版本(可用 GOTRY_MIN_HBCLI_VERSION 覆盖)。0.0.3 修了 portal-ticket
 * fallback bug(issue #142)——低于该版本的 hbcli 会把 literal "stored-ticket"
 * 当 bearer 发到 hotel-be,让 trade.* / search/checkAvail 全部 401。 */
const MIN_HBCLI_VERSION = process.env.GOTRY_MIN_HBCLI_VERSION ?? '0.0.3'

/** 单项检查:全部只读、永不抛错;env/homeDir/repoRoot 可注入(测试确定性) */
export async function runDoctorChecks(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const repoRoot = opts.repoRoot ? resolve(opts.repoRoot) : resolve(import.meta.dirname, '..', '..')
  const home = opts.homeDir ?? homedir()
  const env = opts.env ?? process.env
  const items: DoctorItem[] = []

  // 0. Node 运行时
  const nodeVersion = process.versions.node
  items.push(nodeOk(nodeVersion)
    ? { id: 'node', label: 'Node 运行时', status: 'ok', detail: `Node ${nodeVersion}(≥22.15)` }
    : { id: 'node', label: 'Node 运行时', status: 'missing', detail: `Node ${nodeVersion} 过旧(gotry 需 ≥22.15)`, fix: '升级 Node.js 至 22.15+(https://nodejs.org)' })

  // 1. GoTry Session Bridge 扩展(账号会话通道的传输层;装在哪由 bootstrap setup 管理)
  //    D-24 自适应(#117):离线只能探测本地 unpacked 通道;商店版无本地文件面——
  //    missing detail 明示「商店版用户可忽略本项」,不再把商店版用户误导成本地通道缺失
  const extManifest = join(home, '.gotry', 'extension', 'manifest.json')
  items.push(existsSync(extManifest)
    ? { id: 'extension', label: 'GoTry Session Bridge 扩展', status: 'ok', detail: `已就位(本地通道:${extManifest})` }
    : {
        id: 'extension', label: 'GoTry Session Bridge 扩展', status: 'missing',
        detail: '本地通道未落位(~/.gotry/extension/manifest.json 不存在)。若你已从 Chrome 商店安装(自动更新,商店版 ID oeajpicc…),本项可忽略——会话检索可用性以运行时为准(gotry_session_search 的 verdict)。若未安装:应用商店一键装即可',
        fix: '在 Chrome 应用商店一键安装(自动更新): https://chromewebstore.google.com/detail/gotry-session-bridge/oeajpiccmonococjcegddlooeeohlbgd',
      })

  // 2. agent-reach(网页/社媒读取;.venv 装在包内,与 agent-reach.ts venvPython 同位)
  const venvPython = join(repoRoot, '.venv/bin/python')
  const reachBin = join(repoRoot, '.venv/bin/agent-reach')
  if (existsSync(reachBin)) {
    items.push({ id: 'agent-reach', label: 'Agent Reach(网页/社媒读取)', status: 'ok', detail: `已安装(${reachBin});渠道凭证选配体检:在对话里调 gotry_agent_reach {action:"status"}` })
  } else if (existsSync(venvPython)) {
    items.push({
      id: 'agent-reach', label: 'Agent Reach(网页/社媒读取)', status: 'degraded',
      detail: '.venv 存在但缺 agent-reach 包——gotry_agent_reach / gotry_web_search 读页会失败',
      fix: `npx @danceiny/gotry doctor --fix(或在包根执行: ${venvPython} -m pip install git+https://github.com/Panniantong/Agent-Reach.git)`,
    })
  } else {
    items.push({
      id: 'agent-reach', label: 'Agent Reach(网页/社媒读取)', status: 'missing',
      detail: '未安装——gotry_agent_reach / gotry_web_search(读网页)/ gotry_video_subtitle / gotry_github_search 全部不可用',
      fix: 'npx @danceiny/gotry doctor --fix',
    })
  }

  // 3. hbcli(酒店实时源;静态包自动降级,缺了不致命)
  //    裸名 'hbcli' 靠 PATH 解析(existsSync 对裸名是 cwd 相对,无意义)——先探测再落位
  //    版本 < MIN_HBCLI_VERSION 视为 missing(issue #142:portal-ticket fallback 401)
  let hbPresent = ''
  for (const p of hbcliCandidates(home)) {
    if (p !== 'hbcli' && existsSync(p)) { hbPresent = p; break }
    if (p === 'hbcli' && await probe(p, ['version'])) { hbPresent = 'hbcli(PATH)'; break }
  }
  if (hbPresent) {
    const hbCmd = hbPresent === 'hbcli(PATH)' ? 'hbcli' : hbPresent
    const v = parseVersion(await probeStdout(hbCmd, ['--version']))
    if (v && !versionAtLeast(v, MIN_HBCLI_VERSION)) {
      items.push({
        id: 'hbcli', label: 'hbcli(酒店实时源)', status: 'missing',
        detail: `版本过旧(v${v.join('.')} < v${MIN_HBCLI_VERSION})——trade.* / search/checkAvail 会 401(issue #142)`,
        fix: 'npm install -g staicli --registry=https://registry.npmjs.org/',
      })
    } else {
      const whoami = await probe(hbCmd, ['auth', 'whoami'])
      items.push(whoami
        ? { id: 'hbcli', label: 'hbcli(酒店实时源)', status: 'ok', detail: `已安装且凭证有效(${hbPresent}, v${v ? v.join('.') : '?'})` }
        : {
            id: 'hbcli', label: 'hbcli(酒店实时源)', status: 'degraded',
            detail: '二进制在,但凭证未配置/失效——酒店检索将降级静态包(非实时)',
            fix: 'hbcli auth set-credentials --app-key hotelbyte_api_demo --app-secret hotelbyte_api_demo(快速试用沙箱;正式 key 向 HotelByte 申请)',
          })
    }
  } else {
    items.push({
      id: 'hbcli', label: 'hbcli(酒店实时源)', status: 'missing',
      detail: '未安装——酒店检索降级静态包(公开渠道估算,非实时,仅覆盖内置场景)',
      fix: 'npx @danceiny/gotry doctor --fix',
    })
  }

  // 4. flyai(飞猪官方只读通道;匿名试用额度共享,易达限)
  //    配额状态可见(通道健康持久面):最近一次达限时间进 detail——
  //    「易达限却不可见」是 issue #107 的病灶之一。
  const flyaiKey = env.FLYAI_API_KEY?.trim()
  const flyaiQuotaNote = !flyaiKey && opts.stateRoot
    ? await (async () => {
        const ev = (await readLatestChannelEvents(opts.stateRoot!)).get('flyai')
        return ev?.state === 'down' ? `;最近一次试用达限: ${ev.at}(匿名共享池,正式 key 可解除)` : ''
      })()
    : ''
  items.push(flyaiKey
    ? { id: 'flyai', label: 'FlyAI(飞猪官方检索)', status: 'ok', detail: 'FLYAI_API_KEY 已配(正式 key,无试用额度限制)' }
    : {
        id: 'flyai', label: 'FlyAI(飞猪官方检索)', status: 'degraded',
        detail: `未配 FLYAI_API_KEY——走匿名试用额度(共享,易达限;达限报 "Trial limit reached")${flyaiQuotaNote}`,
        fix: '到 flyai.open.fliggy.com 控制台申请正式 key,配进环境变量 FLYAI_API_KEY;无 key 期间机/火/酒检索请以 gotry_session_search(账号会话)为主',
      })

  // 5. dsh-better-sidebar(dsh web 侧栏工作台;产物预览面 + doctor 报告的查看面)
  const sidebarPkg = join(home, '.dsh/profiles/web/node_modules/dsh-better-sidebar/package.json')
  items.push(existsSync(sidebarPkg)
    ? { id: 'sidebar', label: 'dsh-better-sidebar(侧栏工作台)', status: 'ok', detail: '已安装——web UI 右侧工作台可预览产物与 doctor 报告(gotry-state/doctor-report.md)' }
    : {
        id: 'sidebar', label: 'dsh-better-sidebar(侧栏工作台)', status: 'missing',
        detail: '未安装——dsh web 无右侧工作台,产物与 doctor 报告只能在对话里看(gotry_artifacts_list)',
        fix: 'npx @danceiny/gotry doctor --fix',
      })

  // 6. dsh-calendar(patch 分发面宿主插件;D-9 拍板:默认不挂载)
  //    未配置的日历工具是纯负资产(issue #106:会话中段才撞「未配置 username」),
  //    工作窗口由 persona (1) 访谈覆盖;挂载与否由 **setup 状态面**决定
  //    (`~/.gotry/calendar.json`,`npx @danceiny/gotry setup calendar` on/off——founder
  //    2026-09-03 纠偏:禁止环境变量控制产品行为,可选依赖进 setup 状态管理)。
  const calStatePath = join(home, '.gotry', 'calendar.json')
  const calEnabled = (() => {
    try { return JSON.parse(readFileSync(calStatePath, 'utf-8'))?.enabled === true } catch { return false }
  })()
  const calProfilePatch = join(home, '.dsh/profiles/web/cordis.patch.yml')
  const calConfigured = calEnabled && existsSync(calProfilePatch) && (() => {
    try {
      const content = readFileSync(calProfilePatch, 'utf-8')
      return /calendar/.test(content) && /username\s*:/.test(content)
    } catch { return false }
  })()
  items.push(!calEnabled
    ? {
        id: 'calendar', label: 'dsh-calendar(日历工作窗口)', status: 'ok',
        detail: '默认未挂载(D-9:未配置的日历工具不进工具箱;工作窗口由访谈覆盖,不影响任何检索)',
      }
    : calConfigured
      ? { id: 'calendar', label: 'dsh-calendar(日历工作窗口)', status: 'ok', detail: `已挂载且已配置(${calStatePath})` }
      : {
          id: 'calendar', label: 'dsh-calendar(日历工作窗口)', status: 'degraded',
          detail: '已挂载但 calendar 未配置 username——日历工具会话中会报「未配置」',
          fix: `npx @danceiny/gotry setup calendar --off(恢复默认不挂载),或在 ${calProfilePatch} 覆盖 calendar 行 config 填 username(指引: npx @danceiny/gotry setup calendar --status)`,
        })

  // 7. patch 分发面宿主插件(issue #113 L1 残量,design §3.1:初始化可见取代会话中段撞错)。
  //    这类插件在 cordis patch 里是占位行,bin/gotry-inner.js 运行时解析——**解析失败整块
  //    静默剔除,不挡启动**:模型只觉得「没有这个工具」,没人告诉它为什么。doctor 把两态照亮。
  //    候选清单与 bin 解析逻辑同口径(map:tarball vendor 优先→runtime workspace→npm 提升解析;
  //    ask-user:dsh 闭包上下文解析)。map 保持随包 vendor 分发而非 npm 依赖:历史上游
  //    peerDependencies 要求 dsh-settings/dsh-tools >=0.1.2-rc.1,与锁定的 0.1.2-alpha.3 家族
  //    在 npm 严格 peer 解析下 ERESOLVE;当前锁定 0.1.5-rc.1 家族,vendored 副本已对齐
  //    0.1.5-rc.1,继续以 vendor 形态复用适配补丁,避免弄坏 npx 主安装路径。
  const rootRequire = createRequire(join(repoRoot, 'package.json'))
  const mapCandidates = [
    join(repoRoot, 'ts/dsh-runtime/vendor/dsh-map-tools/lib/index.js'),
    join(repoRoot, 'ts/dsh-runtime/node_modules/dsh-map-tools/lib/index.js'),
    join(repoRoot, 'node_modules/dsh-map-tools/package.json'),
    join(repoRoot, 'ts/node_modules/dsh-map-tools/package.json'),
    join(home, '.dsh/profiles/web/node_modules/dsh-map-tools/package.json'),
  ]
  let mapHit: string | undefined = mapCandidates.find(p => existsSync(p))
  // npm/npx 提升布局:gotry 的依赖在包目录外的同级提升位,existsSync 候选打不中——
  // 与 inner 的 require_.resolve 同机制,从包位置向上走查解析
  if (!mapHit) { try { mapHit = rootRequire.resolve('dsh-map-tools') } catch { mapHit = undefined } }
  items.push(mapHit
    ? { id: 'map-tools', label: 'dsh-map-tools(地图/路线/POI)', status: 'ok', detail: `已就位(${mapHit})——地图工具可用(零 key,走 OSM/OSRM)` }
    : {
        id: 'map-tools', label: 'dsh-map-tools(地图/路线/POI)', status: 'missing',
        detail: '未随包解析——启动时该 patch 条目被静默剔除,地图/路线/POI 工具不会出现在模型工具箱(缺地图不挡旅行规划,只少能力)',
        fix: '重装 @danceiny/gotry(地图插件随包 vendor 分发,缺失多为安装不完整)',
      })

  const askCandidates = [
    join(repoRoot, 'ts/dsh-runtime/vendor/deepseek-ai-dsh-tool-ask-user/package.json'),
    join(repoRoot, 'node_modules/@deepseek-ai/dsh-tool-ask-user/package.json'),
    join(home, '.dsh/profiles/web/node_modules/@deepseek-ai/dsh-tool-ask-user/package.json'),
  ]
  let askHit: string | undefined = askCandidates.find(p => existsSync(p))
  // 与 inner 同口径:优先从 dsh 包上下文解析(pnpm 嵌套布局只有 dsh 看得见闭包成员),
  // 再从包根上下文(npm/npx 提升布局),最后静态候选(source vendored / profile)
  if (!askHit) {
    try {
      const reqFromDsh = createRequire(rootRequire.resolve('@deepseek-ai/dsh/lib/bin.js'))
      askHit = reqFromDsh.resolve('@deepseek-ai/dsh-tool-ask-user')
    } catch {
      try { askHit = rootRequire.resolve('@deepseek-ai/dsh-tool-ask-user') } catch { askHit = undefined }
    }
  }
  items.push(askHit
    ? { id: 'ask-user', label: 'dsh-tool-ask-user(结构化澄清卡)', status: 'ok', detail: `已就位(${askHit})——ask_user_question 澄清卡可用(web 原生卡片;headless+TTY 用 stdio 提供方)` }
    : {
        id: 'ask-user', label: 'dsh-tool-ask-user(结构化澄清卡)', status: 'missing',
        detail: '未解析——启动时澄清卡注入被静默剔除,模型只能散文追问(人格契约 (5) 退化文本形态)',
        fix: '重装 @danceiny/gotry——该依赖随 dsh 闭包自带,缺失多为安装不完整',
      })

  // 8. LLM key:显式让渡给 dsh 宿主(founder 2026-09-02:doctor 不管 key)
  items.push({ id: 'llm-key', label: 'LLM key', status: 'ok', detail: '由 dsh 宿主 UI 管理——不在 doctor 体检范围(gotry 不接触、不回显凭证)' })

  const broken = items.filter(i => i.status !== 'ok' && i.id !== 'llm-key')
  const summary = broken.length === 0
    ? `体检通过:${items.length} 项全部就绪(可选依赖齐,LLM key 归 dsh 宿主管)。`
    : `体检发现 ${broken.length} 项待处理:${broken.map(i => `${i.label}(${i.status === 'missing' ? '未装' : '半可用'})`).join('、')}。补装:终端跑 npx @danceiny/gotry doctor --fix,或按各项 fix 指引逐项处理。`
  return { ok: broken.length === 0, items, summary }
}

/** 修复指引入表:命令类才加反引号(prose 类如「到控制台申请 key」原样) */
const fixCell = (fix?: string) => (!fix ? '—' : /^(npx|hbcli|curl|pip|python|\$)/.test(fix) ? `\`${fix}\`` : fix)

// ---------------------------------------------------------------------------
// 自助修复(repair,issue #284):gotry_doctor 显式 `action: 'repair'` 时,按用户
// 传入的 items 范围只尝试 auto-repairable 缺项;user-action / unavailable 永
// 不冒充 auto。**生产路径必须经 bootstrap.runOnboardingFix**(复用 real
// setupHbcli / setupReach / setupSidebar + 内部 doctorChecks 复检)—
// capability 层不写第二套安装面。**安装器退出 ≠ 健康**:per-item 终态由
// runOnboardingFix 内部 post-install recheck 决定。tests 注入 installers /
// recheck / bridge 跑 fakes,永不真安装。
// ---------------------------------------------------------------------------

export type DoctorRepairApproval = 'granted' | 'rejected' | 'cancelled' | 'unavailable' | 'not-needed'
export type DoctorRepairItemStatus = 'installed' | 'failed'
export type DoctorRepairVerdict = 'repaired' | 'partial-repair' | 'repair-blocked' | 'no-repair-needed' | 'approval-denied'

/** bootstrap 内部 doctorItems 形状(同 runOnboardingFix 接受):与 DoctorItem 区别
 *  在 status 字段名为 level。**`toBootstrapItem` 是 status→level 边界适配点**—
 *  直传 DoctorItem 会让 bootstrap.classifyDoctorGap 因 `!item.level` 把所有项分
 *  到 'ok',plan 永远空。这是修 #284 blocker #2 的关键一行。 */
interface BootstrapItem { label: string; level: 'ok' | 'missing' | 'degraded'; detail: string; fix?: string }
interface BootstrapRunResult { label: string; status: 'installed' | 'needs-user-action' | 'unavailable'; reason?: string; retry?: string }
interface BootstrapPlan { promptable: boolean; auto: BootstrapItem[]; userAction: BootstrapItem[]; unavailable: BootstrapItem[] }

export interface DoctorRepairOutcome { id: string; label: string; status: DoctorRepairItemStatus; reason: string; nextAction?: string }
export interface DoctorRepairSkipped { id: string; label: string; bucket: 'user-action' | 'unavailable'; reason: string }
export interface DoctorRepairResult {
  ok: boolean
  verdict: DoctorRepairVerdict
  approval: DoctorRepairApproval
  /** 本次计划选中的自动修复项；审批拒绝/取消/缺席时仍保留，便于审计计划边界 */
  selected: Array<{ id: string; label: string }>
  /** selected 的稳定排序去重 key；同会话批准缓存以此为粒度 */
  scopeKey: string
  repairs: DoctorRepairOutcome[]
  skipped: DoctorRepairSkipped[]
  summary: string
}

export interface DoctorRepairOptions {
  /** 注入 runOnboardingFix 假实现(默认 = bootstrap.runOnboardingFix 真导出) */
  runOnboardingFix?: (plan: BootstrapPlan, opts: { installers?: Record<string, () => Promise<{ ok: boolean; error?: string }>>; recheck?: () => Promise<BootstrapItem[]> }) => Promise<BootstrapRunResult[]>
  /** 假安装器(key 为 hbcli / reach / sidebar;传给 bootstrap.runOnboardingFix as opts.installers) */
  installers?: Record<string, () => Promise<{ ok: boolean; error?: string }>>
  /** 假复检(返回 bootstrap 形状数组)—决定最终判定。**签名同 bootstrap.runOnboardingFix** */
  recheck?: () => Promise<BootstrapItem[]>
  /** 高级注入:覆盖 classifyDoctorGap / buildOnboardingPlan(默认 = bootstrap 真实导出) */
  bridge?: { classifyDoctorGap?: (i: BootstrapItem, opts?: { platform?: string; env?: NodeJS.ProcessEnv }) => string; buildOnboardingPlan?: (items: BootstrapItem[], opts?: { platform?: string; env?: NodeJS.ProcessEnv }) => BootstrapPlan }
  platform?: string
  env?: NodeJS.ProcessEnv
}

/** 稳定 scope key(item ids 排序去重逗号串,空 = '')—批准缓存 / 审计 / 测试断言 */
export function scopeKeyFor(ids: readonly string[]): string {
  if (!Array.isArray(ids) || ids.length === 0) return ''
  return [...new Set(ids)].sort().join(',')
}

/** DoctorItem → bootstrap 形状:status 改名为 level(关键适配,见 BootstrapItem 注释) */
function toBootstrapItem(i: DoctorItem): BootstrapItem {
  return { label: i.label, level: i.status, detail: i.detail, fix: i.fix }
}

const KNOWN_IDS = new Set(['node', 'extension', 'agent-reach', 'hbcli', 'flyai', 'sidebar', 'llm-key', 'calendar', 'map-tools', 'ask-user'])

interface BootstrapBridge {
  classifyDoctorGap: (i: BootstrapItem, opts?: { platform?: string; env?: NodeJS.ProcessEnv }) => string
  buildOnboardingPlan: (items: BootstrapItem[], opts?: { platform?: string; env?: NodeJS.ProcessEnv }) => BootstrapPlan
  runOnboardingFix: (plan: BootstrapPlan, opts: { installers?: Record<string, () => Promise<{ ok: boolean; error?: string }>>; recheck?: () => Promise<BootstrapItem[]> }) => Promise<BootstrapRunResult[]>
}
let cachedBootstrap: BootstrapBridge | null = null
async function loadBootstrapBridge(): Promise<BootstrapBridge> {
  if (cachedBootstrap) return cachedBootstrap
  const url = new URL('../../bin/gotry-bootstrap.js', import.meta.url)
  const mod = await import(url.href) as BootstrapBridge
  cachedBootstrap = mod
  return mod
}

/** approval 状态(WeakMap<agent> 收口 + scope 维度粒度):granted 用 Set<string>;
 *  denied 用 Map<scopeKey, 'rejected' | 'cancelled'>——**保留具体结果**,后续同 scope
 *  重复请求返回同一 outcome(cancelled 不被静默合并成 rejected,issue #284 加固点)。 */
export type RepairApprovalState = { granted: Set<string>; denied: Map<string, 'rejected' | 'cancelled'> }

/** dsh 原生 ApprovalSeam 透传(沿用 session-consent 的 ApprovalOutcome 闭集) */
export type RawApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
export interface RawApprovalSeam { request: (r: { agent?: unknown; toolName: string; callId?: string; reason?: string; signal?: AbortSignal }) => Promise<RawApprovalOutcome> }

export interface RepairApprovalGateOptions {
  approval?: () => RawApprovalSeam | undefined
  store?: WeakMap<object, RepairApprovalState>
}

export function createRepairApprovalGate(opts: RepairApprovalGateOptions) {
  const store = opts.store ?? new WeakMap<object, RepairApprovalState>()
  const getState = (agent: object | undefined): RepairApprovalState => {
    if (!agent) return { granted: new Set(), denied: new Map() }
    let s = store.get(agent)
    if (!s) { s = { granted: new Set(), denied: new Map() }; store.set(agent, s) }
    return s
  }
  const has = (agent: object | undefined, scopeKey: string): DoctorRepairApproval => {
    if (!scopeKey) return 'not-needed'
    const s = getState(agent)
    if (s.granted.has(scopeKey)) return 'granted'
    return s.denied.get(scopeKey) ?? 'not-needed' // 保留具体 rejected/cancelled
  }
  const request = async (
    agent: object | undefined,
    scopeKey: string,
    reason: string,
    requestMeta: { callId?: string; signal?: AbortSignal } = {},
  ): Promise<DoctorRepairApproval> => {
    const cached = has(agent, scopeKey)
    if (cached !== 'not-needed') return cached
    const seam = opts.approval?.()
    if (!seam || typeof seam.request !== 'function' || !agent) return 'unavailable'
    let raw: RawApprovalOutcome
    try { raw = await seam.request({ agent, toolName: 'gotry_doctor', callId: requestMeta.callId, reason, signal: requestMeta.signal }) } catch { raw = 'unavailable' }
    const mapped: DoctorRepairApproval =
      raw === 'allowed-once' ? 'granted' :
      raw === 'rejected' || raw === 'cancelled' ? raw : 'unavailable'
    const s = getState(agent)
    if (mapped === 'granted') s.granted.add(scopeKey)
    else if (mapped === 'rejected' || mapped === 'cancelled') s.denied.set(scopeKey, mapped)
    // unavailable 不记(通道回来还能再问一次)
    return mapped
  }
  return { has, request, store }
}

/** 修复运行(主入口):diagnosis → bootstrap.buildOnboardingPlan(status→level 适配)
 *  → scope-keyed 审批 → bootstrap.runOnboardingFix(真安装器 + 内部复检)
 *  → per-item verdict。**生产**:不传 opts,走 bootstrap 真实导出。
 *  **tests**:注入 installers / recheck / bridge 跑 fakes,永不真安装命令。
 *  user-action / unavailable 项绝不进 selected(分类器守住),scope 过滤后被剔除
 *  的项从 selected 排除(永不装)。 */
export async function runDoctorRepair(
  report: DoctorReport,
  approve: (scopeKey: string, reason: string) => Promise<DoctorRepairApproval>,
  opts: DoctorRepairOptions = {},
): Promise<DoctorRepairResult> {
  // 1. 选 bridge:tests 注入覆盖;生产用 bootstrap 真实导出(懒加载并缓存)
  const bridge: BootstrapBridge = opts.bridge
    ? { ...await loadBootstrapBridge(), ...opts.bridge } as BootstrapBridge
    : await loadBootstrapBridge()
  const runInstalls = opts.runOnboardingFix ?? bridge.runOnboardingFix

  // 2. status→level 适配(关键)—直传 DoctorItem 会让 bootstrap.classifyDoctorGap
  //    因 !item.level 把所有项分到 ok,plan 始终为空(原版真 bug)。
  const bItems = (report.items ?? []).map(toBootstrapItem)
  const plan = bridge.buildOnboardingPlan(bItems, { platform: opts.platform, env: opts.env })

  const labelToId = new Map<string, string>()
  for (const i of report.items ?? []) if (i?.id && i?.label) labelToId.set(i.label, i.id)

  // 3. selected = plan.auto ∩ 已知 doctor item id(防御:未知 id 静默剔除不冒充 auto)
  const selected = (plan.auto ?? [])
    .filter((g) => KNOWN_IDS.has(labelToId.get(g.label) ?? ''))
    .map((g) => ({ id: labelToId.get(g.label)!, label: g.label }))

  const skipped: DoctorRepairSkipped[] = [
    ...(plan.userAction ?? []).map((g) => ({ id: labelToId.get(g.label) ?? '', label: g.label, bucket: 'user-action' as const, reason: g.fix ?? g.detail ?? '需用户本人操作' })),
    ...(plan.unavailable ?? []).map((g) => ({ id: labelToId.get(g.label) ?? '', label: g.label, bucket: 'unavailable' as const, reason: g.detail ?? '本仓无自动安装面' })),
  ]
  const scopeKey = scopeKeyFor(selected.map((s) => s.id))

  // 4. 无 selected → 早退(零审批请求,零副作用)
  if (selected.length === 0) {
    const healthy = (report.items ?? []).every((item) => item.status === 'ok')
    return {
      ok: healthy, verdict: 'no-repair-needed', approval: 'not-needed',
      selected, scopeKey,
      repairs: [], skipped,
      summary: healthy
        ? '诊断:所选项目已经全部就位,无需修复。'
        : '诊断:无可自动补装的缺项(其余项需用户本人操作或本机暂不支持)。',
    }
  }

  // 5. scope-keyed 审批(rejected 与 cancelled 在 denial 缓存里分开记)
  const approval = await approve(scopeKey, `将自动补装 ${selected.length} 项可选依赖:${selected.map((s) => s.label).join('、')};复用 doctor --fix 幂等安装器。`)
  if (approval !== 'granted') {
    return {
      ok: false, verdict: 'approval-denied', approval,
      selected, scopeKey,
      repairs: [], skipped,
      summary: approval === 'rejected' ? '修复未执行:用户拒绝了这次补装(本会话吊销,不再询问)。'
        : approval === 'cancelled' ? '修复未执行:用户取消了这次补装(本会话吊销,不再询问)。'
        : '修复未执行:当前无可用审批通道(headless / 无 UI)。',
    }
  }

  // 6. 真执行:bootstrap.runOnboardingFix(默认 installers = real setupHbcli/etc.;
  //    默认 recheck = bootstrap 内置 doctorChecks,与 runDoctorChecks 同源)。tests 注入 fakes。
  const fullPlan: BootstrapPlan = {
    promptable: true, auto: plan.auto ?? [], userAction: plan.userAction ?? [], unavailable: plan.unavailable ?? [],
  }
  const runResults = await runInstalls(fullPlan, {
    ...(opts.installers ? { installers: opts.installers } : {}),
    ...(opts.recheck ? { recheck: opts.recheck } : {}),
  })

  // 7. per-item 终态:bootstrap 已含内部复检的 installed / needs-user-action / unavailable;
  //    needs-user-action 与 unavailable 都视为 failed(给重试命令)。
  const repairs: DoctorRepairOutcome[] = selected.map((s) => {
    const r = runResults.find((x) => x.label === s.label)
    if (r?.status === 'installed') return { id: s.id, label: s.label, status: 'installed', reason: r.reason ?? '已就位' }
    return {
      id: s.id, label: s.label, status: 'failed',
      reason: r?.reason ?? '安装器未确认成功',
      nextAction: r?.retry ?? 'npx @danceiny/gotry doctor --fix',
    }
  })

  const failed = repairs.filter((r) => r.status === 'failed').length
  const installed = repairs.length - failed
  const verdict: DoctorRepairVerdict = failed === 0 ? 'repaired' : installed === 0 ? 'repair-blocked' : 'partial-repair'
  return {
    ok: failed === 0, verdict, approval, selected, scopeKey, repairs, skipped,
    summary: failed === 0
      ? `修复完成:${installed} 项已就位(其余项见 skipped,需要时手动处理)。`
      : installed === 0
        ? `修复失败:${failed} 项复检仍未就位(${repairs.filter((r) => r.status === 'failed').map((r) => r.label).join('、')});重试: npx @danceiny/gotry doctor --fix。`
        : `修复部分成功:${installed}/${selected.length} 项已就位,${failed} 项失败(${repairs.filter((r) => r.status === 'failed').map((r) => r.label).join('、')});重试: npx @danceiny/gotry doctor --fix。`,
  }
}

/** 报告 → 侧栏可预览 markdown(写盘由调用方决定;本函数纯渲染) */
export function renderDoctorReportMd(report: DoctorReport, now = new Date()): string {
  const icon = (s: DoctorStatus) => (s === 'ok' ? '✅' : s === 'degraded' ? '⚠️' : '❌')
  const lines = [
    '# GoTry 依赖体检报告(doctor)',
    '',
    `> 生成于 ${now.toISOString()};重新生成:终端 \`npx @danceiny/gotry doctor\`,或在对话里让助手调 gotry_doctor。`,
    '',
    '| 状态 | 依赖 | 现状 | 修复指引 |',
    '|---|---|---|---|',
    ...report.items.map(i => `| ${icon(i.status)} | ${i.label} | ${i.detail} | ${fixCell(i.fix)} |`),
    '',
    `**结论**:${report.summary}`,
    '',
    '---',
    '',
    '- `npx @danceiny/gotry doctor` 随时可重跑(只读,不改任何东西);',
    '- `npx @danceiny/gotry doctor --fix` 按上表补装(hbcli 官方脚本 / agent-reach pip / dsh-better-sidebar 插件);',
    '- LLM key 由 dsh 宿主 UI 管理,gotry 永不体检、不回显。',
    '',
  ]
  return lines.join('\n')
}
