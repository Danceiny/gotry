/**
 * 运行模块 trace 钩子(issue #234;由 kernel-manifest.ts runRuntimeTrace 以
 * `node --import tsx/esm --import <本文件>` 装载)。node:module registerHooks
 * 是同步钩子(主线程,Node ≥ 22.15),能记录真实实例化的每个模块 URL;
 * 异步 register() 的钩子跑在独立线程,主进程拿不到数组——这是选同步 API 的原因。
 * 输出:KR_TRACE_OUT 指向的文件,{ loaded: [url, …] }。
 */
import { registerHooks } from 'node:module'
import { writeFileSync } from 'node:fs'

const loaded = []

registerHooks({
  load(url, context, nextLoad) {
    loaded.push(url)
    return nextLoad(url, context)
  },
})

process.on('exit', () => {
  const out = process.env.KR_TRACE_OUT
  if (!out) return
  try {
    writeFileSync(out, JSON.stringify({ loaded }))
  } catch {
    // 输出失败时父进程按「trace 文件缺失」裁决为环境失败(exit 2),不静默。
  }
})
