/** POI search tool. */
import type { Context } from '@deepseek-ai/cordis';
import type { AmapClient } from '../clients/amap.js';
export interface PoiClients {
    amap?: AmapClient;
    /** Resolve an address (or `lng,lat`) to coordinates; throws with a helpful message. */
    resolve: (text: string, signal: AbortSignal) => Promise<[number, number]>;
}
export declare function registerPoiTool(ctx: Context, clients: PoiClients, disposers?: Array<() => void>): void;
