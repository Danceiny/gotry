import { Config as ConfigSchema } from './config.js';
/** Namespace the settings page keys this plugin's card to (plain string for DSH 0.1.5-alpha.1, unchanged from 0.1.2-alpha.3). */
export const MAP_TOOLS_NS = 'dsh-map-tools';
/**
 * Wire the settings section so the card renders. The values live in the
 * config file; the section carries only the composition entry as its base so
 * the page has something to dispatch on.
 *
 * @param ctx - plugin context.
 * @param entry - the composition entry config (schema defaults).
 * @param reload - rebuild tools after a settings change.
 */
export function installSettingsNamespace(ctx, entry, reload) {
    ctx.inject(['settings'], (scope) => {
        scope.settings.installSection(ctx, MAP_TOOLS_NS, ConfigSchema, entry, {
            setSource: (current) => {
                // The tools read ~/.dsh-map-tools/config.json then the composition
                // entry; the section's own value is a dispatch key for the card and
                // is never a tool configuration source.
                void current;
            },
            onChange: () => {
                reload();
            },
        });
    });
}
