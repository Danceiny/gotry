/** Route planning tools: driving / transit / walking / bicycling. */
import type { Context } from '@deepseek-ai/cordis';
import { type AmapClient } from '../clients/amap.js';
import type { OsrmClient } from '../clients/osrm.js';
import type { LngLat } from '../types.js';
/** Shared runtime handle handed to every tool (built by the plugin entry). */
export interface MapClients {
    amap?: AmapClient;
    osrm?: OsrmClient;
    /** Resolve an address (or `lng,lat`) to coordinates; throws with a helpful message. */
    resolve: (text: string, signal: AbortSignal) => Promise<LngLat>;
    /** Resolve the city name for a point (transit queries need city1/city2). */
    resolveCity: (text: string, signal: AbortSignal) => Promise<string>;
    defaultMode: 'driving' | 'transit' | 'walking' | 'bicycling';
}
/** 工具返回值里路线相关字段的签名（`render` 与 `presentationMeta` 共用）。 */
interface RouteValue {
    provider: string;
    distanceM: number;
    durationS: number;
    polyline?: string;
    /** 真实路线几何（`[lng, lat]`），仅用于派生 UI 卡片，不进入模型可见文本。 */
    geometry?: LngLat[];
    /** 起点/终点的人类可读名称（坐标入参时反查得到），同样只给卡片用。 */
    fromName?: string;
    toName?: string;
    steps: Array<{
        instruction: string;
        distanceM: number;
        durationS: number;
    }>;
    alternatives?: Array<{
        provider: string;
        distanceM: number;
        durationS: number;
    }>;
}
/**
 * 持久化给 UI 卡片的路线摘要（`output.presentationMeta` 的产物）。
 *
 * 只放"模型可见文本无法无损表达、且重放时必须还原"的事实：
 * 抽稀后的几何（首尾即起终点）、距离、耗时、分段数、备选条数，
 * 以及起终点的可读名称。具体怎么画是客户端卡片的事，这里不出现任何
 * 布局/样式字段。
 */
export type RouteCardMeta = {
    /** 元数据版本：客户端遇到不认识的版本应降级为纯文本。 */
    v: 1;
    /** 卡片类型判别字段。 */
    kind: 'route';
    provider: 'amap' | 'osrm';
    distanceM: number;
    durationS: number;
    /** 分段数（分段指引的条数）。 */
    stepCount: number;
    /** 备选路线条数。 */
    alternatives: number;
    /** 抽稀后的路线几何 `[lng, lat]`，首尾即起点/终点；不足 2 点时省略。 */
    line?: LngLat[];
    /** 可读的起点名（坐标入参时由反查得到；调用方传的是地名时就是原文）。 */
    fromName?: string;
    /** 可读的终点名。 */
    toName?: string;
};
/**
 * 把工具返回值投影成卡片元数据（纯函数，可单测）。
 *
 * 上游数据不可信（重放的是历史日志），所以每个字段都做窄化；
 * 几何不足两个点时**省略** `line` 而不是报错——客户端会因此退回文本卡片。
 * @param value - 已通过 schema 校验的工具返回值。
 * @returns 卡片元数据。
 */
export declare function routeCardMeta(value: RouteValue): RouteCardMeta;
export declare function registerRouteTools(ctx: Context, clients: MapClients, disposers?: Array<() => void>): void;
export {};
