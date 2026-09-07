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
export declare function registerRouteTools(ctx: Context, clients: MapClients, disposers?: Array<() => void>): void;
