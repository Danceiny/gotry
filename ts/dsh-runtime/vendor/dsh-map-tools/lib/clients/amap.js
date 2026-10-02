/** Amap (高德) Web Service API client. */
import { formatLngLat } from '../types.js';
import { decodeAmapPolyline, dedupeGeometry, compactLine } from '../geo.js';
const REST = 'https://restapi.amap.com/';
// ---------------------------------------------------------------------------
// 配额保护层
//
// 高德个人开发者 key 的 QPS 上限极低（常见 3 QPS/秒，超限返回错误码 10021
// CUQPS_HAS_EXCEEDED_THE_LIMIT），而一次工具调用（尤其 map_transit_route）
// 内部可能连发 1~5 个请求；多个工具并行时瞬时请求数很容易击穿配额，导致
// 用户看到一串 10021 报错。这里做三层防护：
//
//   1. 限速排队：RateLimiter 把任意两次请求的最小间隔钳制在 1000/maxQps
//      （默认 2 QPS，低于高德常见上限、留余量），并发请求排队等待而不是
//      同时发出；
//   2. 结果缓存：geocode / route / POI 按参数做 TTL 内存缓存，同一会话中
//      相同请求直接命中缓存，不再消耗配额（transit 的 resolveCity 会命中
//      resolve 刚写下的 geocode 缓存，省掉重复请求）；
//   3. 错误分类 + 重试：10020/10021（QPS 超限）标记为可重试，在客户端内
//      退避重试；10022/10023（日配额超限）重试无意义，直接给出友好中文
//      提示。上层工具仍可捕获 AmapQuotaError 做降级（见 tools/routes.ts）。
// ---------------------------------------------------------------------------
/** 配额类错误（QPS 或日配额超限）。retryable=true 时短期内重试可能成功
 *  （QPS 超限），false 表示重试无意义（日配额已用尽）。 */
export class AmapQuotaError extends Error {
    infocode;
    retryable;
    constructor(infocode, message, retryable) {
        super(message);
        this.infocode = infocode;
        this.retryable = retryable;
        this.name = 'AmapQuotaError';
    }
}
/** Sleep that honors an AbortSignal (rejects with the abort reason). */
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        let timer;
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        const onAbort = () => {
            if (timer)
                clearTimeout(timer);
            cleanup();
            reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'aborted')));
        };
        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);
    });
}
/**
 * 串行链 + 最小间隔限速器：所有请求排成一条 promise 链，每个请求在拿到
 * 自己的发送窗口前等待（与前一个请求至少间隔 intervalMs）。并发调用
 * acquire 时天然排队，不会同时发出请求。
 */
class RateLimiter {
    intervalMs;
    tail = Promise.resolve();
    lastSend = 0;
    constructor(intervalMs) {
        this.intervalMs = intervalMs;
    }
    /** 排队等待自己的发送窗口；signal 中断时抛错。 */
    acquire(signal) {
        const run = this.tail.then(async () => {
            const now = Date.now();
            const wait = Math.max(0, this.lastSend + this.intervalMs - now);
            if (wait > 0)
                await sleep(wait, signal);
            this.lastSend = Date.now();
        });
        // 链继续推进：某个请求失败（如被 abort）不阻塞后续请求。
        this.tail = run.catch(() => undefined);
        return run;
    }
}
/** 简单的 TTL + 容量上限内存缓存（插入序近似 LRU 淘汰）。 */
class TtlCache {
    ttlMs;
    maxEntries;
    store = new Map();
    constructor(ttlMs, maxEntries = 300) {
        this.ttlMs = ttlMs;
        this.maxEntries = maxEntries;
    }
    get(key) {
        const entry = this.store.get(key);
        if (!entry)
            return undefined;
        if (entry.expiresAt < Date.now()) {
            this.store.delete(key);
            return undefined;
        }
        // LRU touch：删了重插，保持最近使用的在末尾。
        this.store.delete(key);
        this.store.set(key, entry);
        return entry.value;
    }
    set(key, value) {
        if (this.store.size >= this.maxEntries) {
            const oldest = this.store.keys().next().value;
            if (oldest !== undefined)
                this.store.delete(oldest);
        }
        this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    }
}
/** 各请求类型的缓存 TTL。 */
const CACHE_TTL = {
    geo: 24 * 60 * 60 * 1000, // 地理编码结果基本不变
    route: 60 * 60 * 1000, // 路线/路况 1 小时内可复用
    poi: 60 * 60 * 1000,
};
/** 解析高德的 `"lng,lat"` 坐标字段（`location`、`taxi.origin` 等）。 */
function parseAmapLocation(text) {
    if (typeof text !== 'string')
        return undefined;
    const parts = text.split(',');
    if (parts.length !== 2)
        return undefined;
    const lng = Number(parts[0]);
    const lat = Number(parts[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat))
        return undefined;
    if (lng < -180 || lng > 180 || lat < -90 || lat > 90)
        return undefined;
    return [lng, lat];
}
/**
 * 读方案/分段的耗时（秒）。
 * v5 放在 `cost.duration`，v3 放在 `duration`——两个都读，v5 优先。
 */
