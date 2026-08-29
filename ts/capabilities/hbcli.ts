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
  // 降级:读静态包
  const fallback = opts.fallbackPath
  if (fallback) {
    try {
      const { readFile } = await import('node:fs/promises')
      const pack = JSON.parse(await readFile(fallback, 'utf-8')) as Record<string, unknown>
      return {
        ...live,
        hotels: pack,
        summary: `${query.destination}:hbcli 实时源不可用(${reason}),已降级到静态包(公开渠道估算,非实时)`,
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
