/**
 * GoTry 桥接工具集(纯 Node 版,无 Python 依赖):
 *   - ensureStateDir: 状态目录创建
 *   - recordLatency: 延迟日志追加
 *   - readJson / writeJson: JSON 文件安全读写
 *
 * 历史:曾有 callFeasibilityEngine 用 spawn(.venv/bin/python) 起 Python CLI,
 * 作为 TS 求解的回退路径。D-7 切轨后 unified solveChoiceSegment 是唯一求解入口,
 * Python oracle 路径于 v0.0.1-rc.2 移除——npm 一键分发不再需要 Python 运行时依赖。
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 状态目录:动机画像 / wish pool 的落盘位置(红线 6:用户数据可见、可编辑、可删除) */
export async function ensureStateDir(root: string): Promise<string> {
  const dir = join(root, 'gotry-state')
  await mkdir(dir, { recursive: true })
  return dir
}

/** JSON 安全读取:文件不存在返回 fallback,解析失败抛错 */
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const text = await readFile(path, 'utf-8')
    return JSON.parse(text) as T
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw e
  }
}

/** JSON 原子写入 */
export async function writeJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8')
  const { rename } = await import('node:fs/promises')
  await rename(tmp, path)
}

/** 桥接延迟日志(追加式;T5 成本工程的度量数据源之一) */
export async function recordLatency(logPath: string, latencyMs: number, kind: string): Promise<void> {
  await appendFile(logPath, JSON.stringify({ ts: new Date().toISOString(), kind, latencyMs }) + '\n')
}