function readDuration(node) {
    const value = Number(node?.cost?.duration ?? node?.duration ?? 0);
    return Number.isFinite(value) ? value : 0;
}
/** 读分段距离（米）：v5 是 `step_distance`，v3 是 `distance`。 */
function readStepDistance(step) {
    const value = Number(step.step_distance ?? step.distance ?? 0);
    return Number.isFinite(value) ? value : 0;
}
/**
 * 从公交分段里尽力拼出路线几何。
 *
 * 公交响应没有"整条线"的折线，只有各段的碎片：步行段有 `steps[].polyline`，
 * 公交段有线路 `polyline`，火车/打车段只有站点坐标。这里按分段顺序拼接；
 * 缺折线的分段用两端站点坐标连一条直线（示意图够用，且不会画错方向）。
 * 拿不到任何可用碎片时返回空数组，由调用方回退成起终点直线。
 *
 * @param segments - 高德公交响应的一条方案的分段数组。
 * @returns 拼接后的几何点（可能为空）。
 */
function transitGeometry(segments) {
    const line = [];
    const push = (points) => {
        for (const point of points)
            line.push(point);
    };
    const straight = (from, to) => {
        const a = parseAmapLocation(from);
        const b = parseAmapLocation(to);
        if (a)
            push([a]);
        if (b)
            push([b]);
    };
    for (const segment of segments) {
        const walking = segment.walking;
        if (walking) {
            const fromSteps = (walking.steps ?? []).flatMap((step) => decodeAmapPolyline(step.polyline));
            if (fromSteps.length >= 2)
                push(fromSteps);
            // v5 的步行 steps 折线实测为空，退成步行段自身的起终点直线。
            else
                straight(walking.origin, walking.destination);
        }
        const busline = segment.bus?.buslines?.[0];
        if (busline) {
            const decoded = decodeAmapPolyline(busline.polyline);
            if (decoded.length > 0)
                push(decoded);
            else
                straight(busline.departure_stop?.location, busline.arrival_stop?.location);
        }
        if (segment.railway) {
            straight(segment.railway.departure_stop?.location, segment.railway.arrival_stop?.location);
        }
        if (segment.taxi)
            straight(segment.taxi.origin, segment.taxi.destination);
        const entrance = parseAmapLocation(segment.entrance?.location);
        if (entrance)
            push([entrance]);
        const exit = parseAmapLocation(segment.exit?.location);
        if (exit)
            push([exit]);
    }
    return line;
}
export class AmapClient {
    opts;
    limiter;
    geoCache = new TtlCache(CACHE_TTL.geo);
    routeCache = new TtlCache(CACHE_TTL.route);
    poiCache = new TtlCache(CACHE_TTL.poi);
    /** 静态地图字节缓存：同一张图不重复计费。 */
    mapCache = new TtlCache(CACHE_TTL.poi);
    constructor(opts) {
        this.opts = opts;
        // 钳制在 [0.2, 100] QPS：避免配置了 0/负数，也避免测试设极大值时的计时噪声。
        const qps = Math.max(0.2, Math.min(100, opts.maxQps ?? 2));
        this.limiter = new RateLimiter(1000 / qps);
    }
    /**
     * 带配额保护的统一请求入口：限速排队 → 缓存命中 → 请求 → 可重试错误退避
     * 重试 → 写入缓存。
     */
    async request(path, params, signal, opts = {}) {
        await this.limiter.acquire(signal);
        if (opts.cache && opts.cacheKey) {
            const hit = opts.cache.get(opts.cacheKey);
            if (hit !== undefined)
                return hit;
        }
        const retries = opts.retries ?? 0;
        let attempt = 0;
        for (;;) {
            try {
                const body = await this.rawGet(path, params, signal);
                if (opts.cache && opts.cacheKey)
                    opts.cache.set(opts.cacheKey, body);
                return body;
            }
            catch (err) {
                if (err instanceof AmapQuotaError && err.retryable && attempt < retries) {
                    attempt++;
                    // 简单线性退避：250ms / 500ms / 750ms …
                    await sleep(250 * attempt, signal);
                    continue;
                }
                throw err;
            }
        }
    }
    /** 裸 GET：拼 URL、带 key、超时 + abort、错误分类。 */
    async rawGet(path, params, signal) {
        const url = new URL(`${REST}${path}`);
        url.searchParams.set('key', this.opts.key);
        for (const [k, v] of Object.entries(params)) {
            if (v !== undefined && v !== '')
                url.searchParams.set(k, v);
        }
        // Combine the caller's abort signal with a per-request timeout.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error(`Amap request timed out after ${this.opts.timeoutMs}ms`)), this.opts.timeoutMs);
        const onAbort = () => controller.abort(signal.reason);
        if (signal.aborted)
            controller.abort(signal.reason);
        else
            signal.addEventListener('abort', onAbort, { once: true });
        let res;
        try {
            res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
        }
        catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            throw new Error(`高德地图服务请求失败（${reason}）。请检查 amapKey 是否有效：https://console.amap.com/dev/key/app`);
        }
        finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
        }
        if (!res.ok)
            throw new Error(`Amap HTTP ${res.status}: ${res.statusText}`);
        const body = (await res.json());
        if (body.status === '1')
            return body;
        this.throwAmapError(body.infocode ?? '?', body.info ?? 'unknown');
    }
    /**
     * 把高德返回的错误码翻译成面向用户的异常（key / 配额 / 其它）。
     * @param infocode - 高德 `infocode`。
     * @param info - 高德 `info` 文案。
     */
    throwAmapError(infocode, info) {
        // Key-related errors are the most common user mistake — guide them to fix it.
        if (infocode === '10001' || infocode === '10003' || /INVALID_USER_KEY|USER_KEY_PLAT_NOMATCH/i.test(info)) {
            throw new Error(`高德 key 无效或未生效（${infocode}: ${info}）。请检查插件配置中的 amapKey 是否正确，或前往 https://console.amap.com/dev/key/app 重新申请。`);
        }
        // 配额类错误：QPS 超限（10020/10021）可重试，日配额超限（10022/10023）不可。
        if (infocode === '10020' || infocode === '10021' || /QPS_HAS_EXCEEDED/i.test(info)) {
            throw new AmapQuotaError(infocode, `高德请求过于频繁（QPS 超限：${info}）。插件已自动限速排队并重试；若持续出现，可在插件配置中调低 maxQps 减少并发。`, true);
        }
        if (infocode === '10022' || infocode === '10023' || /QUOTA_HAS_EXCEEDED/i.test(info)) {
            throw new AmapQuotaError(infocode, `高德今日配额已用尽（${info}）。请明天再试，或前往 https://console.amap.com/dev/key/app 查看当前配额。`, false);
        }
        throw new Error(`Amap API error ${infocode}: ${info}`);
    }
    /**
     * 裸 GET，返回二进制（静态地图）。高德出错时返回 JSON 而不是图片，
     * 所以响应不是 image/* 就按错误体解析。
     */
    async rawGetBytes(path, params, signal) {
        const url = new URL(`${REST}${path}`);
        url.searchParams.set('key', this.opts.key);
        for (const [k, v] of Object.entries(params)) {
            if (v !== undefined && v !== '')
                url.searchParams.set(k, v);
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error(`Amap request timed out after ${this.opts.timeoutMs}ms`)), this.opts.timeoutMs);
        const onAbort = () => controller.abort(signal.reason);
        if (signal.aborted)
            controller.abort(signal.reason);
        else
            signal.addEventListener('abort', onAbort, { once: true });
        let res;
        try {
            res = await fetch(url, { signal: controller.signal, headers: { Accept: 'image/png,application/json' } });
        }
        catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            throw new Error(`高德地图服务请求失败（${reason}）。请检查 amapKey 是否有效：https://console.amap.com/dev/key/app`);
        }
        finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
        }
        if (!res.ok)
            throw new Error(`Amap HTTP ${res.status}: ${res.statusText}`);
        const type = res.headers.get('content-type') ?? '';
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (/image\//i.test(type))
            return bytes;
        let body = {};
        try {
            body = JSON.parse(new TextDecoder().decode(bytes));
        }
        catch {
            // 非 JSON 也非图片：当作协议异常。
        }
        this.throwAmapError(body.infocode ?? '?', body.info ?? `unexpected content-type: ${type}`);
    }
    /**
     * 静态地图：一张**真地图** PNG，路线折线与起终点标注由高德绘制。
     *
     * 取景框**交给高德自己适配**——不传 `location`，不传 `zoom`。这里踩过
     * 一个很贵的坑：高德静态地图的 `zoom` 与标准 Web Mercator 差一级
     * （它的 12 级才等于 256px 瓦片的 13 级），于是按 Mercator 公式"算准了
     * 装得下"的 zoom 实际被放大一倍，路线溢出画布；而高德**不报错**，只是
     * 静默把整条 `paths` 丢掉——现象正是"有底图、没路线"。
     *
     * 只给 `paths`（+`markers`）时高德按外包框自适应取景，实测 0.8km 步行、
     * 20.9km 驾车、1205km 跨省、公交链各种尺度都完整居中、不裁切。
     *
     * 结果按参数缓存，同一张图不会被反复计费。
     *
     * @param line - 路线几何（GCJ-02，与高德出图坐标系一致）。
     * @param opts - 画布尺寸与是否画起终点标注。
     * @param signal - 取消信号。
     * @returns PNG 字节。
     */
    async staticMap(line, opts, signal) {
        if (line.length < 2)
            throw new Error('静态地图至少需要两个坐标点');
        const width = Math.max(64, Math.min(1024, Math.round(opts.width)));
        const height = Math.max(64, Math.min(1024, Math.round(opts.height)));
        const encoded = compactLine(line, 160);
        const cacheKey = `staticmap:${width}x${height}:${encoded}`;
        const hit = this.mapCache.get(cacheKey);
        if (hit !== undefined)
            return hit;
        await this.limiter.acquire(signal);
        const params = { size: `${width}*${height}` };
        // 所有点重合的退化"路线"没有外包框，高德无从适配；退回定点取景。
        let minLng = Infinity;
        let maxLng = -Infinity;
        let minLat = Infinity;
        let maxLat = -Infinity;
        for (const [lng, lat] of line) {
            if (lng < minLng)
                minLng = lng;
            if (lng > maxLng)
                maxLng = lng;
            if (lat < minLat)
                minLat = lat;
            if (lat > maxLat)
                maxLat = lat;
        }
        if (maxLng - minLng < 1e-6 && maxLat - minLat < 1e-6) {
            params.location = `${line[0][0]},${line[0][1]}`;
            params.zoom = '16';
        }
        else {
            // 官方格式：weight,color,transparency,fillcolor,fillTransparency:坐标;
            // （用竖线分隔是错的，实测返回 20003 UNKNOWN_ERROR）
            params.paths = `5,0x4F8CFF,1,,:${encoded}`;
        }
        if (opts.markers !== false) {
            const start = line[0];
            const end = line[line.length - 1];
            params.markers = `mid,0x22A06B,起:${start[0]},${start[1]}|mid,0xE05C5C,终:${end[0]},${end[1]}`;
        }
        const bytes = await this.rawGetBytes('v3/staticmap', params, signal);
        this.mapCache.set(cacheKey, bytes);
        return bytes;
    }
    /**
     * Plan a route. `mode` maps to the Amap endpoint.
     * Transit requires city1/city2 (origin/destination city names).
     */
    async route(origin, destination, mode, opts = {}, signal) {
        if (mode === 'transit') {
            return this.transitRoute(origin, destination, opts, signal);
        }
        const path = `v5/direction/${mode}`;
        const cacheKey = `route:${mode}:${formatLngLat(origin)}:${formatLngLat(destination)}`;
        const body = await this.request(path, {
            origin: formatLngLat(origin),
            destination: formatLngLat(destination),
            // show_fields 是 v5 的必填开关：不请求就拿不到折线（几何会退化成直线）
            // 和 cost.duration（方案耗时）。这两样都是卡片要用的。
            show_fields: 'polyline,cost',
        }, signal, { cache: this.routeCache, cacheKey, retries: 1 });
        const path0 = body.route.paths[0];
        if (!path0)
            throw new Error('Amap returned no route path');
        const steps = (path0.steps ?? []).map((s) => ({
            instruction: s.instruction ?? '',
            distanceM: readStepDistance(s),
            durationS: readDuration(s),
        }));
        // 真实路线几何：高德把折线拆在每一步里，按步序拼接；缺失时退成起终点直线。
        // 相邻步的首尾点通常重复，交给 dedupeGeometry 去掉。
        const line = [];
        for (const s of path0.steps ?? [])
            line.push(...decodeAmapPolyline(s.polyline));
        const geometry = dedupeGeometry(line);
        return {
            provider: 'amap',
            distanceM: Number(path0.distance ?? 0),
            durationS: readDuration(path0),
            polyline: steps.map((s) => s.instruction).join(' → '),
            points: [origin, destination],
            geometry: geometry.length >= 2 ? geometry : [origin, destination],
            steps,
        };
    }
    async transitRoute(origin, destination, opts, signal) {
        // Amap transit requires city1 (and ideally city2). If resolution failed,
        // surface a readable error instead of a bare INVALID_PARAMS.
        if (!opts.city1 || !opts.city2) {
            const missing = !opts.city1 ? 'city1(起点城市)' : 'city2(终点城市)';
            throw new Error(`公交路径规划需要 ${missing}，但城市解析失败。请改用更具体的地址，或直接提供 "lng,lat" 坐标。`);
        }
        const cacheKey = `route:transit:${formatLngLat(origin)}:${formatLngLat(destination)}:${opts.city1}:${opts.city2}`;
        const body = await this.request('v5/direction/transit/integrated', {
            origin: formatLngLat(origin),
            destination: formatLngLat(destination),
            city1: opts.city1 ?? '',
            city2: opts.city2 ?? '',
            // v5 公交同样需要 show_fields 才返回 cost.duration（方案耗时）。
            show_fields: 'polyline,cost',
        }, signal, { cache: this.routeCache, cacheKey, retries: 1 });
        const transit0 = body.route.transits[0];
        if (!transit0)
            throw new Error('Amap returned no transit plan');
        const steps = (transit0.segments ?? []).map((seg, i) => {
            if (seg.bus?.buslines?.length) {
                const line = seg.bus.buslines[0];
                const from = line.departure_stop?.name ?? '';
                const to = line.arrival_stop?.name ?? '';
                return {
                    instruction: `乘坐 ${line.name ?? '公交'}（${from} → ${to}）`,
                    distanceM: 0,
                    durationS: 0,
                };
            }
            if (seg.walking) {
                return {
                    instruction: `步行 ${i + 1}`,
                    distanceM: Number(seg.walking.distance ?? 0),
                    durationS: readDuration(seg.walking),
                };
            }
            return { instruction: '换乘', distanceM: 0, durationS: 0 };
        });
        const line = dedupeGeometry(transitGeometry(transit0.segments ?? []));
        return {
            provider: 'amap',
            distanceM: Number(transit0.distance ?? 0),
            // v5 公交把方案耗时放在 cost.duration；旧代码只读 duration，导致
            // 公交永远显示"耗时未知"（渲染层用 durationS > 0 判断）。
            durationS: readDuration(transit0),
            polyline: steps.map((s) => s.instruction).join(' → '),
            points: [origin, destination],
            geometry: line.length >= 2 ? line : [origin, destination],
            steps,
        };
    }
    /** Forward geocode: address → coordinates. */
    async geocode(address, signal) {
        const cacheKey = `geo:${address}`;
        const body = await this.request('v3/geocode/geo', { address }, signal, { cache: this.geoCache, cacheKey });
        const first = body.geocodes?.[0];
        if (!first)
            throw new Error(`Amap could not geocode address: ${address}`);
        const [lng, lat] = first.location.split(',').map(Number);
        if (!Number.isFinite(lng) || !Number.isFinite(lat))
            throw new Error('Amap geocode returned invalid location');
        return {
            provider: 'amap',
            formatted: first.formatted_address ?? address,
            location: [lng, lat],
            city: normalizeCity(first.city, first.province),
            district: first.district,
            adcode: first.adcode,
        };
    }
    /** Reverse geocode: coordinates → address. */
    async reverseGeocode(location, signal) {
        const cacheKey = `regeo:${formatLngLat(location)}`;
        const body = await this.request('v3/geocode/regeo', { location: formatLngLat(location) }, signal, { cache: this.geoCache, cacheKey });
        const re = body.regeocode;
        if (!re)
            throw new Error('Amap reverse geocode returned no result');
        const comp = re.addressComponent;
        return {
            provider: 'amap',
            formatted: re.formatted_address ?? formatLngLat(location),
            location,
            city: normalizeCity(comp?.city, comp?.province),
            district: comp?.district,
            province: comp?.province,
            township: comp?.township,
            adcode: comp?.adcode,
        };
    }
    /** POI text search. */
    async poiSearch(keywords, opts, signal) {
        const region = opts.region ?? '';
        const cacheKey = `poi:text:${keywords}:${region}:${opts.cityLimit ? '1' : '0'}`;
        const body = await this.request('v5/place/text', { keywords, region, city_limit: opts.cityLimit ? 'true' : 'false' }, signal, { cache: this.poiCache, cacheKey });
        return (body.pois ?? []).map((p) => {
            const [lng, lat] = p.location.split(',').map(Number);
            return {
                name: p.name,
                location: [lng, lat],
                type: p.type,
                address: p.address,
                tel: p.tel,
            };
        });
    }
    /** POI around search (nearest first by default). */
    async poiAround(location, keywords, opts, signal) {
        const radius = opts.radiusM ? String(opts.radiusM) : '';
        const types = opts.types ?? '';
        const cacheKey = `poi:around:${formatLngLat(location)}:${keywords}:${radius}:${types}`;
        const body = await this.request('v5/place/around', {
            location: formatLngLat(location),
            keywords,
            radius,
            types,
        }, signal, { cache: this.poiCache, cacheKey });
        return (body.pois ?? []).map((p) => {
            const [lng, lat] = p.location.split(',').map(Number);
            return {
                name: p.name,
                location: [lng, lat],
                type: p.type,
                address: p.address,
                tel: p.tel,
                distanceM: p.distance ? Number(p.distance) : undefined,
            };
        });
    }
}
/**
 * Normalize Amap's `city` field to a plain string.
 *
 * 高德对直辖市（北京/上海/天津/重庆）的 addressComponent.city 返回空数组 []，
 * 城市名实际在 province 字段里。数组取首元素，空值回退 province。
 */
function normalizeCity(city, province) {
    const value = Array.isArray(city) ? city[0] : city;
    if (typeof value === 'string' && value)
        return value;
    return typeof province === 'string' && province ? province : '';
}
