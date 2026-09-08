/** Geocoding tools: address → coordinates, and reverse. */
import type { Context } from '@deepseek-ai/cordis';
import type { AmapClient } from '../clients/amap.js';
import type { NominatimClient } from '../clients/nominatim.js';
import type { PhotonClient } from '../clients/photon.js';
export interface GeocodeClients {
    amap?: AmapClient;
    nominatim?: NominatimClient;
    photon?: PhotonClient;
}
export declare function registerGeocodeTools(ctx: Context, clients: GeocodeClients, disposers?: Array<() => void>): void;
