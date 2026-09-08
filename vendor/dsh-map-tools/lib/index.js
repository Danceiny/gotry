import { AmapClient } from './clients/amap.js';
import { OsrmClient } from './clients/osrm.js';
import { NominatimClient } from './clients/nominatim.js';
import { PhotonClient } from './clients/photon.js';
import { registerRouteTools } from './tools/routes.js';
import { registerGeocodeTools } from './tools/geocode.js';
import { registerPoiTool } from './tools/poi.js';
import { parseLngLat } from './types.js';
import { Config } from './config.js';
import { readConfig } from './config-file.js';
import { installConfigRoute } from './config-route.js';
import { installSettingsNamespace } from './settings-ns.js';
export const name = 'dsh-map-tools';
export const inject = ['tools'];
export { Config };
/** Build (or rebuild) the provider clients. Priority: config-file (settings
 * card) → schema defaults. */
function buildClients(config) {
    // The settings card writes ~/.dsh-map-tools/config.json; when it holds
    // values, they win over the composition-entry schema defaults.
    let fileConfig = {};
    try {
        fileConfig = readConfig();
    }
    catch (error) {
        console.error(`[dsh-map-tools] config read failed, using schema defaults: ${error}`);
    }
    const provider = fileConfig.provider ?? config.provider;
    const amapKey = fileConfig.amapKey ?? config.amapKey;
    const timeoutMs = fileConfig.timeoutMs ?? config.timeoutMs;
    const maxQps = fileConfig.maxQps ?? config.maxQps;
    // Provider selection: exactly one primary source per provider.
    const amap = provider === 'amap' && amapKey
        ? new AmapClient({ key: amapKey, timeoutMs, maxQps })
        : undefined;
    const osrm = new OsrmClient({ timeoutMs });
    const nominatim = new NominatimClient({
        timeoutMs,
        userAgent: 'dsh-map-tools/0.1.0 (DeepSeek Harness plugin; contact: https://github.com/HorusJiang/dsh-map-tools)',
    });
    const photon = new PhotonClient({ timeoutMs, lang: config.language });
    /** Resolve an address (or `lng,lat`) to coordinates, using the active provider. */
    async function resolve(text, signal) {
        const coord = parseLngLat(text);
        if (coord)
            return coord;
        if (amap) {
            const r = await amap.geocode(text, signal);
            return r.location;
        }
        // Free sources cannot reliably geocode Chinese addresses (Nominatim is
        // blocked on many CN networks, Photon returns 400 for CJK queries) — give
        // an actionable prompt instead of a raw provider error.
        throw new Error(`免费数据源无法可靠解析中文地址："${text}"。请直接提供 "lng,lat" 坐标，或在插件配置中设置高德 amapKey（https://console.amap.com/dev/key/app）。`);
    }
    /** Resolve the city code for a point (transit queries need city1/city2).
     *  Amap v5 transit accepts only an adcode (e.g. "110000" / "110101") or a
     *  citycode (e.g. "010") — bare city names like "北京" are rejected with
     *  INVALID_PARAMS. Prefer the adcode from geocoding; fall back to the city
     *  name as a last resort. */
    async function resolveCity(text, signal) {
        const coord = parseLngLat(text);
        if (amap) {
            const r = coord ? await amap.reverseGeocode(coord, signal) : await amap.geocode(text, signal);
            if (r.adcode)
                return r.adcode;
            const city = r.city ?? '';
            return city.replace(/市$/, '');
        }
        return '';
    }
    return { amap, osrm, nominatim, photon, resolve, resolveCity };
}
/** Register every tool under the current clients; returns a disposer. */
function registerAll(ctx, clients) {
    const disposers = [];
    const routeClients = {
        amap: clients.amap,
        osrm: clients.osrm,
        resolve: clients.resolve,
        resolveCity: clients.resolveCity,
        defaultMode: 'driving',
    };
    registerRouteTools(ctx, routeClients, disposers);
    registerGeocodeTools(ctx, { amap: clients.amap, nominatim: clients.nominatim, photon: clients.photon }, disposers);
    registerPoiTool(ctx, { amap: clients.amap, resolve: clients.resolve }, disposers);
    return () => {
        for (const d of disposers)
            d();
    };
}
export function apply(ctx, config) {
    // Register tools under an effect: Cordis runs the returned disposer both on
    // explicit reload (we call it) and on plugin unload (fiber disposal).
    let disposeTools = () => { };
    ctx.effect(() => {
        disposeTools = registerAll(ctx, buildClients(config));
        return () => disposeTools();
    });
    const reload = () => {
        disposeTools();
        disposeTools = registerAll(ctx, buildClients(config));
    };
    // The settings card route + namespace (modlens pattern): the card reads and
    // writes ~/.dsh-map-tools/config.json through the loopback route, and the
    // tools rebuild on a save (route POST → reload).
    installConfigRoute(ctx, reload);
    installSettingsNamespace(ctx, config, reload);
}
