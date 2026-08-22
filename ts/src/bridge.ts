/**
 * Python 可行性引擎桥:TS 侧唯一入口契约是 CLI(stdin JSON → stdout JSON)。
 *
 * 桥接面纪律(总纲 3.3):TS 主体、Python 侧经子进程 JSON 桥,
 * 每次调用计量延迟——「桥接面收敛为两个插件」的成本数据就在这里积累。
 */

import { spawn } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface BridgeOptions {
  /** Python 解释器(venv 内的 python) */
  pythonBin: string
  /** gotry_feasibility.cli 的模块路径(PYTHONPATH 根,即仓库 py/ 目录) */
  pythonPath: string
  /** 单次调用超时(ms) */
  timeoutMs: number
}

export interface BridgeCall {
  /** 引擎判定结果(JSON 反序列化后原样返回) */
  result: unknown
  /** 桥接延迟(子进程全生命周期,ms) */
  latencyMs: number
}

function waitExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve) => { child.once('exit', (code) => resolve(code)) })
}

export async function callFeasibilityEngine(
  payload: unknown,
  opts: BridgeOptions,
): Promise<BridgeCall> {
  const started = Date.now()
  const child = spawn(opts.pythonBin, ['-m', 'gotry_feasibility.cli'], {
    env: { ...process.env, PYTHONPATH: opts.pythonPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout!.on('data', (d: Buffer) => { stdout += d.toString() })
  child.stderr!.on('data', (d: Buffer) => { stderr += d.toString() })

  const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs)
  try {
    child.stdin!.write(JSON.stringify(payload))
    child.stdin!.end()
    const code = await waitExit(child)
    if (code !== 0) {
      throw new Error(`feasibility engine exited ${code}: ${stderr.slice(0, 2000)}`)
    }
    const jsonStart = stdout.indexOf('{')
    if (jsonStart < 0) throw new Error(`engine output not JSON: ${stdout.slice(0, 200)}`)
    return { result: JSON.parse(stdout.slice(jsonStart)), latencyMs: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

/** 桥接延迟日志(追加式;T5 成本工程的度量数据源之一)。 */
export async function recordLatency(logPath: string, latencyMs: number, kind: string): Promise<void> {
  await appendFile(logPath, JSON.stringify({ ts: new Date().toISOString(), kind, latencyMs }) + '\n')
}

/** 状态目录:动机画像 / wish pool 的落盘位置(红线 6:用户数据可见、可编辑、可删除)。 */
export async function ensureStateDir(root: string): Promise<string> {
  const dir = join(root, 'gotry-state')
  await mkdir(dir, { recursive: true })
  return dir
}

export async function readJson(path: string, fallback: unknown): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf-8'))
  } catch {
    return fallback
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf-8')
}
