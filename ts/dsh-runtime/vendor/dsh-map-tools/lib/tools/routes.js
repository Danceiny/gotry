/** Route planning tools: driving / transit / walking / bicycling. */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { AmapQuotaError } from '../clients/amap.js';
import { parseLngLat } from '../types.js';
function routeTool(name, description, mode, clients) {
    const osrmProfile = mode === 'walking' ? 'walking' : mode === 'bicycling' ? 'cycling' : 'driving';
    return defineTool({
        name,
        description,
        parameters: {
            origin: { type: 'string', required: true, description: 'Start point: an address, or "lng,lat" coordinates.' },
            destination: { type: 'string', required: true, description: 'End point: an address, or "lng,lat" coordinates.' },
            waypoints: { type: 'string', description: 'Optional waypoints as "lng,lat;lng,lat" (Amap driving only).' },
            alternatives: { type: 'boolean', description: 'Request alternative routes (default false).' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    provider: { type: 'string' },
                    distanceM: { type: 'number' },
                    durationS: { type: 'number' },
                    polyline: { type: 'string' },
                    steps: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                instruction: { type: 'string' },
                                distanceM: { type: 'number' },
                                durationS: { type: 'number' },
                            },
                        },
                    },
                    alternatives: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                provider: { type: 'string' },
                                distanceM: { type: 'number' },
                                durationS: { type: 'number' },
                                steps: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        additionalProperties: false,
                                        properties: {
                                            instruction: { type: 'string' },
                                            distanceM: { type: 'number' },
                                            durationS: { type: 'number' },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => {
                const v = value;
                const mins = (s) => Math.round(s / 60);
                const providerName = v.provider === 'amap' ? '高德' : 'OSRM';
                const distanceText = v.distanceM >= 1000 ? `${(v.distanceM / 1000).toFixed(1)} 公里` : `${v.distanceM} 米`;
                // Amap v5 transit returns no duration field — report it as unknown.
                const durationText = v.durationS > 0 ? `，约 ${mins(v.durationS)} 分钟` : '';
                const lines = [
                    `${providerName} 路线：${distanceText}${durationText}`,
                ];
                for (const s of v.steps.slice(0, 12)) {
                    lines.push(`- ${s.instruction}`);
                }
                if (v.steps.length > 12)
                    lines.push(`- …（共 ${v.steps.length} 步）`);
                if (v.alternatives?.length) {
                    lines.push(`另有 ${v.alternatives.length} 条备选路线：`);
                    for (const a of v.alternatives) {
                        const aName = a.provider === 'amap' ? '高德' : 'OSRM';
                        lines.push(`  - ${aName}：${(a.distanceM / 1000).toFixed(1)} 公里 / ${mins(a.durationS)} 分钟`);
                    }
                }
                return [{ type: 'text', text: lines.join('\n') }];
            },
        },
        async execute(args, exec) {
            let origin;
            let destination;
            try {
                origin = parseLngLat(args.origin) ?? (await clients.resolve(args.origin, exec.signal));
                destination = parseLngLat(args.destination) ?? (await clients.resolve(args.destination, exec.signal));
            }
            catch (err) {
                // 地址解析阶段的高德配额超限：没有坐标就无法降级，转成可操作提示。
                if (err instanceof AmapQuotaError) {
                    throw new Error(`地址解析暂时不可用（${err.message}）。请稍后重试，或直接提供 "lng,lat" 坐标。`);
                }
                throw err;
            }
            // Provider priority: Amap → OSRM free fallback.
            if (clients.amap) {
                try {
                    let city1;
                    let city2;
                    try {
                        city1 = mode === 'transit' ? await clients.resolveCity(args.origin, exec.signal) : undefined;
                        city2 = mode === 'transit' ? await clients.resolveCity(args.destination, exec.signal) : undefined;
                    }
                    catch (err) {
                        // 城市解析也受高德配额影响；公交没有 city 无法请求，但非公交不受影响。
                        if (err instanceof AmapQuotaError && mode === 'transit') {
                            throw new Error(`公交路线需要城市解析，但高德暂不可用（${err.message}）。请稍后重试，或改用驾车/步行/骑行路线（自动降级 OSRM 免费源）。`);
                        }
                        throw err;
                    }
                    const result = await clients.amap.route(origin, destination, mode, { city1, city2 }, exec.signal);
                    const out = {
                        provider: result.provider,
                        distanceM: result.distanceM,
                        durationS: result.durationS,
                        polyline: result.polyline,
                        steps: result.steps,
                    };
                    if (args.waypoints && mode === 'driving') {
                        out.waypoints = args.waypoints.split(';').map((w) => w.trim()).filter(Boolean).join(';');
                    }
                    return out;
                }
                catch (err) {
                    // 高德配额超限（QPS/日配额）：非公交模式自动降级 OSRM 兜底，
                    // 公交无免费兜底源，给用户可操作的提示。
                    if (err instanceof AmapQuotaError) {
                        if (mode === 'transit') {
                            throw new Error(`高德公交路线暂不可用（${err.message}）。请稍后重试，或改用驾车/步行/骑行路线（自动降级 OSRM 免费源）。`);
                        }
                        const result = await clients.osrm.route(origin, destination, osrmProfile, exec.signal);
                        return {
                            provider: result.provider,
                            distanceM: result.distanceM,
                            durationS: result.durationS,
                            polyline: result.polyline,
                            steps: result.steps,
                        };
                    }
                    throw err;
                }
            }
            // Fallback: OSRM (driving/walking/cycling only; no transit).
            if (mode === 'transit') {
                throw new Error('公交路线需要高德 key。请在插件配置中设置 amapKey（https://console.amap.com/dev/key/app）。');
            }
            const result = await clients.osrm.route(origin, destination, osrmProfile, exec.signal);
            return {
                provider: result.provider,
                distanceM: result.distanceM,
                durationS: result.durationS,
                polyline: result.polyline,
                steps: result.steps,
            };
        },
    });
}
export function registerRouteTools(ctx, clients, disposers = []) {
    disposers.push(ctx.tools.register(routeTool('map_driving_route', '规划驾车路线，返回距离、预计耗时和分段指引。起点/终点支持地址或 "lng,lat" 坐标。', 'driving', clients)));
    disposers.push(ctx.tools.register(routeTool('map_transit_route', '规划公交/地铁换乘路线（需配置高德 amapKey），返回距离、耗时和多段换乘指引。', 'transit', clients)));
    disposers.push(ctx.tools.register(routeTool('map_walking_route', '规划步行路线，返回距离、预计耗时和分段指引。', 'walking', clients)));
    disposers.push(ctx.tools.register(routeTool('map_bicycling_route', '规划骑行路线，返回距离、预计耗时和分段指引。', 'bicycling', clients)));
}
