/** Read-only model surface. Credentials are entered only through the local CLI. */
import { homedir } from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { EffectInterpreter } from '../capabilities/effect.ts'
import {
  displayEndpoint, endpointFingerprint, readFlyaiVerification, resolveFlyaiEndpoint,
  resolveFlyaiKey, sha256Hex, writeFlyaiVerification,
} from '../capabilities/flyai-config.ts'
import type { FlyaiResult } from '../capabilities/flyai.ts'
import { readLatestChannelEvents } from '../capabilities/channel-health.ts'

const guidance = '在本机运行 gotry setup flyai（隐藏输入），或 gotry setup flyai --stdin；清除文件配置用 --clear。不要在聊天中发送 API key。打开 https://flyai.open.fliggy.com/console，登录后复制 API Key。'
const guidanceImpact = '影响面:未配置 key 时 gotry_flyai_search 走匿名共享额度池(易达 Trial limit reached,达限本会话该工具不可用);配置后额度走本机 key,失败时按 verdict 改道 gotry_session_search 账号会话通道。'

export function createFlyaiSetupTool(runEffect: EffectInterpreter, stateRoot?: string) {
  return defineTool({
    name: 'gotry_flyai_setup',
    description: 'Inspect FlyAI credential source and verification status, or check the current configuration with a read-only search. Never accepts, changes or returns credentials. Check updates only a verification receipt; setting or clearing credentials requires the local gotry setup flyai command.',
    parameters: { action: { type: 'string', enum: ['status', 'check'], description: 'status (default): local status; check: read-only provider verification' } },
    output: { schema: { type: 'json' }, render: (_a, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      // Reject unknown arguments before any provider invocation or metadata write.
      if (Object.keys(args).some(key => key !== 'action') || (args.action !== undefined && args.action !== 'status' && args.action !== 'check')) {
        return { ok: false, summary: `仅支持 status/check；不接收凭据。${guidance} ${guidanceImpact}` }
      }
      const home = homedir()
      const current = resolveFlyaiKey()
      const endpoint = resolveFlyaiEndpoint()
      const fingerprint = endpointFingerprint(endpoint.url)
      let receipt = readFlyaiVerification(home)
      let checkVerdict: string | undefined
      let receiptSaved: boolean | undefined
      if (args.action === 'check') {
        const date = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
        const outcome = await runEffect({ effect: 'FLYAI_SEARCH', params: {
          kind: 'flight', origin: '上海', destination: '北京', depDate: date,
          timeoutMs: 20_000, signal: exec?.signal,
        } })
        const result = outcome.result as FlyaiResult | null
        checkVerdict = outcome.trace.declined === 'aborted' ? 'cancelled' : result?.verdict ?? 'error'
        // A concurrent local credential change invalidates this check's receipt.
        const after = resolveFlyaiKey()
        const unchanged = current.key === after.key && current.source === after.source
          && fingerprint === endpointFingerprint(resolveFlyaiEndpoint().url)
        if (current.key && fingerprint && unchanged && checkVerdict !== 'cancelled') {
          const allowed = ['auth-error', 'forbidden', 'rate-limited', 'timeout', 'needs-setup', 'error'] as const
          const verdict = checkVerdict === 'hit' || checkVerdict === 'miss' ? 'verified'
            : allowed.find(value => value === checkVerdict) ?? 'error'
          receipt = { schema: 'gotry.flyai-verification.v1', source: current.source,
            keySha256: sha256Hex(current.key), maskedKey: current.maskedKey ?? '****',
            endpointFingerprint: fingerprint, endpointDebug: endpoint.debug,
            verdict, at: new Date().toISOString() }
          receiptSaved = writeFlyaiVerification(receipt, home)
        }
      }
      const matches = Boolean(current.key && receipt && receipt.keySha256 === sha256Hex(current.key)
        && receipt.source === current.source && receipt.endpointFingerprint === fingerprint
        && receipt.endpointDebug === endpoint.debug)
      const verified = matches && receipt?.verdict === 'verified'
      const event = stateRoot ? (await readLatestChannelEvents(stateRoot, { requireValidTimestamp: true })).get('flyai') : undefined
      const lastTrialLimit = event?.state === 'down' && event.reason === 'needs-setup' ? event.at : undefined
      const status = !current.key ? '匿名试用（共享额度）' : verified ? '已验证当前配置' : '已配置，未验证通过'
      const summary = `${status}；来源 ${current.source}；endpoint ${displayEndpoint(endpoint.url)}${endpoint.debug ? '（DEBUG）' : ''}。`
        + (checkVerdict ? `本次只读检查：${checkVerdict}。` : '')
        + (lastTrialLimit ? `最近试用额度受限：${lastTrialLimit}。` : '')
        + (receiptSaved === false ? '验证回执保存失败，doctor 状态尚未更新。' : '') + guidance
        + ' ' + guidanceImpact
      return JSON.parse(JSON.stringify({ ok: receiptSaved !== false && (!checkVerdict || checkVerdict === 'hit' || checkVerdict === 'miss'), action: args.action ?? 'status',
        source: current.source, configured: Boolean(current.key), verified,
        maskedKey: current.maskedKey, configPath: current.configPath,
        endpoint: displayEndpoint(endpoint.url), endpointDebug: endpoint.debug,
        checkVerdict, receiptSaved, lastTrialLimit, summary })) as Record<string, never>
    },
    // Do not retain unexpected arguments even when a host bypasses schema validation.
    presentCall: args => ({ card: 'generic', title: 'FlyAI 配置检查', kind: 'fetch', rawInput: { action: args.action === 'check' ? 'check' : 'status' } }),
  })
}
