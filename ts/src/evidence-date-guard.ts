/**
 * 证据日期绑定闸(rc.33 行程实测 2026-11-01;ADR-19 §8.19 的强制执行面)。
 *
 * gotry_fact_gate 是模型「应当」调用的工具:rc.33 那一轮过了 TURN_DEADLINE_SOFT,模型没调
 * 闸就 write + present 了行程,两条午夜前后的红眼航班带着 ✅ 写到了从未查询过的日期上
 * (QR1019 用 11/30 的行情写成 12/1;EK329 用 12/16 00:45 的行情写成 12/17)。
 *
 * 本闸挂在 dsh 的 tools/pre-execute 瀑布上,只看两个原生工具的文档类产物(md/markdown/
 * html/htm/txt):write 看即将写入的内容,present 看即将交付的文件(按会话工作目录解析,
 * ≤2 MiB)。判定只用 evidence-date-binding.ts 的 checkEvidenceDateBinding(gotry_fact_gate
 * 报告里并入的同一实现):标 ✅/实证、带事实锚点或写明票价的航班行,必须引用同号、同一
 * 出发日的可下单事实;违例即 deny(info.code=EVIDENCE_DATE_BINDING),理由逐行点名。
 *
 * 截止模式:pre-execute 先于 turn-deadline 的 tools/execute 且不看时钟,截止后 present 仍可
 * 调用,所以本闸照样生效;被拒的 write 不占截止闸那一次写入额度(额度在 tools/execute 里预留)。
 *
 * 不在本闸:其余断言(政策/酒店/联程/时刻/航线)归 gotry_fact_gate;edit/bash 产生的文件在
 * present 时把关;最终聊天回复不经过本闸。
 */

import { readFile, stat } from 'node:fs/promises'
import { extname, isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { loadFactRegistry } from '../capabilities/fact-log.ts'
import type { AirlineAirportMap } from './artifact-gate.ts'
import { checkEvidenceDateBinding, FLIGHT_NO_SHAPE, htmlToGateText, type EvidenceDateViolation } from './evidence-date-binding.ts'
import { ymd } from './time-anchor.ts'

export const EVIDENCE_DATE_BINDING = 'EVIDENCE_DATE_BINDING'

const DOC_EXTENSIONS = new Set(['.md', '.markdown', '.html', '.htm', '.txt'])
const MAX_DOC_BYTES = 2 * 1024 * 1024
const MAX_LISTED = 8
/** 映射表缺失时只少了航线上下文;日期绑定按航班号 + 出发日照常判定 */
const EMPTY_MAP: AirlineAirportMap = { meta: { as_of: '' }, city_alias: {}, carrier_airport: {} }

export interface EvidenceDateGuardOptions {
  stateRoot: string
  loadMap: () => Promise<AirlineAirportMap | null>
  /** 宿主时钟(测试注入);无年份的「12/1」取今天当天或之后最近的一次 */
  clock?: () => Date
}

interface Doc { path: string; text: string }

function isDocPath(path: string): boolean {
  return DOC_EXTENSIONS.has(extname(path).toLowerCase())
}

function gateText(doc: Doc): string {
  return /\.html?$/i.test(doc.path) ? htmlToGateText(doc.text) : doc.text
}

async function docsOf(exec: ToolExecution): Promise<Doc[]> {
  const args = exec.arguments as Record<string, unknown> | null | undefined
  if (!args || typeof args !== 'object') return []
  if (exec.name === 'write') {
    const { file_path: path, content } = args
    return typeof path === 'string' && typeof content === 'string' && isDocPath(path) ? [{ path, text: content }] : []
  }
  const cwd = (exec.agent as { session?: { header?: { cwd?: unknown } } } | undefined)?.session?.header?.cwd
  const docs: Doc[] = []
  for (const file of Array.isArray(args.files) ? args.files : []) {
    const path = (file as { path?: unknown } | null)?.path
    if (typeof path !== 'string' || path.trim() === '' || !isDocPath(path)) continue
    const target = isAbsolute(path) ? path : typeof cwd === 'string' ? resolve(cwd, path) : undefined
    if (!target) continue
    try {
      const info = await stat(target)
      if (info.isFile() && info.size <= MAX_DOC_BYTES) docs.push({ path, text: await readFile(target, 'utf-8') })
    } catch {
      // 找不到/不是文件由 present 自己报错,本闸不吞错误
    }
  }
  return docs
}

function denialReason(toolName: string, findings: Array<{ doc: Doc; text: string; v: EvidenceDateViolation }>): string {
  const files = [...new Set(findings.map(f => f.doc.path))]
  const listed = findings.slice(0, MAX_LISTED).map(({ doc, text, v }) => {
    const row = (text.split('\n')[v.line - 1] ?? '').trim().slice(0, 48)
    return `- ${doc.path} L${v.line}${/\.html?$/i.test(doc.path) ? '(HTML 文本投影)' : ''}「${row}」[${v.kind}] ${v.detail}`
  })
  const more = findings.length > MAX_LISTED ? `\n…另有 ${findings.length - MAX_LISTED} 处` : ''
  return `${EVIDENCE_DATE_BINDING}: 拒绝${toolName === 'write' ? '写入' : '交付'} ${files.join('、')}——${findings.length} 处航班行的证据日期与行程日期对不上`
    + '(标 ✅/实证、带事实锚点或写明票价的航班行,必须引用同号、同一出发日的可下单事实):\n'
    + `${listed.join('\n')}${more}\n`
    + '修正:改成该日期实际查到的事实(班次/时刻/票价取自同一出发日的 exact-date 结果),或把行移到事实真正的出发日期下,'
    + '或去掉 ✅/实证 并标「未核验」;同一航班在骨架/结论/下一步里的其他写法一并改。不得用相邻日期的查询结果填充。'
}

/** 安装证据日期绑定闸(产品路径;benchmark 内核不装)。 */
export function installEvidenceDateGuard(ctx: Context, options: EvidenceDateGuardOptions): void {
  if (typeof (ctx as unknown as { on?: unknown }).on !== 'function') return
  const clock = options.clock ?? (() => new Date())
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if ((exec.name !== 'write' && exec.name !== 'present') || !exec.agent) return next()
    // 便宜的预筛:没有航班号形状 token 的文本不读注册表
    const docs = (await docsOf(exec)).filter(doc => FLIGHT_NO_SHAPE.test(doc.text))
    if (docs.length === 0) return next()
    const [facts, map] = await Promise.all([loadFactRegistry(options.stateRoot), options.loadMap()])
    const today = ymd(clock())
    const findings = docs.flatMap(doc => {
      const text = gateText(doc)
      return checkEvidenceDateBinding(text, facts, map ?? EMPTY_MAP, { today }).map(v => ({ doc, text, v }))
    })
    if (findings.length === 0) return next()
    return { kind: 'deny', reason: denialReason(exec.name, findings), info: { name: 'EvidenceDateBinding', code: EVIDENCE_DATE_BINDING } }
  })
}
