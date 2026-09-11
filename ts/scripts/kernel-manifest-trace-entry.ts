/**
 * 运行模块 trace 入口(issue #234):真实 import 产品运行面——dsh 插件入口
 * ts/src/index.ts。import-only:不调用任何工具、不注册到任何 ctx、零状态写入
 * (gotry-state 红线面零接触);trace 结果由 kernel-manifest-trace-hook.mjs 记录。
 */
await import('../src/index.ts')
process.stdout.write('KERNEL_TRACE_ENTRY_OK\n')
