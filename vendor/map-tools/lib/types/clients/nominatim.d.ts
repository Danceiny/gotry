/** Nominatim (OpenStreetMap) geocoding client — free fallback, 1 QPS policy. */
import type { GeocodeResult, LngLat } from '../types.js';
export interface NominatimClientOptions {
    timeoutMs: number;
    baseUrl?: string;
    /** User-Agent identifying the client (required by Nominatim usage policy). */
    userAgent: string;
}
export declare class NominatimClient {
    private readonly opts;
    constructor(opts: NominatimClientOptions);
    private get;
    /** Forward geocode. */
    geocode(query: string, signal: AbortSignal): Promise<GeocodeResult>;
    /** Reverse geocode. */
    reverseGeocode(location: LngLat, signal: AbortSignal): Promise<GeocodeResult>;
}
