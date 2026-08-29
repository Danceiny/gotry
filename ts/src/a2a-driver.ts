/**
 * a2a-driver.ts — A2A 入口的 headless 真对话 driver(M2 收口件)。
 *
 * 每条消息 spawn 一次 `bin/gotry-inner.js "<任务>"`(dsh headless 一问一答):
 *   - 用户身份:metadata.userToken → env HOTELBYTE_TOKEN(staicli PR#4 后直连生效);
 *   - 状态隔离:per-user 稳定 stateRoot(userToken 哈希派生,跨消息保留会话产物;
 *     匿名调用共享 anon 根)——不触 founder 真实 gotry-state(巡检纪律);
 *   - 凭证映射:LLM_API_KEY → DEEPSEEK_API_KEY(复刻 ./gotry 包装的一行语义,
 *     因为 driver 直 spawn inner 不经包装);
 *   - 诚实失败:key 缺失/无效、通道失败 → 抛错进任务 failed 态(不伪装应答)。
 * 活体验证被 LLM key 门控:当前部署 key 失效时任务将以「鉴权失败」failed——
 * 这本身就是本 driver 的正确行为(§40 第 11 断言固化该形态)。
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildHeadlessDriverEnv, type A2ADriver } from './a2a-server.ts'

export interface HeadlessDriverOptions {
  /** inner 入口(缺省仓库内 bin/gotry-inner.js) */
  innerPath?: string
  timeoutMs?: number
  /** per-user 状态根基目录(缺省 tmpdir/gotry-a2a-state) */
  stateBase?: string
  /** 测试注入:当前进程 env 快照(缺省 process.env) */
  env?: Record<string, string | undefined>
}

/** per-user 稳定 stateRoot(匿名共享 anon;只取哈希,不落 token 值) */
export function userStateRoot(stateBase: string, userToken?: string): string {
  const tag = userToken ? createHash('sha256').update(userToken).digest('hex').slice(0, 12) : 'anon'
  const root = join(stateBase, `u-${tag}`)
  mkdirSync(root, { recursive: true })
  return root
}

export function makeHeadlessDriver(opts: HeadlessDriverOptions = {}): A2ADriver {
  const innerPath = opts.innerPath ?? join(import.meta.dirname, '..', '..', 'bin', 'gotry-inner.js')
  const timeoutMs = opts.timeoutMs ?? 240_000
  const stateBase = opts.stateBase ?? join(tmpdir(), 'gotry-a2a-state')
  return async ({ text, userToken }) => {
    const stateRoot = userStateRoot(stateBase, userToken)
    const baseEnv = opts.env ?? process.env as Record<string, string | undefined>
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(baseEnv)) if (v !== undefined) env[k] = v
    Object.assign(env, buildHeadlessDriverEnv(userToken, stateRoot))
    if (!env.DEEPSEEK_API_KEY && env.LLM_API_KEY) env.DEEPSEEK_API_KEY = env.LLM_API_KEY
    return await new Promise<{ text: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [innerPath, text], { env })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`headless 对话超时(${timeoutMs}ms)`)) }, timeoutMs)
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0 && stdout.trim()) resolve({ text: stdout.trim() })
        else reject(new Error(`headless 对话失败(exit ${code}):${(stderr.trim() || stdout.trim()).slice(0, 200)}`))
      })
      child.on('error', (e) => { clearTimeout(timer); reject(new Error(`headless spawn 失败:${(e as Error).message}`)) })
    })
  }
}
