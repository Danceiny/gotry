/**
 * 路线几何的纯函数工具：解码、抽稀、取整。
 *
 * 这些函数是 UI 卡片的输入准备层——它们决定"会话日志里到底存了多少个点"。
 * 全是纯函数（无 I/O、无时钟、无随机），便于单元测试。
 */
import type { LngLat } from './types.js';
/** 会话日志里一条路线最多保留的几何点数（卡片是示意图，不需要原始精度）。 */
export declare const MAX_GEOMETRY_POINTS = 200;
/**
 * 解码高德的紧凑折线串 `"lng,lat;lng,lat;…"`。
 * 非法片段被跳过（上游数据不可信，宁可少画一点也不抛错）。
 * @param text - 高德 `polyline` 字段原文。
 * @returns 解析出的坐标序列（可能为空）。
 */
export declare function decodeAmapPolyline(text: string | undefined): LngLat[];
/** 去掉相邻重复点（按取整后的坐标比较），并丢弃非法点。 */
export declare function dedupeGeometry(points: readonly LngLat[]): LngLat[];
/**
 * 抽稀一条路线几何，使其点数不超过 `maxPoints`。
 *
 * 阈值从包围盒对角线推导（自适应：长途粗、短途细——40 公里路线约 40 米，
 * 200 米步行路线约 0.2 米），逐步放宽直到达标；若 Douglas–Peucker 仍不达标
 * （例如密集的锯齿路径），再做等间隔兜底。首尾点始终保留，坐标统一取整到
 * 5 位小数。
 *
 * 注意：即使点数没超上限也会跑一遍抽稀——直线上的冗余点同样要丢掉，
 * 因为产物要写进会话日志。
 *
 * @param points - 原始几何点（可为空、可含重复/非法点）。
 * @param maxPoints - 点数上限，默认 {@link MAX_GEOMETRY_POINTS}。
 * @returns 抽稀并取整后的几何（点数 ≤ `maxPoints`）。
 */
export declare function simplifyGeometry(points: readonly LngLat[], maxPoints?: number): LngLat[];
/**
 * 把几何压成高德风格的紧凑串 `"lng,lat;lng,lat"`（日志体积的一档压缩）。
 * @param points - 已取整的几何点。
 * @returns 紧凑串；空序列返回空串。
 */
export declare function encodeGeometry(points: readonly LngLat[]): string;
/**
 * 把高德的长地址裁成可读的短地名。
 *
 * 高德反查返回的 `formatted_address` 是"省市区街道 + 具体位置"连写（如
 * "北京市丰台区右安门街道北京南站"）。把已知的省/市/区/街道前缀依次剥掉、
 * 再去掉尾部括号补充，剩下的就是用户认得的那个名字。
 * 剥完为空则原样返回（宁可长，也不要空）。
 *
 * @param formatted - 高德 `formatted_address`。
 * @param strip - 要剥掉的前缀（省 / 市 / 区 / 街道）。
 * @returns 短地名。
 */
export declare function shortPlaceName(formatted: string, strip: readonly (string | undefined)[]): string;
/**
 * 抽稀到最多 `maxPoints` 个点，再编成紧凑串（用于塞进 URL query）。
 * 静态地图不需要 200 个点，太长会把 URL 撑爆。
 * @param points - 路线几何。
 * @param maxPoints - 点数上限。
 * @returns `"lng,lat;…"`。
 */
export declare function compactLine(points: readonly LngLat[], maxPoints?: number): string;
