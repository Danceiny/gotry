/**
 * gotry stdio 澄清卡提供方(T2 补强,ask_user_question 的 headless/TTY 形态):
 *
 * dsh 的 userQuestions 服务是「单一 UI 提供方」架构——web 界面注册一种,这里注册
 * 终端形态:ask_user_question 在交互终端渲染成选择题,读一行序号作答复。业界对照
 * (Claude Code -p 最终做法是 headless 直接不暴露工具;MCP elicitation 规范:无提供
 * 方应作为错误/优雅降级传回模型)——我们比照实现为:
 *   - headless + TTY(人坐在终端前):注册本插件,终端问答(优于纯文本退化)
 *   - headless + 非 TTY(CI/管道):不注册 → 工具收到 NO_PROVIDER 错误 → 人格契约
 *     (5) 退化文本选择题;GOTRY_ASK_STDIO=1 可强制启用(测试/外接答复管道)
 *
 * 插件形态遵循 dsh 约定(name/inject/apply);纯 JS 无需 dist 编译。
 */

import { createInterface } from 'node:readline'

export const name = 'gotry-stdio-ask'
export const inject = ['userQuestions']

export function apply(ctx) {
  const svc = ctx.userQuestions
  if (!svc || typeof svc.registerProvider !== 'function') return

  svc.registerProvider({
    async ask(request) {
      const answers = []
      for (const q of request.questions ?? []) {
        if (request.signal?.aborted) { answers.push({ id: q.id, selected: [] }); continue }
        const opts = q.options ?? []
        const lines = ['', `❓ ${q.header ? `${q.header} — ` : ''}${q.question}`]
        opts.forEach((o, i) => lines.push(`  ${i + 1}. ${o.label}${o.detail ? ` — ${o.detail}` : ''}`))
        lines.push(q.multiSelect ? '  (多选:序号逗号分隔;回车=跳过,可输自定义文本)' : '  (输入序号回车;回车=跳过,可输自定义文本)')
        process.stdout.write(lines.join('\n') + '\n> ')
        const rl = createInterface({ input: process.stdin, output: process.stdout, signal: request.signal })
        let raw = ''
        try {
          raw = (await new Promise((resolve) => {
            rl.once('line', resolve)
            rl.once('close', () => resolve(''))
            if (request.signal) request.signal.addEventListener('abort', () => { try { rl.close() } catch { /* ignore */ } }, { once: true })
          })).trim()
        } finally { try { rl.close() } catch { /* ignore */ } }
        const selected = []
        let custom
        if (raw && /^[0-9,\s]+$/.test(raw)) {
          for (const part of raw.split(/[,\s]+/).filter(Boolean)) {
            const o = opts[Number(part) - 1]
            if (o) selected.push(o.label)
          }
        } else if (raw) {
          custom = raw
        }
        // 空输入=跳过(MCP elicitation 规范:decline 是正常答复,不是错误)
        answers.push({ id: q.id, selected, ...(custom !== undefined ? { custom } : {}) })
      }
      return { answers }
    },
  })
}
