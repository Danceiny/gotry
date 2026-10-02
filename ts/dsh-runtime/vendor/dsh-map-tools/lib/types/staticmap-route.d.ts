/**
 * Loopback route serving the route-card's static map image.
 *
 * GET /dsh-map-tools/staticmap?w=640&h=260&line=lng,lat;lng,lat;…
 *
 * 为什么走回环路由而不是把图片塞进工具结果：
 *   1. **key 不出宿主**——浏览器只拿到一张本地图片 URL，高德 key 始终在服务端；
 *   2. **不进模型上下文**——工具结果里放 image block 会被适配器跳过/或消耗
 *      视觉额度，而卡片要的只是一张示意图；
 *   3. **懒加载 + 可缓存**——只有卡片真正渲染时才取图，且服务端按参数缓存。
 *
 * 拿不到图（没 key / 配额超限 / 网络问题）时返回错误状态码，客户端卡片会
 * 自动降级为自绘示意图（client/client.js 里的 svg 兜底）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { AmapClient } from './clients/amap.js';
import { type LngLat } from './types.js';
/** 解析 `line=lng,lat;lng,lat;…`；非法片段跳过，超过上限则等间隔截断。 */
export declare function parseLineParam(raw: string | null): LngLat[];
/** 把尺寸参数钳制到合法范围（默认 640×260）。 */
export declare function parseSizeParam(w: string | null, h: string | null): {
    width: number;
    height: number;
};
/**
 * Register the static-map route under the web server, when one exists.
 *
 * @param ctx - plugin context.
 * @param getAmap - reads the current Amap client (rebuilt on every config save).
 */
export declare function installStaticMapRoute(ctx: Context, getAmap: () => AmapClient | undefined): void;
