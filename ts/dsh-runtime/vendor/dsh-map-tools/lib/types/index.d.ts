/**
 * dsh-map-tools — map & routing tools for DeepSeek Harness.
 *
 * Registers 7 native tools:
 *   map_driving_route / map_transit_route / map_walking_route / map_bicycling_route
 *   map_geocode / map_reverse_geocode / map_poi_search
 *
 * Data sources: OSM/OSRM/Nominatim free fallback by default (zero-key); when
 * amapKey is configured (or provider='amap'), Amap (高德) is used for best
 * CN data quality (transit + POI require Amap).
 */
import type { Context } from '@deepseek-ai/cordis';
import { Config } from './config.js';
import type { Config as ConfigType } from './config.js';
export declare const name = "dsh-map-tools";
export declare const inject: string[];
export { Config };
export declare function apply(ctx: Context, config: ConfigType): void;
