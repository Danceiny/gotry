/** Shared types for dsh-map-tools. */
/** A normalized geo point: [longitude, latitude]. */
export type LngLat = [number, number];
/** One route leg/step instruction, normalized across providers. */
export interface RouteStep {
    /** Human-readable instruction, e.g. "沿北京路向西行驶 300 米". */
    instruction: string;
    /** Distance in meters. */
    distanceM: number;
    /** Duration in seconds. */
    durationS: number;
}
/** Normalized route result, provider-agnostic. */
export interface RouteResult {
    /** Provider that produced this result: 'amap' | 'osrm'. */
    provider: 'amap' | 'osrm';
    /** Total distance in meters. */
    distanceM: number;
    /** Total duration in seconds. */
    durationS: number;
    /** Compact polyline string (Amap format) or GeoJSON line, depending on provider. */
    polyline: string;
    /**
     * Waypoint coordinates [lng, lat] along the route (sampled).
     * @deprecated 历史字段：高德分支只放了起终点，语义不可靠；新代码用 {@link geometry}。
     */
    points: LngLat[];
    /**
     * 真实路线几何，按行进顺序的 `[lng, lat]` 点序列（首尾即起点/终点）。
     * 未抽稀——可能上千个点，只用于派生 UI 卡片的示意图；
     * 需要持久化时必须先过 `simplifyGeometry`（见 `src/geo.ts`）。
     */
    geometry: LngLat[];
    /** Step-by-step instructions. */
    steps: RouteStep[];
}
/** Normalized geocode result. */
export interface GeocodeResult {
    /** Provider: 'amap' | 'nominatim' | 'photon'. */
    provider: 'amap' | 'nominatim' | 'photon';
    /** Matched display name. */
    formatted: string;
    /** Normalized [lng, lat]. */
    location: LngLat;
    /** Optional structured fields. */
    city?: string;
    district?: string;
    /** 省/直辖市（反查时用于把长地址裁成可读地名）。 */
    province?: string;
    /** 街道/镇/乡（反查时用于把长地址裁成可读地名）。 */
    township?: string;
    adcode?: string;
}
/** Normalized POI search result. */
export interface PoiResult {
    name: string;
    location: LngLat;
    /** POI category/type label. */
    type?: string;
    address?: string;
    tel?: string;
    /** Distance in meters from the query location (around-search only). */
    distanceM?: number;
}
/** One coordinate pair from a `lng,lat` or `lat,lng` string. */
export declare function parseLngLat(text: string): LngLat | null;
/** Format a pair as `lng,lat`. */
export declare function formatLngLat([lng, lat]: LngLat): string;
