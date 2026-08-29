/**
 * hotelbyte-cli(hbcli)能力层封装:进程内 spawn bun + hbcli --json。
 *
 * 拿到外部资源信息能力的三条路径:
 *   1. 实时 hbcli 调用(能力强,延迟 1-3s,需凭证 + 证书有效)
 *   2. 静态数据包(data/hotels_2026.json)——证据标注 [静态包:估算]
 *   3. 简易降级返回(什么都不查得到时,提供"工具暂不可用"而不是抛错)
 *
 * 证书/凭证/网络问题一律降级,不抛到调用方——能力层契约:永远返回一种结果。
 *
 * §7-1/§7-2 L4 不变量:证据链标注([实时API:hbcli@<ts>] / [静态包:估算]);
 * 估算必须显式标记。这是 L4 与 L1 透明卡片的接缝。
 */

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface HbcliCallOptions {
  /** hbcli 二进制路径(默认 'hbcli',依赖 PATH;~/.local/bin 等已知安装位自动回退) */
  hbcliBin?: string
  /** 超时(ms) */
  timeoutMs?: number
  /** 凭证(token)——空时不传,hbcli 用本地默认 */
  token?: string
  /** 环境(uat/prod/dev);默认 uat */
  env?: 'uat' | 'prod' | 'dev'
}

export interface HbcliCallResult {
  /** 是否走了实时 hbcli */
  via: 'hbcli-realtime' | 'hbcli-cache' | 'hbcli-error'
  /** hbcli 退码 0=成功 */
  exitCode: number
  /** 解析后的 JSON(若 --json 模式输出可解析;否则为空) */
  result: unknown
  /** 证据链标注(L4 契约;无论成功失败都填) */
  evidence: string
  /** hbcli 原始 stdout/stderr(供调试,2000 字符上限) */
  stdout?: string
  stderr?: string
  /** 经过的时长 */
  latencyMs: number
  /** 错误时降级原因 */
  error?: string
}

/**
 * hbcli 二进制候选路径(gotry setup 按官方脚本装到 ~/.local/bin/hbcli,
 * symlink 指向 ~/.staicli/current/hbcli——当 PATH 不含 ~/.local/bin 时裸名
 * spawn 仍 ENOENT,按已知安装位回退)。仅对默认名 'hbcli' 扩展;显式自定义
 * 名(如测试注入的不存在路径)不扩展,保持配置即所用的可测性。
 */
export function hbcliBinCandidates(bin: string, homeDir: string = homedir()): string[] {
  if (bin !== 'hbcli') return [bin]
  return [bin, join(homeDir, '.local/bin/hbcli'), join(homeDir, '.staicli/current/hbcli')]
}

/** 单个候选的一次 spawn 封装:失败不抛,返回降级结果(spawnError 标记 ENOENT 类失败供上层换候选) */
function attemptHbcli(
  bin: string,
  args: string[],
  opts: Required<Pick<HbcliCallOptions, 'timeoutMs' | 'env'>> & { envVars: Record<string, string> },
): Promise<HbcliCallResult & { spawnError?: boolean }> {
  const started = Date.now()
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = spawn(bin, args, { env: { ...process.env, ...opts.envVars } })
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill('SIGKILL')
        resolve({
          via: 'hbcli-error', exitCode: -1, result: null,
          evidence: `[实时API:hbcli@timeout@${new Date().toISOString()}]`,
          latencyMs: Date.now() - started, error: `timeout after ${opts.timeoutMs}ms`,
        })
      }
    }, opts.timeoutMs)
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const latencyMs = Date.now() - started
      if (code !== 0) {
        // 不抛错,降级返回。证据链显式标注:实时 API 调用失败+原因+时间戳。
        resolve({
          via: 'hbcli-error', exitCode: code ?? -1, result: null,
          evidence: `[实时API:hbcli@error@${new Date().toISOString()}]`,
          stderr: stderr.slice(0, 2000),
          latencyMs, error: stderr.trim().slice(0, 200) || `exit ${code}`,
        })
        return
      }
      // 尝试 JSON 解析
      const jStart = stdout.search(/[\{\[]/)
      const jsonStr = jStart >= 0 ? stdout.slice(jStart) : ''
      let result: unknown = null
      if (jsonStr) {
        try { result = JSON.parse(jsonStr) } catch { /* 非 JSON 输出,留给调用方处理 */ }
      }
      resolve({
        via: 'hbcli-realtime', exitCode: 0, result,
        evidence: `[实时API:hbcli@${new Date().toISOString()}]`,
        stdout: stdout.slice(0, 2000), latencyMs,
      })
    })
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // ENOENT (二进制不存在) 等也走降级路径;spawnError 供上层按候选路径重试
      resolve({
        via: 'hbcli-error', exitCode: -1, result: null,
        evidence: `[实时API:hbcli@spawn_error@${new Date().toISOString()}]`,
        latencyMs: Date.now() - started, error: (e as Error).message, spawnError: true,
      })
    })
  })
}

