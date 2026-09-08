/** Geocoding tools: address → coordinates, and reverse. */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { parseLngLat } from '../types.js';
export function registerGeocodeTools(ctx, clients, disposers = []) {
    disposers.push(ctx.tools.register(defineTool({
        name: 'map_geocode',
        description: '把地址文本转换为经纬度坐标。支持中文地址、模糊地址。',
        parameters: {
            address: { type: 'string', required: true, description: '地址文本，如 "北京市朝阳区建国路88号"。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    provider: { type: 'string' },
                    formatted: { type: 'string' },
                    location: {
                        type: 'array',
                        items: { type: 'number' },
                    },
                    city: { type: 'string' },
                    district: { type: 'string' },
                },
            },
            render: (_args, value) => {
                const v = value;
                const name = v.provider === 'amap' ? '高德' : v.provider === 'nominatim' ? 'Nominatim(OSM)' : v.provider === 'photon' ? 'Photon(OSM)' : 'inline';
                const area = v.city ? `（${v.city}${v.district ? ` ${v.district}` : ''}）` : '';
                return [{
                        type: 'text',
                        text: `${name} 解析 "${v.formatted}" → 经纬度 ${v.location[0]}, ${v.location[1]}${area}`,
                    }];
            },
        },
        async execute(args, exec) {
            const coord = parseLngLat(args.address);
            if (coord) {
                // Input already looks like coordinates — return as-is.
                return { provider: 'inline', formatted: args.address, location: coord };
            }
            if (clients.amap) {
                const r = await clients.amap.geocode(args.address, exec.signal);
                return { provider: r.provider, formatted: r.formatted, location: r.location, city: r.city, district: r.district };
            }
            // Free sources (Photon/Nominatim) are unreliable for Chinese addresses.
            // Try them, but convert any failure into an actionable prompt.
            let lastError = '免费地理编码服务不可用';
            if (clients.photon) {
                try {
                    const r = await clients.photon.geocode(args.address, exec.signal);
                    return { provider: r.provider, formatted: r.formatted, location: r.location, city: r.city, district: r.district };
                }
                catch (err) {
                    lastError = err instanceof Error ? err.message : String(err);
                }
            }
            if (clients.nominatim) {
                try {
                    const r = await clients.nominatim.geocode(args.address, exec.signal);
                    return { provider: r.provider, formatted: r.formatted, location: r.location, city: r.city, district: r.district };
                }
                catch (err) {
                    lastError = err instanceof Error ? err.message : String(err);
                }
            }
            throw new Error(`免费数据源无法可靠解析中文地址："${args.address}"（${lastError}）。请直接提供 "lng,lat" 坐标，或在插件配置中设置高德 amapKey（https://console.amap.com/dev/key/app）。`);
        },
    })));
    disposers.push(ctx.tools.register(defineTool({
        name: 'map_reverse_geocode',
        description: '把经纬度坐标转换为结构化地址（含城市、区县）。',
        parameters: {
            location: { type: 'string', required: true, description: '经纬度，格式 "lng,lat"，如 "116.397428,39.90923"。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    provider: { type: 'string' },
                    formatted: { type: 'string' },
                    location: {
                        type: 'array',
                        items: { type: 'number' },
                    },
                    city: { type: 'string' },
                    district: { type: 'string' },
                },
            },
            render: (_args, value) => {
                const v = value;
                const name = v.provider === 'amap' ? '高德' : v.provider === 'nominatim' ? 'Nominatim(OSM)' : v.provider === 'photon' ? 'Photon(OSM)' : '未知';
                return [{ type: 'text', text: `${name}：${v.formatted}` }];
            },
        },
        async execute(args, exec) {
            const coord = parseLngLat(args.location);
            if (!coord)
                throw new Error(`无效的经纬度格式：${args.location}（应为 "lng,lat"）`);
            if (clients.amap) {
                const r = await clients.amap.reverseGeocode(coord, exec.signal);
                return { provider: r.provider, formatted: r.formatted, location: r.location, city: r.city, district: r.district };
            }
            let lastError = '免费地理编码服务不可用';
            if (clients.photon) {
                try {
                    const r = await clients.photon.reverseGeocode(coord, exec.signal);
                    return { provider: r.provider, formatted: r.formatted, location: r.location, city: r.city, district: r.district };
                }
                catch (err) {
                    lastError = err instanceof Error ? err.message : String(err);
                }
            }
            if (clients.nominatim) {
                try {
                    const r = await clients.nominatim.reverseGeocode(coord, exec.signal);
                    return { provider: r.provider, formatted: r.formatted, location: r.location, city: r.city, district: r.district };
                }
                catch (err) {
                    lastError = err instanceof Error ? err.message : String(err);
                }
            }
            throw new Error(`免费逆地理编码服务不可用（${lastError}）。请配置高德 amapKey（https://console.amap.com/dev/key/app）以获得稳定结果。`);
        },
    })));
}
