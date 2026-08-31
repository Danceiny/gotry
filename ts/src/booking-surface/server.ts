/**
 * BFF-only HTTP/SSE seam for the embedded Booking Copilot.
 *
 * The browser never calls this server directly. A same-origin HotelByte BFF
 * authenticates the actor, mints contextRef and sends a strict planner turn
 * with a deployment-level Bearer key. No portal token field exists here.
 */

import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  BOOKING_SURFACE_SCHEMA_SHA256,
  BOOKING_SURFACE_SCHEMA_SHA256_HEADER,
  BOOKING_SURFACE_SCHEMA_VERSION,
  BOOKING_SURFACE_VERSION_HEADER,
  type BookingCopilotTurnV1,
  type BookingReadActionV1,
  type BookingSurfaceEventV1,
} from './contracts.ts'
import {
  BookingCopilotTaskRuntime,
  type BookingCopilotTaskStateV1,
  type BookingSurfaceEventDraftV1,
} from './runtime.ts'
import { validateBookingCopilotTurnV1 } from './validation.ts'

export type BookingPlannerDecisionV1 =
  | { kind: 'operation'; action: BookingReadActionV1 }
  | BookingSurfaceEventDraftV1

export interface BookingPlannerSessionV1 {
  next(input: {
    turn: BookingCopilotTurnV1
    task: BookingCopilotTaskStateV1
  }): Promise<readonly BookingPlannerDecisionV1[]>
}

/** Called once per task in a server process, including once after recovery. */
export type BookingPlannerSessionFactoryV1 = (
  initialTask: BookingCopilotTaskStateV1,
) => BookingPlannerSessionV1

export interface BookingCopilotServerOptionsV1 {
  /** Deployment credential shared only with the HotelByte BFF. */
  apiKey: string
  runtime: BookingCopilotTaskRuntime
  plannerFactory: BookingPlannerSessionFactoryV1
  host?: string
  port?: number
  maxBodyBytes?: number
  /** GoTry source commit loaded from the root-owned release artifact. */
  artifactId?: string
}

export interface BookingCopilotServerHandleV1 {
  server: Server
  port: number
  close(): Promise<void>
}

function safeSecretEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage, maxBodyBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let exceeded = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBodyBytes) {
        exceeded = true
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => exceeded ? reject(new Error('payload_too_large')) : resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function writeSse(res: ServerResponse, event: BookingSurfaceEventV1): void {
  res.write(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`)
}

function errorCode(error: unknown): string {
  return error instanceof Error && error.message ? error.message.split(':', 1)[0]! : 'planner_failed'
}

export function startBookingCopilotServer(
  options: BookingCopilotServerOptionsV1,
): Promise<BookingCopilotServerHandleV1> {
  if (!options.apiKey) return Promise.reject(new Error('booking_copilot_api_key_required'))
  if (options.artifactId !== undefined && !/^[0-9a-f]{40}$/.test(options.artifactId)) {
    return Promise.reject(new Error('booking_copilot_artifact_id_invalid'))
  }
  const sessions = new Map<string, BookingPlannerSessionV1>()
  const maxBodyBytes = options.maxBodyBytes ?? 1_000_000

  const server = createServer(async (req, res) => {
    const isProbe = req.method === 'GET' && (req.url === '/healthz' || req.url === '/status')
    if (!isProbe && (req.method !== 'POST' || req.url !== '/a2a/booking-copilot/turn')) {
      sendJson(res, 404, { error: { code: 'not_found' } })
      return
    }
    const auth = String(req.headers.authorization ?? '')
    if (!safeSecretEqual(auth, `Bearer ${options.apiKey}`)) {
      sendJson(res, 401, { error: { code: 'unauthorized' } })
      return
    }
    if (isProbe) {
      res.setHeader(BOOKING_SURFACE_VERSION_HEADER, BOOKING_SURFACE_SCHEMA_VERSION)
      res.setHeader(BOOKING_SURFACE_SCHEMA_SHA256_HEADER, BOOKING_SURFACE_SCHEMA_SHA256)
      if (options.artifactId) res.setHeader('X-GoTry-Artifact-ID', options.artifactId)
      sendJson(res, 200, {
        schemaVersion: BOOKING_SURFACE_SCHEMA_VERSION,
        schemaSha256: BOOKING_SURFACE_SCHEMA_SHA256,
        status: 'ready',
      })
      return
    }
    const schemaVersion = String(req.headers[BOOKING_SURFACE_VERSION_HEADER] ?? '')
    const schemaHash = String(req.headers[BOOKING_SURFACE_SCHEMA_SHA256_HEADER] ?? '')
    if (schemaVersion !== BOOKING_SURFACE_SCHEMA_VERSION || schemaHash !== BOOKING_SURFACE_SCHEMA_SHA256) {
      sendJson(res, 409, {
        error: {
          code: 'booking_surface_schema_mismatch',
          expectedVersion: BOOKING_SURFACE_SCHEMA_VERSION,
          expectedSchemaSha256: BOOKING_SURFACE_SCHEMA_SHA256,
        },
      })
      return
    }

    let turn: BookingCopilotTurnV1
    try {
      const raw = await readBody(req, maxBodyBytes)
      const parsed = JSON.parse(raw) as unknown
      const validation = validateBookingCopilotTurnV1(parsed)
      if (!validation.ok) {
        sendJson(res, 400, { error: { code: 'invalid_booking_surface_turn', details: validation.errors } })
        return
      }
      turn = parsed as BookingCopilotTurnV1
    } catch (error) {
      const code = errorCode(error)
      sendJson(res, code === 'payload_too_large' ? 413 : 400, { error: { code } })
      return
    }

    let task: BookingCopilotTaskStateV1
    let isNewTask = false
    try {
      if (turn.kind === 'user.turn') {
        const suppliedTaskId = turn.taskId
        isNewTask = !suppliedTaskId || options.runtime.resumeTask(suppliedTaskId) === null
        task = options.runtime.startTask(turn)
      } else {
        task = options.runtime.continueWithReceipt(turn)
      }
    } catch (error) {
      sendJson(res, 409, { error: { code: errorCode(error) } })
      return
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-content-type-options': 'nosniff',
      [BOOKING_SURFACE_VERSION_HEADER]: BOOKING_SURFACE_SCHEMA_VERSION,
      [BOOKING_SURFACE_SCHEMA_SHA256_HEADER]: BOOKING_SURFACE_SCHEMA_SHA256,
    })

    try {
      if (isNewTask) writeSse(res, options.runtime.emitEvent(task.taskId, { kind: 'status', status: 'submitted' }))
      writeSse(res, options.runtime.emitEvent(task.taskId, { kind: 'status', status: 'working' }))
      task = options.runtime.resumeTask(task.taskId) ?? task
      let session = sessions.get(task.taskId)
      if (!session) {
        session = options.plannerFactory(task)
        sessions.set(task.taskId, session)
      }
      const decisions = await session.next({ turn, task })
      if (decisions.length === 0) {
        writeSse(res, options.runtime.emitEvent(task.taskId, {
          kind: 'error',
          error: { code: 'PLANNER_NO_DECISION', message: 'Planner returned no typed decision.', retryable: false },
        }))
      } else {
        for (const decision of decisions) {
          const event = decision.kind === 'operation'
            ? options.runtime.issueOperation(task.taskId, decision.action)
            : options.runtime.emitEvent(task.taskId, decision)
          writeSse(res, event)
        }
      }
    } catch (error) {
      try {
        writeSse(res, options.runtime.emitEvent(task.taskId, {
          kind: 'error',
          error: {
            code: errorCode(error),
            message: error instanceof Error ? error.message : 'planner_failed',
            retryable: false,
          },
        }))
      } catch {
        // Headers are already committed. Ending the stream is the only honest
        // fallback if even the typed error event cannot be recorded.
      }
    } finally {
      res.end()
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
        close: () => new Promise<void>((done, fail) => server.close((error) => error ? fail(error) : done())),
      })
    })
  })
}
