/**
 * Photon (photon.komoot.io) geocoding client — free, keyless, reachable on CN
 * networks (unlike nominatim.openstreetmap.org). Backed by OpenStreetMap data.
 *
 * Usage policy: free public service; be reasonable with request rate. Add a
 * `lang` parameter (default zh) for localized results.
 */
import type { GeocodeResult, LngLat } from '../types.js';
export interface PhotonClientOptions {
    timeoutMs: number;
    baseUrl?: string;
    lang?: 'zh' | 'en';
}
export declare class PhotonClient {
    private readonly opts;
    constructor(opts: PhotonClientOptions);
    private get;
    /** Forward geocode. */
    geocode(query: string, signal: AbortSignal): Promise<GeocodeResult>;
    /** Reverse geocode. */
    reverseGeocode(location: LngLat, signal: AbortSignal): Promise<GeocodeResult>;
}
