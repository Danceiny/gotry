/**
 * GoTry 薄壳 v0 服务(零依赖:node 内建 http)——M3 方向 B 的最轻起点。
 * 三条路由:/ (界面) | POST /chat (经 LlmPort 真 LLM 对话) | GET /state (TripState)
 * 运行:cd ts && npx tsx ../shell/server.ts(或 ./gotry shell)
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

// .env 加载(仓根)
try {
  for (const line of readFileSync(join(import.meta.dirname, '..', '.env'), 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
} catch { /* 可选 */ }

// dsh-llm 的 MODEL/BASE 常量在模块加载时读 env——必须先设好再 dynamic import
const { newState, runTurn } = await import(join(import.meta.dirname, '..', 'ts', 'src', 'loop.ts'))
const { createOpenAICompatLlm } = await import(join(import.meta.dirname, '..', 'ts', 'src', 'dsh-llm.ts'))
const { solveUnified } = await import(join(import.meta.dirname, '..', 'ts', 'src', 'unified.ts'))
const { join: j } = await import('node:path')

const llm = createOpenAICompatLlm(j(import.meta.dirname, '..', 'data', 'flights_2026.json'))
// 会话持久化(段4):TripState+history 落盘,重启恢复(用户数据红线:可见可删)
const STATE_FILE = join(import.meta.dirname, 'gotry-state', 'session.json')
async function loadSession(): Promise<{ state: ReturnType<typeof newState>; history: Array<{ role: 'user' | 'assistant'; text: string }> }> {
  try {
    const raw = JSON.parse(await readFile(STATE_FILE, 'utf-8'))
    return { state: raw.state as never, history: raw.history ?? [] }
  } catch {
    return { state: newState(), history: [] }
  }
}
async function saveSession(): Promise<void> {
  const { mkdir, writeFile: wf } = await import('node:fs/promises')
  await mkdir(join(import.meta.dirname, 'gotry-state'), { recursive: true })
  await wf(STATE_FILE, JSON.stringify({ state, history, savedAt: new Date().toISOString() }, null, 2))
}
const restored = await loadSession()
const state = restored.state
const history = restored.history

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // CORS + JSON 工具
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify(body))
  }

  if (req.method === 'GET' && req.url === '/') {
    const html = await readFile(join(import.meta.dirname, 'index.html'), 'utf-8')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(html)
  }

  if (req.method === 'GET' && req.url === '/state') {
    return json(200, { profile: state.profile, wishes: state.wishes, gates: state.gates, calendar: state.calendar, session: { historyTurns: Math.floor(history.length / 2), lastAt: history.length ? history[history.length - 1].text.slice(0, 80) : null } })
  }

  if (req.method === 'POST' && req.url === '/chat') {
    let body = ''
    for await (const chunk of req) body += chunk
    const { message } = JSON.parse(body) as { message: string }
    if (!message) return json(400, { reply: '空消息' })
    try {
      const { reply } = await runTurn(state, message, llm, [...history], solveUnified as never)
      history.push({ role: 'user', text: message }, { role: 'assistant', text: reply })
      await saveSession()
      return json(200, { reply })
    } catch (e) {
      return json(500, { reply: `引擎错误:${(e as Error).message.slice(0, 200)}` })
    }
  }

  res.writeHead(404)
  res.end('not found')
})

const PORT = Number(process.env['GOTRY_PORT'] ?? 4080)
server.listen(PORT, () => {
  console.log(`GoTry 薄壳: http://127.0.0.1:${PORT}(对话/下一次出发/动机画像三页;Ctrl+C 退出)`)
})
