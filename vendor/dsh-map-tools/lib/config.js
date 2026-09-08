/** Plugin configuration schema. */
import Schema from '@deepseek-ai/schemastery';
/** Amap apply URL (shown as a clickable link in the settings card). */
export const AMAP_APPLY_URL = 'https://console.amap.com/dev/key/app';
export const Config = Schema.object({
    provider: Schema.union(['amap', 'osm'])
        .default('amap')
        .description('数据源：amap=高德地图（推荐，国内数据最全）；osm=免费 OSM 兜底（无需 key，能力有限）'),
    amapKey: Schema.string()
        .role('secret')
        .description(`高德 Web 服务 key。申请：${AMAP_APPLY_URL}（创建应用后选择"Web 服务"类型）`),
    timeoutMs: Schema.number().default(15000).description('单次请求超时（毫秒）'),
    maxQps: Schema.number().default(2).description('高德 API 每秒最大请求数（QPS 上限，默认 2 低于高德常见上限 3，防触发 10021 配额错误）'),
    defaultMode: Schema.union(['driving', 'transit', 'walking', 'bicycling']).default('driving').description('默认路线模式'),
    language: Schema.union(['zh', 'en']).default('zh').description('返回语言'),
});
