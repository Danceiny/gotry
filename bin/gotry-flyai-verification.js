/** Shared, bounded, read-only candidate verification for terminal and native Web setup. */
import { spawnOwnedChild, terminateOwnedChild } from './gotry-process-liveness.js'

export async function verifyFlyaiCandidate(candidate, options = {}) {
  const configured = options.env ?? process.env
  if (options.signal?.aborted) return { verdict: 'cancelled', error: '验证已取消。' }
  const env = { ...configured, FLYAI_API_KEY: candidate }
  delete env.DEBUG_FLYAI_API_KEY
  const command = configured.GOTRY_FLYAI_CLI_BIN || 'npx'
  const prefix = configured.GOTRY_FLYAI_CLI_BIN ? [] : ['-y', '@fly-ai/flyai-cli@1.0.16']
  const date = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
  const args = [...prefix, 'search-flight', '--origin', '上海', '--destination', '丽江', '--dep-date', date]
  const limit = Number(configured.GOTRY_FLYAI_VERIFY_TIMEOUT_MS ?? 20_000)
  const timeoutMs = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 60_000) : 20_000
  const owned = spawnOwnedChild(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stopReason, timer, stdout = '', stderr = '', bytes = 0
  const stop = (reason) => {
    stopReason ??= reason
    void terminateOwnedChild({ ...owned, signal: 'SIGKILL', termGraceMs: 100, killWaitMs: 1000 })
  }
  const abort = () => stop('cancelled')
  try {
    const result = await new Promise(resolve => {
      let settled = false
      const finish = value => { if (!settled) { settled = true; resolve(value) } }
      timer = setTimeout(() => stop('timeout'), timeoutMs)
      options.signal?.addEventListener('abort', abort, { once: true })
      if (options.signal?.aborted) abort()
      owned.child.stdout?.on('data', chunk => {
        bytes += chunk.length
        if (bytes > 256 * 1024) return stop('output-limit')
        stdout += chunk.toString()
      })
      owned.child.stderr?.on('data', chunk => {
        bytes += chunk.length
        if (bytes > 256 * 1024) return stop('output-limit')
        stderr += chunk.toString()
      })
      owned.child.once('error', () => finish({ verdict: 'error', error: '无法启动验证进程。' }))
      owned.child.once('close', code => {
        if (stopReason) return finish({ verdict: stopReason === 'output-limit' ? 'error' : stopReason,
          error: stopReason === 'cancelled' ? '验证已取消。' : stopReason === 'timeout' ? `验证调用超时 ${timeoutMs}ms。` : '验证响应过大。' })
        const combined = `${stderr}\n${stdout}`
        if (/Invalid API key|HTTP\s*401|\b401\b/.test(combined)) return finish({ verdict: 'auth-error', error: '401 Invalid API key' })
        if (/HTTP\s*403|\b403\b/.test(combined)) return finish({ verdict: 'forbidden', error: 'HTTP 403：无访问权限，请核对控制台权限。' })
        if (/Trial limit reached/.test(combined)) return finish({ verdict: 'needs-setup', error: '试用额度已用尽，请核对控制台 Key。' })
        if (/HTTP\s*429|\b429\b/.test(combined)) return finish({ verdict: 'rate-limited', error: '普通限流，稍后重试。' })
        if (code !== 0) return finish({ verdict: 'error', error: `验证进程失败（exit ${code}）；请检查网络与服务状态。` })
        try {
          const envelope = JSON.parse(stdout)
          finish(Array.isArray(envelope?.data?.itemList)
            ? { verdict: 'hit', count: envelope.data.itemList.length }
            : { verdict: 'error', error: '响应缺 data.itemList。' })
        } catch { finish({ verdict: 'error', error: '响应不是合法 JSON。' }) }
      })
    })
    return result
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
    await terminateOwnedChild({ ...owned, signal: 'SIGKILL', termGraceMs: 100, killWaitMs: 1000 })
  }
}
