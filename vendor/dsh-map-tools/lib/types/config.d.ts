/** Plugin configuration schema. */
import Schema from '@deepseek-ai/schemastery';
export interface Config {
    /**
     * Provider selection:
     * - 'amap': 高德地图（Web 服务 API key，免费申请，推荐）
     * - 'osm': 免费 OSM/OSRM 兜底（无 key，能力有限）
     */
    provider: 'amap' | 'osm';
    /** Amap (高德) Web Service API key. */
    amapKey?: string;
    /** Per-request timeout in milliseconds. */
    timeoutMs: number;
    /** Amap requests per second cap (高德个人 key QPS 上限低，默认 2 留余量). */
    maxQps: number;
    /** Default route mode when a generic route is requested. */
    defaultMode: 'driving' | 'transit' | 'walking' | 'bicycling';
    /** Language hint for providers that support it. */
    language: 'zh' | 'en';
}
/** Amap apply URL (shown as a clickable link in the settings card). */
export declare const AMAP_APPLY_URL = "https://console.amap.com/dev/key/app";
export declare const Config: Schema<Config>;
