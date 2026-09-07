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
    constructor(opts: AmapClientOptions);
    /**
     * 带配额保护的统一请求入口：限速排队 → 缓存命中 → 请求 → 可重试错误退避
     * 重试 → 写入缓存。
     */
    private request;
    /** 裸 GET：拼 URL、带 key、超时 + abort、错误分类。 */
    private rawGet;
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
