/**
 * 会话登录 CLD 薄壳(scripts/session-login.ts):产品形态是对话内工具
 * `gotry_session_login`(web 会话里 agent 直调,用户在弹出的标签页正常登录,
 * 全程无需终端);本脚本仅保留给脚本派/CI 探活:`npx tsx scripts/session-login.ts
 * [--site ctrip-flight] [--wait=90]`。
 *
 * 语义红线:登录发生在外部网站(携程官网)+ 用户自己的浏览器;gotry 永不
 * 收集/存储/回传任何密码、验证码或 cookie 值——只读票据 cookie 的名字,
 * 判断"是否已登录"这一个布尔(名称级存在性检查)。
 */

import { sessionLogin } from '../capabilities/session-login.ts'

async function main(): Promise<void> {
  const site = process.argv.find((a) => a === 'ctrip-flight' || a === 'meituan-hotel') ?? 'ctrip-flight'
  const waitArg = process.argv.find((a) => a.startsWith('--timeout') || a.startsWith('--wait'))
  const waitMs = Number(waitArg?.split('=')[1] ?? 180) * 1000
  const r = await sessionLogin({ site, waitMs })
  if (r.verdict === 'logged-in') {
    console.log(`[login] OK——${r.site} 登录票据已检出 [${(r.tickets ?? []).join(', ')}](只读名字)。`)
    console.log('[login] 说明:登录是在携程官网、用你自己的浏览器完成的;gotry 永不经手密码/验证码/cookie 值')
    return
  }
  if (r.verdict === 'pending') {
    console.log(`[login] 登录入口已在你的 Chrome 打开(${site});在标签页里完成登录即可,无需再跑本脚本——工具面按 cookie 名自动感知`)
    return
  }
  console.error(`[login] ${r.verdict}:${r.error ?? ''}\n${r.evidence}`)
  process.exit(2)
}

main().catch((e) => { console.error(e); process.exit(1) })
