/**
 * Deterministic, model-free GoTry server for the Hotel-BE/Hotel-FE proof.
 *
 * The proof starts this process as a real GoTry HTTP/SSE server.  The planner
 * is intentionally in-process and typed: it selects a hotel on the payment
 * link surface, starts a search on the storefront surface, and only emits a
 * terminal event after the corresponding receipt continuation.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureLedger } from '../src/state-ledger.ts'
import {
  BOOKING_SURFACE_SCHEMA_SHA256,
  BOOKING_SURFACE_SCHEMA_VERSION,
  type BookingCopilotTurnV1,
  type BookingReadActionV1,
} from '../src/booking-surface/contracts.ts'
import { BookingCopilotTaskRuntime, type BookingCopilotTaskStateV1 } from '../src/booking-surface/runtime.ts'
import {
  startBookingCopilotServer,
  type BookingPlannerDecisionV1,
  type BookingPlannerSessionFactoryV1,
} from '../src/booking-surface/server.ts'

const API_KEY = 'test-only-cross-repo-key'
const stateRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-copilot-crossrepo-'))
const ledger = ensureLedger(stateRoot)
let sequence = 0

const plannerFactory: BookingPlannerSessionFactoryV1 = (initialTask: BookingCopilotTaskStateV1) => {
  let receiptObserved = initialTask.lastReceipt !== undefined
  return {
    async next({ turn, task }): Promise<readonly BookingPlannerDecisionV1[]> {
      if (turn.kind === 'action.receipt.continuation') {
        receiptObserved = true
        return [{
          kind: 'terminal',
          terminal: {
            status: 'completed',
            summary: 'Fixture receipt observed.',
            factRefs: [],
          },
        }]
      }
      if (receiptObserved) {
        return [{
          kind: 'terminal',
          terminal: {
            status: 'completed',
            summary: 'Fixture task already has a receipt.',
            factRefs: [],
          },
        }]
      }
      const action: BookingReadActionV1 = task.surface === 'payment_link'
        ? {
            schemaVersion: BOOKING_SURFACE_SCHEMA_VERSION,
            kind: 'hotel.select',
            actionId: 'cross-repo-select-1',
            contextRef: task.contextRef,
            expectedRevision: task.revision,
            reason: 'Select the requested hotel.',
            factRefs: [],
            input: { hotelRef: 'hotel-proof-1' },
          }
        : {
            schemaVersion: BOOKING_SURFACE_SCHEMA_VERSION,
            kind: 'search.run',
            actionId: 'cross-repo-select-1',
            contextRef: task.contextRef,
            expectedRevision: task.revision,
            reason: 'Run the storefront search.',
            factRefs: [],
            input: {},
          }
      return [{ kind: 'operation', action }]
    },
  }
}

async function main(): Promise<void> {
  const runtime = new BookingCopilotTaskRuntime(ledger, {
    idFactory: (prefix) => `${prefix}-cross-repo-${++sequence}`,
    now: () => '2026-08-31T00:00:00.000Z',
  })
  const handle = await startBookingCopilotServer({
    apiKey: API_KEY,
    runtime,
    plannerFactory,
    host: '127.0.0.1',
    port: 0,
  })
  process.stdout.write(`BOOKING_COPILOT_FIXTURE_STARTUP=${JSON.stringify({
    url: `http://127.0.0.1:${handle.port}`,
    version: BOOKING_SURFACE_SCHEMA_VERSION,
    sha256: BOOKING_SURFACE_SCHEMA_SHA256,
  })}\n`)

  await new Promise<void>((resolve) => {
    const stop = () => resolve()
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
  })
  await handle.close()
}

try {
  await main()
} catch (error) {
  process.stderr.write(`booking-copilot-crossrepo-fixture failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  try { ledger.close() } catch (error) { process.stderr.write(`booking-copilot-crossrepo-fixture ledger close failed: ${error instanceof Error ? error.message : String(error)}\n`) }
  rmSync(stateRoot, { recursive: true, force: true })
}
