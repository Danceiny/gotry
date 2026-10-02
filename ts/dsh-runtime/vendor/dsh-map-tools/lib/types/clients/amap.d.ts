/** Amap (高德) Web Service API client. */
import type { GeocodeResult, LngLat, PoiResult, RouteResult } from '../types.js';
/** 配额类错误（QPS 或日配额超限）。retryable=true 时短期内重试可能成功
 *  （QPS 超限），false 表示重试无意义（日配额已用尽）。 */
export declare class AmapQuotaError extends Error {
    readonly infocode: string;
    readonly retryable: boolean;
    constructor(infocode: string, message: string, retryable: boolean);
}
export interface AmapClientOptions {
    key: string;
    timeoutMs: number;
    /** 每秒最大高德请求数（默认 2，低于高德常见 3 QPS 上限，留余量防 10021）。 */
    maxQps?: number;
}
export declare class AmapClient {
    private readonly opts;
    private readonly limiter;
    private readonly geoCache;
    private readonly routeCache;
    private readonly poiCache;
    /** 静态地图字节缓存：同一张图不重复计费。 */
    private readonly mapCache;
    constructor(opts: AmapClientOptions);
    /**
     * 带配额保护的统一请求入口：限速排队 → 缓存命中 → 请求 → 可重试错误退避
     * 重试 → 写入缓存。
     */
    private request;
    /** 裸 GET：拼 URL、带 key、超时 + abort、错误分类。 */
    private rawGet;
    /**
     * 把高德返回的错误码翻译成面向用户的异常（key / 配额 / 其它）。
     * @param infocode - 高德 `infocode`。
     * @param info - 高德 `info` 文案。
     */
    private throwAmapError;
    /**
     * 裸 GET，返回二进制（静态地图）。高德出错时返回 JSON 而不是图片，
     * 所以响应不是 image/* 就按错误体解析。
     */
    private rawGetBytes;
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
    staticMap(line: readonly LngLat[], opts: {
        width: number;
        height: number;
        markers?: boolean;
    }, signal: AbortSignal): Promise<Uint8Array>;
    /**
     * Plan a route. `mode` maps to the Amap endpoint.
     * Transit requires city1/city2 (origin/destination city names).
     */
    route(origin: LngLat, destination: LngLat, mode: 'driving' | 'transit' | 'walking' | 'bicycling', opts: {
        city1?: string;
        city2?: string;
    } | undefined, signal: AbortSignal): Promise<RouteResult>;
    private transitRoute;
    /** Forward geocode: address → coordinates. */
    geocode(address: string, signal: AbortSignal): Promise<GeocodeResult>;
    /** Reverse geocode: coordinates → address. */
    reverseGeocode(location: LngLat, signal: AbortSignal): Promise<GeocodeResult>;
    /** POI text search. */
    poiSearch(keywords: string, opts: {
        region?: string;
        cityLimit?: boolean;
    }, signal: AbortSignal): Promise<PoiResult[]>;
    /** POI around search (nearest first by default). */
    poiAround(location: LngLat, keywords: string, opts: {
        radiusM?: number;
        types?: string;
    }, signal: AbortSignal): Promise<PoiResult[]>;
}
