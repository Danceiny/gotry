/** Bridge successful GoTry render results to DSH's native present/delivery protocol. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tool-present/types'
import type {} from '@deepseek-ai/dsh-tools'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'

export function registerArtifactDeliveries(ctx: Context): void {
  // Tool-registration-only hosts have no conversation event surface.
  if (typeof ctx.on !== 'function') return
  ctx.on('tools/result', (exec, result) => {
    if (result.isError || exec.signal.aborted || !['gotry_itinerary_render', 'gotry_itinerary_deck_render'].includes(exec.name)) return
    const value = result.value as { ok?: boolean; path?: unknown } | null
    const session = exec.agent?.session, cwd = session?.header.cwd
    if (!session || !cwd || !isAbsolute(cwd) || value?.ok !== true || typeof value.path !== 'string' || !isAbsolute(value.path)) return
    const boundary = ctx.get('sessionProjections')?.stateOf(session, 'turnBoundary')
    if (!boundary || boundary.openTurnStartSeq === null) return
    try {
      const path = realpathSync(value.path), root = realpathSync(cwd), inside = relative(root, path)
      if (inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside) || !statSync(path).isFile()) return
      session.append('deliverables/presented', { turn: boundary.lastTurn, callId: exec.callId,
        files: [{ path: value.path, description: 'GoTry itinerary' }] })
    } catch { /* A deleted or escaped file cannot become a delivery. */ }
  })
}