/** 通用 hbcli JSON 调用封装:失败不抛,而是返回降级结果 */
export async function callHbcliJson(
  args: string[],
  opts: HbcliCallOptions = {},
): Promise<HbcliCallResult> {
  const env = opts.env ?? 'uat'
  const envVars: Record<string, string> = { HOTELBYTE_ENV: env }
  if (opts.token) envVars['HOTELBYTE_TOKEN'] = opts.token
  const callOpts = { timeoutMs: opts.timeoutMs ?? 15_000, env, envVars }
  const candidates = hbcliBinCandidates(opts.hbcliBin ?? 'hbcli')
  let last: HbcliCallResult & { spawnError?: boolean } | undefined
  for (const bin of candidates) {
    last = await attemptHbcli(bin, args, callOpts)
    // spawn 级失败(ENOENT 等)且还有候选 → 换下一个已知安装位;其余失败(退码/超时)无重试意义
    if (!(last.spawnError && candidates.indexOf(bin) < candidates.length - 1)) return last
  }
  return last!
}

/** 高层语义化封装:酒店列表查询(down-tier to 静态包 + 证据链标注) */
export async function searchHotels(
  query: { destination: string; checkIn?: string; checkOut?: string; adults?: number },
  opts: HbcliCallOptions & { fallbackPath?: string } = {},
): Promise<HbcliCallResult & { hotels?: unknown; summary: string }> {
  // 旗标对齐上游 CLI v0.3.0(命令树扁平化后):--destination-name + --room-occupancies;
  // hotel-list 无日期旗标(房价按上游当前窗口),checkIn/checkOut 留给 hotel-rates 跟进
  const hbArgs = ['search', 'hotel-list', '--json', '--page-size', '10']
  if (query.destination) hbArgs.push('--destination-name', query.destination)
  if (query.adults) hbArgs.push('--room-occupancies', JSON.stringify([{ adultCount: query.adults, childrenAges: [] }]))
  const live = await callHbcliJson(hbArgs, opts)
  if (live.via === 'hbcli-realtime') {
    return { ...live, hotels: live.result, summary: `${query.destination}:hbcli 实时返回${query.checkIn || query.checkOut ? '(日期不传上游 list,以当前窗口房价返回)' : ''}` }
  }
  // 降级原因人话化(issue #24):hbcli 未安装时按 gotry setup 指引(npm 安装期已
  // 自动跑过官方脚本;PATH 未含 ~/.local/bin 时上方候选路径也已兜住),
  // 裸 "spawn hbcli ENOENT" 读起来像工具坏了——实际静态包降级是设计行为
  const rawReason = live.error ?? live.via
  const reason = /ENOENT/i.test(rawReason) ? '未安装 hbcli(可选实时源;npx gotry setup 可按官方脚本安装)' : rawReason
  // 降级:读静态包,按目的地过滤命中的住宿块(issue #24)——整包倾倒会把无关场景
  // (深圳/普吉/曼谷/云南/大理混装)灌给模型且不指明哪块相关;包内无该目的地时明示
  // 「无数据」而不是伪装成可用结果。
  const fallback = opts.fallbackPath
  if (fallback) {
    try {
      const { readFile } = await import('node:fs/promises')
      const pack = JSON.parse(await readFile(fallback, 'utf-8')) as { stays?: unknown[] } & Record<string, unknown>
      const kw = query.destination.trim()
      const stays = Array.isArray(pack.stays) ? pack.stays : []
      const matched = kw ? stays.filter(s => JSON.stringify(s).includes(kw)) : stays
      if (matched.length) {
        return {
          ...live,
          hotels: { stays: matched },
          summary: `${query.destination}:hbcli 实时源不可用(${reason}),已降级到静态包(公开渠道估算,非实时),命中 ${matched.length} 个住宿块`,
        }
      }
      return {
        ...live,
        hotels: null,
        summary: `${query.destination}:hbcli 实时源不可用(${reason}),且静态包无「${query.destination}」住宿数据(静态包仅覆盖内置场景)`,
      }
    } catch { /* 静态包读不到也优雅降级 */ }
  }
  return { ...live, summary: `${query.destination}:hbcli 实时源不可用(${reason})且无静态包(仅返回错误)` }
}

