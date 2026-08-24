#!/usr/bin/env node
/**
 * 预编译插件为纯 JS dist/(零依赖,Node ≥22.13 自带 API):
 *
 * 为什么:Node 拒绝对 node_modules 下的 .ts 做 type-stripping
 * (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING)——npm 安装后 dsh 加载
 * gotry-tools 插件必炸。发布前把 ts/{src,capabilities,scripts} 编成
 * dist/ 纯 JS,bin/gotry-inner.js 在 npm 模式下指向 dist/src/index.js;
 * repo 检出(vendored runtime)仍走 .ts 源码,互不影响。
 *
 * 运行: node scripts/build-dist.mjs(发布脚本自动调)
 */

import { readdirSync, readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = ['ts/src', 'ts/capabilities', 'ts/scripts']
const OUT = join(root, 'dist')

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (name.endsWith('.ts')) out.push(p)
  }
  return out
}

let n = 0
for (const dir of SRC) {
  for (const file of walk(join(root, dir))) {
    const rel = relative(join(root, 'ts'), file).replace(/\.ts$/, '.js')
    const target = join(OUT, rel)
    let js = stripTypeScriptTypes(readFileSync(file, 'utf-8'), { mode: 'transform', sourceUrl: file })
    // 相对导入的 .ts 说明符重写为 .js(bare import 如 @deepseek-ai/dsh-tools 不动)
    js = js.replace(/(from\s+|import\s*\(\s*)(['"])(\.[^'"]*?)\.ts(\2)/g, '$1$2$3.js$4')
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, js)
    n++
  }
}
console.log(`dist built: ${n} files → ${relative(root, OUT)}/`)
