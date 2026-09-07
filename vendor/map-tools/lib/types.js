/** Shared types for dsh-map-tools. */
/** One coordinate pair from a `lng,lat` or `lat,lng` string. */
export function parseLngLat(text) {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
    if (!m)
        return null;
    const lng = Number(m[1]);
    const lat = Number(m[2]);
    if (lng < -180 || lng > 180 || lat < -90 || lat > 90)
        return null;
    return [lng, lat];
}
/** Format a pair as `lng,lat`. */
export function formatLngLat([lng, lat]) {
    return `${lng},${lat}`;
}
