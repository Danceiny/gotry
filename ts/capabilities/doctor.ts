/**
 * 可选依赖体检(doctor)——工具层与 CLI(npx gotry doctor)共用的状态面。
 *
 * 背景(2026-09-02 迪拜 session 轨迹复盘):8953be5 把 hbcli/agent-reach 装配从
 * setup 挪出后,工具层仍按「包内 .venv 已装配」运行 → gotry_agent_reach /
 * gotry_web_search(web.read)全量 not-installed,且报错指引指向已失效的文档。
 * founder 拍板:可选依赖不撒手——doctor 统一显示状态、给精确补装指引。
 *
 * 契约(与 capabilities/* 同构):
 *   - 只读:check 绝不安装、绝不写盘(--fix 安装面只在 CLI bootstrap,经用户显式调用);
 *   - 永不抛错:单项检查失败降级为 status='degraded',不拖垮整体报告;
 *   - 可注入:repoRoot/homeDir/env 可替换(CI/离线确定性测试);
 *   - LLM key 永不体检——那是 dsh 宿主的管辖面(founder 2026-09-02 明确)。
 *
 * @module capabilities/doctor
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readLatestChannelEvents } from './channel-health.ts'

export type DoctorStatus = 'ok' | 'missing' | 'degraded'

export interface DoctorItem {
  /** 稳定 id(报告/测试锚点) */
  id: 'node' | 'extension' | 'agent-reach' | 'hbcli' | 'flyai' | 'sidebar' | 'llm-key' | 'calendar'
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

/** Node ≥ 22.15(与 bin/gotry-inner.js supportsNodeVersion 同口径) */
export function nodeOk(version: string): boolean {
  const [maj = '0', min = '0'] = version.split('.')
  return Number(maj) > 22 || (Number(maj) === 22 && Number(min) >= 15)
}

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
  const extManifest = join(home, '.gotry', 'extension', 'manifest.json')
  items.push(existsSync(extManifest)
    ? { id: 'extension', label: 'GoTry Session Bridge 扩展', status: 'ok', detail: `已就位(${extManifest})` }
    : {
        id: 'extension', label: 'GoTry Session Bridge 扩展', status: 'missing',
        detail: '未安装——gotry_session_search / gotry_session_login(账号会话通道)不可用,其余工具不受影响',
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
      fix: `npx gotry doctor --fix(或在包根执行: ${venvPython} -m pip install git+https://github.com/Panniantong/Agent-Reach.git)`,
    })
  } else {
    items.push({
      id: 'agent-reach', label: 'Agent Reach(网页/社媒读取)', status: 'missing',
      detail: '未安装——gotry_agent_reach / gotry_web_search(读网页)/ gotry_video_subtitle / gotry_github_search 全部不可用',
      fix: 'npx gotry doctor --fix',
    })
  }

  // 3. hbcli(酒店实时源;静态包自动降级,缺了不致命)
  //    裸名 'hbcli' 靠 PATH 解析(existsSync 对裸名是 cwd 相对,无意义)——先探测再落位
  let hbPresent = ''
  for (const p of hbcliCandidates(home)) {
    if (p !== 'hbcli' && existsSync(p)) { hbPresent = p; break }
    if (p === 'hbcli' && await probe(p, ['version'])) { hbPresent = 'hbcli(PATH)'; break }
  }
  if (hbPresent) {
    const whoami = await probe(hbPresent === 'hbcli(PATH)' ? 'hbcli' : hbPresent, ['auth', 'whoami'])
    items.push(whoami
      ? { id: 'hbcli', label: 'hbcli(酒店实时源)', status: 'ok', detail: `已安装且凭证有效(${hbPresent})` }
      : {
          id: 'hbcli', label: 'hbcli(酒店实时源)', status: 'degraded',
          detail: '二进制在,但凭证未配置/失效——酒店检索将降级静态包(非实时)',
          fix: 'hbcli auth set-credentials --app-key hotelbyte_api_demo --app-secret hotelbyte_api_demo(快速试用沙箱;正式 key 向 HotelByte 申请)',
        })
  } else {
    items.push({
      id: 'hbcli', label: 'hbcli(酒店实时源)', status: 'missing',
      detail: '未安装——酒店检索降级静态包(公开渠道估算,非实时,仅覆盖内置场景)',
      fix: 'npx gotry doctor --fix',
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
        fix: 'npx gotry doctor --fix',
      })

  // 6. dsh-calendar(patch 分发面宿主插件;D-9 拍板:默认不挂载)
  //    未配置的日历工具是纯负资产(issue #106:会话中段才撞「未配置 username」),
  //    工作窗口由 persona (1) 访谈覆盖;挂载与否由 **setup 状态面**决定
  //    (`~/.gotry/calendar.json`,`npx gotry setup calendar` on/off——founder
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
          fix: `npx gotry setup calendar --off(恢复默认不挂载),或在 ${calProfilePatch} 覆盖 calendar 行 config 填 username(指引: npx gotry setup calendar --status)`,
        })

  // 7. LLM key:显式让渡给 dsh 宿主(founder 2026-09-02:doctor 不管 key)
  items.push({ id: 'llm-key', label: 'LLM key', status: 'ok', detail: '由 dsh 宿主 UI 管理——不在 doctor 体检范围(gotry 不接触、不回显凭证)' })

  const broken = items.filter(i => i.status !== 'ok' && i.id !== 'llm-key')
  const summary = broken.length === 0
    ? `体检通过:${items.length} 项全部就绪(可选依赖齐,LLM key 归 dsh 宿主管)。`
    : `体检发现 ${broken.length} 项待处理:${broken.map(i => `${i.label}(${i.status === 'missing' ? '未装' : '半可用'})`).join('、')}。补装:终端跑 npx gotry doctor --fix,或按各项 fix 指引逐项处理。`
  return { ok: broken.length === 0, items, summary }
}

/** 修复指引入表:命令类才加反引号(prose 类如「到控制台申请 key」原样) */
const fixCell = (fix?: string) => (!fix ? '—' : /^(npx|hbcli|curl|pip|python|\$)/.test(fix) ? `\`${fix}\`` : fix)

/** 报告 → 侧栏可预览 markdown(写盘由调用方决定;本函数纯渲染) */
export function renderDoctorReportMd(report: DoctorReport, now = new Date()): string {
  const icon = (s: DoctorStatus) => (s === 'ok' ? '✅' : s === 'degraded' ? '⚠️' : '❌')
  const lines = [
    '# GoTry 依赖体检报告(doctor)',
    '',
    `> 生成于 ${now.toISOString()};重新生成:终端 \`npx gotry doctor\`,或在对话里让助手调 gotry_doctor。`,
    '',
    '| 状态 | 依赖 | 现状 | 修复指引 |',
    '|---|---|---|---|',
    ...report.items.map(i => `| ${icon(i.status)} | ${i.label} | ${i.detail} | ${fixCell(i.fix)} |`),
    '',
    `**结论**:${report.summary}`,
    '',
    '---',
    '',
    '- `npx gotry doctor` 随时可重跑(只读,不改任何东西);',
    '- `npx gotry doctor --fix` 按上表补装(hbcli 官方脚本 / agent-reach pip / dsh-better-sidebar 插件);',
    '- LLM key 由 dsh 宿主 UI 管理,gotry 永不体检、不回显。',
    '',
  ]
  return lines.join('\n')
}
