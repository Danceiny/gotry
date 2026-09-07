/** OSRM public server client — free route fallback (no API key). */
import { formatLngLat } from '../types.js';
const PUBLIC_OSRM = 'https://router.project-osrm.org';
export class OsrmClient {
    opts;
    constructor(opts) {
        this.opts = opts;
    }
    /**
     * Plan a route. `profile` maps to OSRM profiles: driving | walking | cycling.
     * OSRM has no transit profile — callers must not request transit here.
     */
    async route(origin, destination, profile, signal) {
        const url = new URL(`${this.opts.baseUrl ?? PUBLIC_OSRM}/route/v1/${profile}/${formatLngLat(origin)};${formatLngLat(destination)}`);
        url.searchParams.set('overview', 'full');
        url.searchParams.set('geometries', 'geojson');
        url.searchParams.set('steps', 'true');
        let res;
        try {
            res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
        }
        catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            throw new Error(`无法访问 OSRM 免费路线服务（${reason}）。部分网络环境下该服务不可达，建议在插件配置中设置高德 amapKey（https://console.amap.com/dev/key/app）以获得稳定的路线规划。`);
        }
        if (!res.ok)
            throw new Error(`OSRM HTTP ${res.status}: ${res.statusText}`);
        const body = (await res.json());
        if (body.code !== 'Ok' || !body.routes?.length) {
            throw new Error(`OSRM error: ${body.code ?? 'unknown'} (no route between the given points)`);
        }
        const route = body.routes[0];
        const steps = [];
        for (const leg of route.legs ?? []) {
            for (const s of leg.steps ?? []) {
                const modifier = s.maneuver?.modifier ? ` (${s.maneuver.modifier})` : '';
                steps.push({
                    instruction: `${s.maneuver?.instruction ?? 'continue'} ${s.name ?? ''}${modifier}`.trim(),
                    distanceM: s.distance ?? 0,
                    durationS: s.duration ?? 0,
                });
            }
        }
        const points = typeof route.geometry === 'string'
            ? []
            : (route.geometry.coordinates ?? []).map(([lng, lat]) => [lng, lat]);
        return {
            provider: 'osrm',
            distanceM: route.distance ?? 0,
            durationS: route.duration ?? 0,
            polyline: JSON.stringify(route.geometry),
            points,
            steps,
        };
    }
}
