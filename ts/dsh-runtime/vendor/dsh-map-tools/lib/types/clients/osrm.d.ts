/** OSRM public server client — free route fallback (no API key). */
import type { LngLat, RouteResult } from '../types.js';
export interface OsrmClientOptions {
    timeoutMs: number;
    baseUrl?: string;
}
export declare class OsrmClient {
    private readonly opts;
    constructor(opts: OsrmClientOptions);
    /**
     * Plan a route. `profile` maps to OSRM profiles: driving | walking | cycling.
     * OSRM has no transit profile — callers must not request transit here.
     */
    route(origin: LngLat, destination: LngLat, profile: 'driving' | 'walking' | 'cycling', signal: AbortSignal): Promise<RouteResult>;
}
