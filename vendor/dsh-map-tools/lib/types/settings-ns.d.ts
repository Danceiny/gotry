import type { Context } from '@deepseek-ai/cordis';
import type { Config as ConfigType } from './config.js';
/** Namespace the settings page keys this plugin's card to. */
export declare const MAP_TOOLS_NS = "dsh-map-tools";
/**
 * Wire the settings section so the card renders. The values live in the
 * config file; the section carries only the composition entry as its base so
 * the page has something to dispatch on.
 *
 * @param ctx - plugin context.
 * @param entry - the composition entry config (schema defaults).
 * @param reload - rebuild tools after a settings change.
 */
export declare function installSettingsNamespace(ctx: Context, entry: ConfigType, reload: () => void): void;
