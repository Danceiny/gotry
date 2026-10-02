/**
 * Loopback route serving the route-card's static map image.
 *
 * GET /dsh-map-tools/staticmap?w=640&h=260&line=lng,lat;lng,lat;…
 *
 * 为什么走回环路由而不是把图片塞进工具结果：
 *   1. **key 不出宿主**——浏览器只拿到一张本地图片 URL，高德 key 始终在服务端；
 *   2. **不进模型上下文**——工具结果里放 image block 会被适配器跳过/或消耗
 *      视觉额度，而卡片要的只是一张示意图；
 *   3. **懒加载 + 可缓存**——只有卡片真正渲染时才取图，且服务端按参数缓存。
 *
 * 拿不到图（没 key / 配额超限 / 网络问题）时返回错误状态码，客户端卡片会
 * 自动降级为自绘示意图（client/client.js 里的 svg 兜底）。
 */
import { parseLngLat } from './types.js';
import { isTrustedRequest } from './config-route.js';
/** URL 里最多接受的坐标点数（再多就截断，避免超长 query）。 */
const MAX_POINTS = 160;
/** 画布尺寸上限，与高德静态地图的限制一致。 */
const MAX_SIDE = 1024;
/** 解析 `line=lng,lat;lng,lat;…`；非法片段跳过，超过上限则等间隔截断。 */
export function parseLineParam(raw) {
    if (raw === null || raw === '')
        return [];
    const points = [];
    for (const chunk of raw.split(';')) {
        const point = parseLngLat(chunk);
        if (point !== null)
            points.push(point);
    }
    if (points.length <= MAX_POINTS)
        return points;
    const out = [];
    const step = (points.length - 1) / (MAX_POINTS - 1);
    for (let i = 0; i < MAX_POINTS; i += 1)
        out.push(points[Math.round(i * step)]);
    return out;
}
/** 把尺寸参数钳制到合法范围（默认 640×260）。 */
export function parseSizeParam(w, h) {
    const clamp = (value, fallback) => {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0)
            return fallback;
        return Math.max(64, Math.min(MAX_SIDE, Math.round(n)));
    };
    return { width: clamp(w, 640), height: clamp(h, 260) };
}
/**
 * Register the static-map route under the web server, when one exists.
 *
 * @param ctx - plugin context.
 * @param getAmap - reads the current Amap client (rebuilt on every config save).
 */
export function installStaticMapRoute(ctx, getAmap) {
    const fn = ctx.inject;
    fn(['webServer'], (scope) => {
        // 同 config-route：register() 的 disposer 必须由 effect 持有，否则热替换后
        // 旧处理器留在 exact 表里、新注册撞 "duplicate route" 被静默吞掉。
        scope.effect(() => scope.webServer.register({
            kind: 'exact',
            path: '/dsh-map-tools/staticmap',
            handler: async (req, res) => {
                const fail = (status, message) => {
                    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
                    res.end(message);
                };
                if (!isTrustedRequest(req)) {
                    fail(403, 'request refused: this route answers same-origin loopback only');
                    return;
                }
                if (req.method !== 'GET' && req.method !== 'HEAD') {
                    res.writeHead(405).end();
                    return;
                }
                const url = new URL(req.url ?? '/', 'http://localhost');
                const line = parseLineParam(url.searchParams.get('line'));
                if (line.length < 2) {
                    fail(400, '需要至少两个坐标点：/dsh-map-tools/staticmap?line=lng,lat;lng,lat');
                    return;
                }
                const amap = getAmap();
                if (amap === undefined) {
                    fail(409, '未配置高德 amapKey，静态地图不可用（卡片会退回自绘示意图）');
                    return;
                }
                const size = parseSizeParam(url.searchParams.get('w'), url.searchParams.get('h'));
                // Node 的 IncomingMessage 没有 signal：用连接关闭来取消上游请求
                // （用户切走/刷新时不必继续烧配额）。
                const controller = new AbortController();
                const onClose = () => controller.abort(new Error('client closed the static-map request'));
                req.on('close', onClose);
                try {
                    const png = await amap.staticMap(line, { width: size.width, height: size.height }, controller.signal);
                    res.writeHead(200, {
                        'content-type': 'image/png',
                        'content-length': String(png.byteLength),
                        // 同一张图（同一路线同尺寸）在客户端也缓存一天：回环流量几乎为零。
                        'cache-control': 'private, max-age=86400',
                    });
                    if (req.method === 'HEAD')
                        res.end();
                    else
                        res.end(Buffer.from(png));
                }
                catch (error) {
                    fail(502, String(error?.message ?? error));
                }
                finally {
                    req.off('close', onClose);
                }
            },
        }));
    });
}
