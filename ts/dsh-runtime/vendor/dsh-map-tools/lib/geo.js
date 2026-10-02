/**
 * 路线几何的纯函数工具：解码、抽稀、取整。
 *
 * 这些函数是 UI 卡片的输入准备层——它们决定"会话日志里到底存了多少个点"。
 * 全是纯函数（无 I/O、无时钟、无随机），便于单元测试。
 */
/** 会话日志里一条路线最多保留的几何点数（卡片是示意图，不需要原始精度）。 */
export const MAX_GEOMETRY_POINTS = 200;
/** 几何坐标保留的小数位：5 位约 1 米，足够画示意图，又能显著压缩体积。 */
const COORD_DECIMALS = 5;
/** 浮点取整到固定小数位（去掉 -0）。 */
function round(value, decimals) {
    const f = 10 ** decimals;
    const r = Math.round(value * f) / f;
    return Object.is(r, -0) ? 0 : r;
}
/** 一个坐标是否是可用的经纬度。 */
function isValidLngLat(point) {
    return (point !== undefined
        && Number.isFinite(point[0])
        && Number.isFinite(point[1])
        && point[0] >= -180
        && point[0] <= 180
        && point[1] >= -90
        && point[1] <= 90);
}
/**
 * 解码高德的紧凑折线串 `"lng,lat;lng,lat;…"`。
 * 非法片段被跳过（上游数据不可信，宁可少画一点也不抛错）。
 * @param text - 高德 `polyline` 字段原文。
 * @returns 解析出的坐标序列（可能为空）。
 */
export function decodeAmapPolyline(text) {
    if (typeof text !== 'string' || text === '')
        return [];
    const points = [];
    for (const chunk of text.split(';')) {
        const parts = chunk.split(',');
        if (parts.length !== 2)
            continue;
        const lng = Number(parts[0]);
        const lat = Number(parts[1]);
        const point = [lng, lat];
        if (isValidLngLat(point))
            points.push(point);
    }
    return points;
}
/** 去掉相邻重复点（按取整后的坐标比较），并丢弃非法点。 */
export function dedupeGeometry(points) {
    const out = [];
    let lastKey = '';
    for (const point of points) {
        if (!isValidLngLat(point))
            continue;
        const key = `${round(point[0], COORD_DECIMALS)},${round(point[1], COORD_DECIMALS)}`;
        if (key === lastKey)
            continue;
        lastKey = key;
        out.push([round(point[0], COORD_DECIMALS), round(point[1], COORD_DECIMALS)]);
    }
    return out;
}
/** 把坐标投到"等距近似"平面（x 按纬度做 cos 收缩），用于距离比较。 */
function flatten(point, scaleX) {
    return [point[0] * scaleX, point[1]];
}
/** 点到线段的垂距（平面近似）。 */
function perpendicularDistance(point, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    if (dx === 0 && dy === 0)
        return Math.hypot(point[0] - a[0], point[1] - a[1]);
    const t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy);
    const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(point[0] - (a[0] + clamped * dx), point[1] - (a[1] + clamped * dy));
}
/**
 * Douglas–Peucker 抽稀（迭代实现，避免长路线的递归深度）。
 * @param flat - 等距近似平面上的点序列。
 * @param tolerance - 垂距阈值（与 `flat` 同单位）。
 * @returns 保留点的下标，升序，必含首尾。
 */