/** 高层语义化封装:目的地列表(无数据依赖,通常 hbcli dest 命令可独立调通) */
export async function listDestinations(opts: HbcliCallOptions = {}): Promise<HbcliCallResult & { destinations?: unknown }> {
  const r = await callHbcliJson(['search', 'destinations', '--json'], opts)
  return { ...r, destinations: r.result }
}

/**
 * 高层语义化封装:房型报价(hotel-rates;上游 hotelRates 创建后端 session,
 * 产出带 RatePkgId 的房型列表——check-avail 与 book 的入参来源)。
 *
 * 价格面无静态降级(fail-closed):hotel-list 的静态包降级是定性住宿信息,
 * 房价是钱——估算价格冒充实时价是红线;不可用就诚实失败,证据链标注,
 * 与 bookable-facts 证据分级(live_inventory 才可进确认卡)同口径。
 */
export async function hotelRates(
  query: {
    hotelId: string
    checkIn?: string
    checkOut?: string
    adults?: number
    countryCode?: string
    nationalityCode?: string
    residencyCode?: string
  },
  opts: HbcliCallOptions = {},
): Promise<HbcliCallResult & { rates?: unknown; summary: string }> {
  const hbArgs = ['search', 'hotel-rates', '--json', '--hotel-id', query.hotelId]
  if (query.checkIn) hbArgs.push('--check-in', query.checkIn)
  if (query.checkOut) hbArgs.push('--check-out', query.checkOut)
  if (query.countryCode) hbArgs.push('--country-code', query.countryCode)
  if (query.nationalityCode) hbArgs.push('--nationality-code', query.nationalityCode)
  if (query.residencyCode) hbArgs.push('--residency-code', query.residencyCode)
  if (query.adults) hbArgs.push('--room-occupancies', JSON.stringify([{ adultCount: query.adults, childrenAges: [] }]))
  const live = await callHbcliJson(hbArgs, opts)
  const summary = live.via === 'hbcli-realtime'
    ? `hotel ${query.hotelId}:hbcli 实时报价${query.checkIn ? `(${query.checkIn} → ${query.checkOut ?? '?'})` : ''}`
    : `hotel ${query.hotelId}:hbcli 实时报价不可用(${live.error ?? live.via});价格面无静态降级,fail-closed 不估算`
  return { ...live, rates: live.result, summary }
}

/** 高层语义化封装:下单前实时验价(check-avail;入参 RatePkgId 来自 hotel-rates 产物)。价格面同上:不可用即诚实失败。 */
export async function checkAvail(
  query: { ratePkgId: string },
  opts: HbcliCallOptions = {},
): Promise<HbcliCallResult & { avail?: unknown; summary: string }> {
  const live = await callHbcliJson(['search', 'check-avail', '--json', '--rate-pkg-id', query.ratePkgId], opts)
  const summary = live.via === 'hbcli-realtime'
    ? `ratePkg ${query.ratePkgId}:hbcli 实时验价(库存与价格以后端为准)`
    : `ratePkg ${query.ratePkgId}:hbcli 实时验价不可用(${live.error ?? live.via});价格面无静态降级,fail-closed`
  return { ...live, avail: live.result, summary }
}

/**
 * 高层语义化封装:下单(spawn trade book)。原始通道面——**只被 saga 编排层调用**,
 * 工具层不得直调(写效应红线:预订写必须过 booking_saga_fsm.v1 边表,ADR-17/ADR-18)。
 * 金额不入参:价格权威在后端 check-avail session,CLI 只传 ratePkgId+人证+幂等键。
 */
export async function bookHotel(
  query: {
    ratePkgId: string
    holder: Record<string, unknown>
    guests: Array<Record<string, unknown>>
    customerReferenceNo: string
    confirmDuplicate?: boolean
    duplicateReason?: string
  },
  opts: HbcliCallOptions = {},
): Promise<HbcliCallResult & { book?: unknown; summary: string }> {
  const hbArgs = ['trade', 'book', '--json', '--rate-pkg-id', query.ratePkgId,
    '--holder', JSON.stringify(query.holder), '--guests', JSON.stringify(query.guests),
    '--customer-reference-no', query.customerReferenceNo]
  if (query.confirmDuplicate) hbArgs.push('--confirm-duplicate')
  if (query.duplicateReason) hbArgs.push('--duplicate-reason', query.duplicateReason)
  const live = await callHbcliJson(hbArgs, opts)
  const summary = live.via === 'hbcli-realtime'
    ? `book ${query.ratePkgId.slice(0, 24)}…:hbcli 实时下单已提交(幂等键 ${query.customerReferenceNo})`
    : `book:hbcli 下单不可用(${live.error ?? live.via});写面无降级,未产生订单`
  return { ...live, book: live.result, summary }
}
