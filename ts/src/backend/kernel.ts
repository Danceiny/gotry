/**
 * gotry-backend 内核(2026-09-10,founder 口径:「我只允许一个 gotry 包装出来的服务」)。
 *
 * 形态:一个 HTTP 服务面 + 模块注册表。模块(gotry 能力单元)以 {method,path,handle}
 * 精确路由表挂载,内核只做分发/404/异常隔离——鉴权、探活、schema 校验全部归模块
 * 自持(模块行为即其独立部署形态的行为,挂载前后逐字一致)。
 * 现有模块:booking-copilot(booking surface 能力)、session-search(账号会话检索)。
 * gotry-a2a 是本服务的 A2A 协议端口,不是独立服务(迁移归部署收敛批次)。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

export interface BackendRoute {
  method: string
  path: string
  handle(req: IncomingMessage, res: ServerResponse): Promise<void> | void
}

export interface BackendModule {
  name: string
  routes: BackendRoute[]
  close?(): Promise<void>
}

export interface BackendServerOptions {
  modules: BackendModule[]
  host?: string
  port?: number
}

export interface BackendServerHandle {
  server: Server
  port: number
  moduleNames: string[]
  close(): Promise<void>
}

export function createBackendServer(options: BackendServerOptions): Promise<BackendServerHandle> {
  const table = new Map<string, BackendRoute>()
  for (const module of options.modules) {
    for (const route of module.routes) {
      const key = `${route.method} ${route.path}`
      if (table.has(key)) throw new Error(`gotry_backend_route_conflict: ${key}`)
      table.set(key, route)
    }
  }
  const server = createServer(async (req, res) => {
    const urlPath = (req.url ?? '').split('?')[0]
    const route = table.get(`${req.method} ${urlPath}`)
    if (!route) {
      res.statusCode = 404
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: { code: 'not_found' } }))
      return
    }
    try {
      await route.handle(req, res)
    } catch (error) {
      // 模块内部异常不拖垮服务面;若响应已开头只能断连(调用方超时语义兜底)
      if (!res.headersSent) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: { code: 'gotry_backend_module_error', module: route ? 'module' : 'kernel' } }))
      } else {
        res.destroy()
      }
      process.stderr.write(`[gotry-backend] module=${moduleErrorName(options.modules, route)} route=${req.method} ${urlPath} failed: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : (options.port ?? 0)
      resolve({
        server,
        port,
        moduleNames: options.modules.map((m) => m.name),
        close: () => new Promise<void>((done, fail) => server.close((error) => error ? fail(error) : done())),
      })
    })
  })
}

function moduleErrorName(modules: BackendModule[], route: BackendRoute | undefined): string {
  if (!route) return 'unknown'
  for (const m of modules) {
    if (m.routes.includes(route)) return m.name
  }
  return 'unknown'
}

/** 关闭全部模块 + 服务面(单模块 close 失败不阻断其余回收,最后聚合抛出) */
export async function closeBackend(handle: BackendServerHandle, modules: BackendModule[]): Promise<void> {
  const errors: unknown[] = []
  for (const module of modules) {
    if (!module.close) continue
    try {
      await module.close()
    } catch (error) {
      errors.push(error)
    }
  }
  try {
    await handle.close()
  } catch (error) {
    errors.push(error)
  }
  if (errors.length > 0) throw new AggregateError(errors, 'gotry_backend_close_failed')
}
