#!/usr/bin/env node
/**
 * 预编译插件为纯 JS dist/(零依赖,Node ≥22.13 自带 API):
 *
 * 为什么:Node 拒绝对 node_modules 下的 .ts 做 type-stripping
 * (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING)——npm 安装后 dsh 加载
 * gotry-tools 插件必炸。发布前把 ts/{src,capabilities,scripts} 编成
 * dist/ 纯 JS,bin/gotry-inner.js 在 npm 模式和无 tsx loader 的源码模式下
 * 指向 dist/src/index.js；legacy vendored/显式 tsx 才直载 .ts。
 *
 * 运行: node scripts/build-dist.mjs(发布脚本自动调)
 */

import { copyFileSync, readdirSync, readFileSync, mkdirSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = ['ts/src', 'ts/capabilities', 'ts/scripts']
const DATA = ['session-golden-20.json', 'sf-golden-manifest.json', 'sf-static-routes.json']
const OUT = join(root, 'dist')

// 先清后建:源码删除的文件(如 session-attach-*.ts)其陈旧编译产物会残留并进 tarball
rmSync(OUT, { recursive: true, force: true })

function walk(dir, extension = '.ts') {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p, extension))
    else if (name.endsWith(extension)) out.push(p)
  }
  return out
}

// 非 TS 运行时资产原样随 dist 分发(files 白名单已含 dist/)。
// agent-reach wrapper 在 dist/capabilities/ 找 Python 反射桥；sf-live runner
// 与 static provider 从 dist/data/ 读取同一组 benchmark 输入。
mkdirSync(join(OUT, 'capabilities'), { recursive: true })
copyFileSync(join(root, 'ts/capabilities/agent-reach-bridge.py'), join(OUT, 'capabilities/agent-reach-bridge.py'))
mkdirSync(join(OUT, 'data'), { recursive: true })
for (const file of DATA) {
  copyFileSync(join(root, 'ts/data', file), join(OUT, 'data', file))
}

let n = 0
for (const dir of SRC) {
  for (const file of walk(join(root, dir))) {
    const rel = relative(join(root, 'ts'), file).replace(/\.ts$/, '.js')
    const target = join(OUT, rel)
    // Keep generated output reproducible: absolute temp/worktree paths would
    // leak into source maps and make the release manifest vary per machine.
    const sourceUrl = relative(root, file).split(sep).join('/')
    let js = stripTypeScriptTypes(readFileSync(file, 'utf-8'), { mode: 'transform', sourceUrl })
    // 相对导入的 .ts 说明符重写为 .js。Node 的 transform stripper
    // 会把部分 `import type ... from` 变成 side-effect `import './x.ts'`，
    // 因此要覆盖所有相对字符串说明符，而非只匹配 `from`/动态 import。
    js = js.replace(/(['"])(\.[^'"]*?)\.ts\1/g, '$1$2.js$1')
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, js)
    n++
  }
}

// Runtime JS assets live next to their TypeScript callers. In particular the
// dsh plugin and canonical-schema projector must exist at the same relative
// location in the npm package's compiled dist tree.
let jsAssets = 0
for (const dir of SRC) {
  for (const file of walk(join(root, dir), '.js')) {
    const rel = relative(join(root, 'ts'), file)
    const target = join(OUT, rel)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(file, target)
    jsAssets++
  }
}
console.log(`dist built: ${n} TS files + ${jsAssets} JS assets + ${DATA.length} data files → ${relative(root, OUT)}/`)
