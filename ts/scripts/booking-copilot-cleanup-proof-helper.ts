import assert from 'node:assert/strict'

export type CleanupAttempt = () => Promise<void> | void

/**
 * Keep a body failure while attempting every independent cleanup operation.
 * Each attempt is awaited in dependency order, while its failure is retained
 * so a later cleanup attempt still runs.
 */
export async function throwWithCleanupFailures(
  bodyFailed: boolean,
  bodyError: unknown,
  cleanupAttempts: readonly CleanupAttempt[],
  settlement?: { onSuccess?: CleanupAttempt; onFailure?: CleanupAttempt },
): Promise<never | void> {
  const cleanupErrors: unknown[] = []
  for (const attempt of cleanupAttempts) {
    try {
      await attempt()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  try {
    await (cleanupErrors.length === 0 ? settlement?.onSuccess : settlement?.onFailure)?.()
  } catch (error) {
    cleanupErrors.push(error)
  }
  if (!bodyFailed && cleanupErrors.length === 0) return
  if (bodyFailed && cleanupErrors.length === 0) throw bodyError
  throw new AggregateError(bodyFailed ? [bodyError, ...cleanupErrors] : cleanupErrors, 'booking_copilot_proof_cleanup_failed')
}

if (process.argv[2] === '--negative-control') {
  const cleanupOrder: string[] = []
  const bodyError = new Error('proof body failure')
  const plannerCleanupError = new Error('proof planner cleanup failure')
  const portCleanupError = new Error('proof port cleanup failure')
  let legacyCaught: unknown
  try {
    try {
      throw bodyError
    } finally {
      cleanupOrder.push('legacy-planner')
      throw plannerCleanupError
    }
  } catch (error) {
    legacyCaught = error
  }
  assert.equal(legacyCaught, plannerCleanupError, 'legacy sequential finally masks the body error')
  assert.deepEqual(cleanupOrder, ['legacy-planner'], 'legacy sequential finally skips cleanup after the first failure')
  cleanupOrder.length = 0
  let caught: unknown
  try {
    await throwWithCleanupFailures(true, bodyError, [
      async () => { cleanupOrder.push('planner'); throw plannerCleanupError },
      async () => { cleanupOrder.push('port'); throw portCleanupError },
      async () => { cleanupOrder.push('server') },
    ], {
      onSuccess: () => { cleanupOrder.push('state-deleted') },
      onFailure: () => { cleanupOrder.push('state-retained') },
    })
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof AggregateError, 'body and cleanup failures are aggregated')
  assert.deepEqual(caught.errors, [bodyError, plannerCleanupError, portCleanupError], 'body error remains first and all cleanup errors remain')
  assert.deepEqual(cleanupOrder, ['planner', 'port', 'server', 'state-retained'], 'later cleanup runs and the failed tree keeps its evidence')
  let cleanStateRemoved = false
  await assert.rejects(throwWithCleanupFailures(true, bodyError, [async () => {}], {
    onSuccess: () => { cleanStateRemoved = true },
  }), (error: unknown) => error === bodyError)
  assert.equal(cleanStateRemoved, true, 'successful cleanup removes state even when the body failed')
  console.log(JSON.stringify({
    legacy: { caught: plannerCleanupError.message, cleanupOrder: ['legacy-planner'] },
    repaired: { body: bodyError.message, cleanup: [plannerCleanupError.message, portCleanupError.message], cleanupOrder },
  }))
}
