/**
 * a2a-server.ts — gotry 的 A2A v1.0 子集入口(M2,PRD hotel-be docs/products/gotry-a2a-nl-booking-prd.md §5)。
 *
 * 形态:node:http 手写 JSON-RPC 2.0(零新依赖——与 extension-bridge 同先例);协议面:
 *   GET  /.well-known/agent-card.json      → Agent Card(技能 nl-hotel-booking)
 *   POST /a2a  message/send|tasks/get|tasks/cancel
 *       message/send params: { message: { parts: [{kind:'text', text}] }, metadata: { userToken } }
 *
 * 认证与身份(PRD §6 两枚旋钮):
 *   - 访问控制:Authorization: Bearer <GOTRY_A2A_API_KEY>;未配置 key 的非测试启动直接拒绝(fail-closed)
 *   - 用户身份:params.metadata.userToken 原样透传给 driver(env HOTELBYTE_TOKEN)——真校验在 hotel-be,
 *     gotry 不实现鉴权逻辑;driver 内 per-user 状态隔离(GOTRY_STATE_ROOT)。
 *
 * 任务生命周期:A2A 子集 submitted→working→(input-required 预留)/completed/failed/canceled;
 * 驱动可注入(Driver 接口:stub=离线确定性测试 / headless=spawn gotry-inner 真对话)。
 * message/stream(SSE):event 流 = status(submitted/working)→ final(产物)或 error;诚实流——
 * 不伪造 token 级增量,真对话增量在 headless driver 接线后由 driver 逐段供给(切片 3)。
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'

export type A2ATaskState = 'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'canceled'

export interface A2AArtifact { type: 'text'; text: string }

export interface A2ATask {
  id: string
  state: A2ATaskState
  createdAt: string
  updatedAt: string
  artifacts: A2AArtifact[]
  error?: string
  /** 诊断面:driver 是否收到透传的 userToken(只记布尔,不落 token 值) */
  userTokenSeen?: boolean
}

/** 会话驱动:stub(测试)与 headless(spawn inner)同接口 */
export type A2ADriver = (input: { text: string; userToken?: string }) => Promise<{ text: string }>

export interface A2AServerOptions {
  apiKey: string
  port?: number
  host?: string
  driver?: A2ADriver
  /** 测试注入:任务表(缺省进程内 Map) */
  tasks?: Map<string, A2ATask>
}

