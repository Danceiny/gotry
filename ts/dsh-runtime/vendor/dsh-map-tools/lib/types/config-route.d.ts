/**
 * Loopback settings-card route for dsh-map-tools.
 *
 * GET  /dsh-map-tools/config            → non-secret summary (has-amap-key, …)
 * GET  /dsh-map-tools/config?open=true  → open the config file in the editor
 * POST /dsh-map-tools/config            → apply a provider/key/timeout patch
 *
 * Same-origin loopback only (mirrors dsh's own /api fence and the modlens
 * pattern); the two halves of the card read/write a real file.
 */
import type { Context } from '@deepseek-ai/cordis';
/**
 * Register the settings-card route under the web server, when one exists.
 *
 * @param ctx - plugin context.
 * @param reload - rebuild the tools after the card saves (the file write alone
 *   never reaches the registered tool instances; without this the new provider
 *   or key only takes effect on the next plugin reload).
 */
export declare function installConfigRoute(ctx: Context, reload?: () => void): void;
