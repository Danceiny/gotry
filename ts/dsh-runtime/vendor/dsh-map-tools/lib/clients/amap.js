/** Amap (高德) Web Service API client. */
import { formatLngLat } from '../types.js';
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
export class AmapClient {
    opts;
    limiter;
    geoCache = new TtlCache(CACHE_TTL.geo);
    routeCache = new TtlCache(CACHE_TTL.route);
    poiCache = new TtlCache(CACHE_TTL.poi);
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
        const infocode = body.infocode ?? '?';
        const info = body.info ?? 'unknown';
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
     * Plan a route. `mode` maps to the Amap endpoint.
     * Transit requires city1/city2 (origin/destination city names).
     */
    async route(origin, destination, mode, opts = {}, signal) {
        if (mode === 'transit') {
            return this.transitRoute(origin, destination, opts, signal);
        }
        const path = `v5/direction/${mode}`;
        const cacheKey = `route:${mode}:${formatLngLat(origin)}:${formatLngLat(destination)}`;
        const body = await this.request(path, { origin: formatLngLat(origin), destination: formatLngLat(destination) }, signal, { cache: this.routeCache, cacheKey, retries: 1 });
        const path0 = body.route.paths[0];
        if (!path0)
            throw new Error('Amap returned no route path');
        const steps = (path0.steps ?? []).map((s) => ({
            instruction: s.instruction ?? '',
            distanceM: Number(s.distance ?? 0),
            durationS: Number(s.duration ?? 0),
        }));
        return {
            provider: 'amap',
            distanceM: Number(path0.distance ?? 0),
            durationS: Number(path0.duration ?? 0),
            polyline: steps.map((s) => s.instruction).join(' → '),
            points: [origin, destination],
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
                    durationS: Number(seg.walking.duration ?? 0),
                };
            }
            return { instruction: '换乘', distanceM: 0, durationS: 0 };
        });
        return {
            provider: 'amap',
            distanceM: Number(transit0.distance ?? 0),
            durationS: Number(transit0.duration ?? 0),
            polyline: steps.map((s) => s.instruction).join(' → '),
            points: [origin, destination],
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
