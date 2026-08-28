/**
 * P0 PoC(RFC docs/user-session-data-rfc.md §4 P0-③):
 * 专用测试 profile 打开携程机票 URL 参数搜索页,嗅探站内搜索 XHR 并打印 JSON。
 * 只读:无 click/fill/submit;不进 CI;不动共享状态(profile 在 /tmp)。
 * 运行:npx tsx scripts/session-attach-poc.ts [from-to] [YYYY-MM-DD]
 */
import { chromium } from "playwright-core";

const route = process.argv[2] ?? "sha-ljg"; // 上海→丽江(IATA 三字码小写)
const date = process.argv[3] ?? "2026-10-01";
const url = `https://flights.ctrip.com/online/list/oneway-${route}?depdate=${date}`;
const PROFILE = "/tmp/gotry-session-poc-profile"; // 专用测试 profile,绝不动日常浏览器

async function main() {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: "chrome", // 用本机已装 Chrome,不下载浏览器
    headless: false, // 可见窗口:人能看到 agent 在干什么(心智红线)
    viewport: { width: 1440, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  const hits: { url: string; bytes: number }[] = [];
  const cap = (s: string) => s.replace(/\s+/g, " ").slice(0, 600);
  ctx.on("response", async (res) => {
    const u = res.url();
    const ct = res.headers()["content-type"] ?? "";
    if (!ct.includes("json") || u.length > 400) return;
    // 只关心搜索/班期相关接口,过滤埋点与配置
    if (!/search|list|flight|itinerary|poll/i.test(u)) return;
    try {
      const body = await res.text();
      if (body.length < 200) return; // 空壳响应不记
      hits.push({ url: u, bytes: body.length });
      if (hits.length <= 3) {
        console.log(`\n[HIT ${hits.length}] ${res.status()} ${cap(u)}\n  body(${body.length}B): ${cap(body)}`);
      }
    } catch {
      /* 响应体不可读(流式/竞态)则跳过 */
    }
  });

  console.log(`goto ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(15_000); // 等首屏搜索接口回包

  const title = await page.title().catch(() => "");
  console.log(`\ntitle: ${cap(title)}`);
  const html = await page.content().catch(() => "");
  const challenged = /验证|滑块|captcha|verify/i.test(title + html.slice(0, 5000));
  console.log(`challenge-detected: ${challenged}`);
  console.log(`\nsummary: ${hits.length} 条搜索类 JSON XHR;总命中 ${hits.reduce((a, b) => a + b.bytes, 0)}B`);
  console.log("按体积 top5(P1 适配器要嗅探的接口面):");
  for (const h of [...hits].sort((a, b) => b.bytes - a.bytes).slice(0, 5)) {
    console.log(`  ${h.bytes}B  ${cap(h.url)}`);
  }
  console.log(challenged ? "结论:触发风控——按红线不重试不绕过,如实记录" : "结论:嗅探链路成立(只读,零交互)");
  await ctx.close();
}

main().catch((e) => {
  console.error("PoC 失败:", e instanceof Error ? e.message : e);
  process.exit(1);
});