function douglasPeucker(flat, tolerance) {
    const n = flat.length;
    if (n <= 2)
        return n === 2 ? [0, 1] : [0];
    const keep = new Array(n).fill(false);
    keep[0] = true;
    keep[n - 1] = true;
    const stack = [[0, n - 1]];
    while (stack.length > 0) {
        const range = stack.pop();
        if (range === undefined)
            break;
        const [first, last] = range;
        if (last <= first + 1)
            continue;
        let maxDistance = -1;
        let maxIndex = -1;
        for (let i = first + 1; i < last; i += 1) {
            const distance = perpendicularDistance(flat[i], flat[first], flat[last]);
            if (distance > maxDistance) {
                maxDistance = distance;
                maxIndex = i;
            }
        }
        if (maxIndex >= 0 && maxDistance > tolerance) {
            keep[maxIndex] = true;
            stack.push([first, maxIndex], [maxIndex, last]);
        }
    }
    const indices = [];
    for (let i = 0; i < n; i += 1)
        if (keep[i])
            indices.push(i);
    return indices;
}
/** 等间隔抽稀到不超过 `maxPoints` 个点（抽稀兜底，保留首尾）。 */
function decimate(indices, maxPoints) {
    if (indices.length <= maxPoints)
        return [...indices];
    const out = [];
    const step = (indices.length - 1) / (maxPoints - 1);
    for (let i = 0; i < maxPoints; i += 1) {
        const index = indices[Math.round(i * step)];
        if (index !== undefined && out[out.length - 1] !== index)
            out.push(index);
    }
    const last = indices[indices.length - 1];
    if (last !== undefined && out[out.length - 1] !== last)
        out.push(last);
    return out;
}
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
export function simplifyGeometry(points, maxPoints = MAX_GEOMETRY_POINTS) {
    const limit = Math.max(2, Math.floor(maxPoints));
    const clean = dedupeGeometry(points);
    if (clean.length <= 2)
        return clean;
    const lat0 = clean.reduce((sum, point) => sum + point[1], 0) / clean.length;
    const scaleX = Math.max(0.01, Math.cos((lat0 * Math.PI) / 180));
    const flat = clean.map((point) => flatten(point, scaleX));
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of flat) {
        if (x < minX)
            minX = x;
        if (x > maxX)
            maxX = x;
        if (y < minY)
            minY = y;
        if (y > maxY)
            maxY = y;
    }
    const diagonal = Math.hypot(maxX - minX, maxY - minY);
    // 初始阈值：对角线千分之一；随后逐次放宽，最多 12 轮（≈4000 倍）。
    let tolerance = Math.max(diagonal / 1000, 1e-7);
    let indices = douglasPeucker(flat, tolerance);
    for (let i = 0; i < 12 && indices.length > limit; i += 1) {
        tolerance *= 2;
        indices = douglasPeucker(flat, tolerance);
    }
    if (indices.length > limit)
        indices = decimate(indices, limit);
    return indices.map((index) => clean[index]).filter(isValidLngLat);
}
/**
 * 把几何压成高德风格的紧凑串 `"lng,lat;lng,lat"`（日志体积的一档压缩）。
 * @param points - 已取整的几何点。
 * @returns 紧凑串；空序列返回空串。
 */
export function encodeGeometry(points) {
    return points.map((point) => `${point[0]},${point[1]}`).join(';');
}
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
export function shortPlaceName(formatted, strip) {
    const original = (formatted ?? '').trim();
    const prefixes = strip.filter((part) => typeof part === 'string' && part !== '');
    let text = original;
    // 反复剥直到没得剥：这样与传入顺序无关（"朝阳区" 在 "北京市" 之后也能剥掉），
    // 且前缀重复出现时也能剥干净。每个前缀都非空，所以一定会终止。
    for (let changed = true; changed;) {
        changed = false;
        for (const part of prefixes) {
            if (text.startsWith(part)) {
                text = text.slice(part.length);
                changed = true;
            }
        }
    }
    // 去掉尾部的括号补充（"…国际机场(2号通道)" → "…国际机场"）。
    text = text.replace(/[(（][^)）]*[)）]\s*$/, '').trim();
    return text === '' ? original : text;
}
/**
 * 抽稀到最多 `maxPoints` 个点，再编成紧凑串（用于塞进 URL query）。
 * 静态地图不需要 200 个点，太长会把 URL 撑爆。
 * @param points - 路线几何。
 * @param maxPoints - 点数上限。
 * @returns `"lng,lat;…"`。
 */
export function compactLine(points, maxPoints = 128) {
    return encodeGeometry(simplifyGeometry(points, maxPoints));
}