export function agentCard(baseUrl: string): Record<string, unknown> {
  return {
    name: 'gotry',
    description: 'AI travel agent: natural-language hotel search, rates, availability check and (confirmation-gated) booking on HotelByte',
    url: `${baseUrl}/a2a`,
    version: '0.1.0',
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text', 'data'],
    skills: [
      {
        id: 'nl-hotel-booking',
        name: 'Natural-language hotel booking',
        description: 'One sentence in, evidence-graded quote cards and saga-guarded confirmed bookings out (fail-closed price surface; writes only after explicit confirmation).',
        inputModes: ['text'],
        outputModes: ['text', 'data'],
      },
    ],
  }
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

/** headless driver 的环境装配(M2 切片 1 导出供测试断言;真对话 spawn 在切片 2 接线) */
export function buildHeadlessDriverEnv(userToken: string | undefined, stateRoot: string): Record<string, string> {
  const env: Record<string, string> = {
    GOTRY_STATE_ROOT: stateRoot,
    GOTRY_NO_CALENDAR: '1',
    GOTRY_ASK_STDIO: '0',
  }
  if (userToken) env.HOTELBYTE_TOKEN = userToken
  return env
}

export function startA2AServer(opts: A2AServerOptions): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  if (!opts.apiKey) return Promise.reject(new Error('GOTRY_A2A_API_KEY 未配置——A2A 入口 fail-closed 拒绝启动(测试请显式注入 apiKey)'))
  const tasks = opts.tasks ?? new Map<string, A2ATask>()
  const driver: A2ADriver = opts.driver ?? (async () => { throw new Error('A2A driver 未配置(headless 接线在 M2 切片 2)') })
  const now = () => new Date().toISOString()

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = String(req.url ?? '')
    try {
      if (req.method === 'GET' && url === '/.well-known/agent-card.json') {
        const host = String(req.headers.host ?? 'localhost')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(agentCard(`http://${host}`)))
        return
      }
      if (req.method === 'POST' && (url === '/a2a' || url === '/')) {
        const auth = String(req.headers.authorization ?? '')
        if (auth !== `Bearer ${opts.apiKey}`) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify(rpcError(null, -32001, 'unauthorized: A2A 入口要求 Bearer API key(部署级访问控制,PRD §6)')))
          return
        }
        const body = await readBody(req)
        let msg: Record<string, unknown>
        try { msg = JSON.parse(body) as Record<string, unknown> } catch { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(rpcError(null, -32700, 'parse error'))); return }
        if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(rpcError(msg.id ?? null, -32600, 'invalid request: jsonrpc 2.0 + method 必填')))
          return
        }
        const params = (msg.params ?? {}) as Record<string, unknown>
        if (msg.method === 'message/send' || msg.method === 'message/stream') {
          const a2aMessage = (params.message ?? {}) as { parts?: Array<{ kind?: string; text?: string }> }
          const text = (a2aMessage.parts ?? []).filter(p => p.kind === 'text').map(p => p.text ?? '').join('\n').trim()
          if (!text) {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify(rpcError(msg.id, -32602, 'invalid params: message.parts 需至少一个 {kind:"text"}')))
            return
          }
          const metadata = (params.metadata ?? {}) as { userToken?: string }
          const task: A2ATask = { id: randomUUID(), state: 'submitted', createdAt: now(), updatedAt: now(), artifacts: [] }
          tasks.set(task.id, task)
          const run = async (): Promise<void> => {
            task.state = 'working'
            task.updatedAt = now()
            try {
              const out = await driver({ text, userToken: metadata.userToken })
              task.userTokenSeen = metadata.userToken != null && metadata.userToken !== ''
              task.artifacts = [{ type: 'text', text: out.text }]
              task.state = 'completed'
            } catch (e) {
              task.error = String((e as Error).message ?? e)
              task.state = 'failed'
            }
            task.updatedAt = now()
          }
          if (msg.method === 'message/send') {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { taskId: task.id, state: task.state } }))
            void run()
            return
          }
          // message/stream:SSE 诚实流(status 状态帧 → final 产物帧 / error 帧),结束即关
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
          const sse = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: data })}\n\n`)
          sse('status', { taskId: task.id, state: 'submitted' })
          task.state = 'working'
          task.updatedAt = now()
          sse('status', { taskId: task.id, state: 'working' })
          await run()
          const finalState = task.state as A2ATaskState // run() 闭包内重赋值,TS 不追踪——显式宽化
          if (finalState === 'completed') sse('final', { taskId: task.id, state: 'completed', artifacts: task.artifacts })
          else sse('error', { taskId: task.id, state: 'failed', error: task.error })
          res.end()
          return
        }
        if (msg.method === 'tasks/get') {
          const id = String(params.id ?? '')
          const task = tasks.get(id)
          if (!task) {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify(rpcError(msg.id, -32002, `task not found: ${id}`)))
            return
          }
          const { userTokenSeen, ...rest } = task
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: rest }))
          return
        }
        if (msg.method === 'tasks/cancel') {
          const id = String(params.id ?? '')
          const task = tasks.get(id)
          if (!task) {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify(rpcError(msg.id, -32002, `task not found: ${id}`)))
            return
          }
          if (task.state === 'completed' || task.state === 'failed' || task.state === 'canceled') {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify(rpcError(msg.id, -32003, `task 已终态(${task.state}),不可取消`)))
            return
          }
          task.state = 'canceled'
          task.updatedAt = now()
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { taskId: task.id, state: task.state } }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(rpcError(msg.id, -32601, `method not found: ${msg.method}(子集: message/send|message/stream|tasks/get|tasks/cancel)`)))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: String((e as Error).message ?? e) }))
    }
  })

  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 0)
      resolve({
        server, port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}

/** CLI 入口:GOTRY_A2A_API_KEY 必填;GOTRY_A2A_PORT 可选(默认 3081) */
if (process.argv[1] && process.argv[1].endsWith('a2a-server.ts') && !process.env.GOTRY_A2A_TEST_CHILD) {
  const apiKey = process.env.GOTRY_A2A_API_KEY ?? ''
  if (!apiKey) {
    console.error('[gotry-a2a] 缺 GOTRY_A2A_API_KEY——A2A 入口 fail-closed 拒绝启动(部署级访问控制)')
    process.exit(1)
  }
  const port = Number(process.env.GOTRY_A2A_PORT ?? 3081)
  void startA2AServer({ apiKey, port }).then(({ port: p }) => {
    console.log(`[gotry-a2a] listening on http://127.0.0.1:${p} (card: /.well-known/agent-card.json; rpc: POST /a2a)`)
  })
}
