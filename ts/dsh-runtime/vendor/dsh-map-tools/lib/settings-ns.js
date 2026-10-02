import { Config as ConfigSchema } from './config.js';
/** Namespace the settings page keys this plugin's card to (plain string since DSH 0.1.2-rc.1). */
export const MAP_TOOLS_NS = 'dsh-map-tools';
/**
 * Wire the settings section so the card renders. The values live in the
 * config file; the section carries only the composition entry as its base so
 * the page has something to dispatch on.
 *
 * GoTry vendored adaptation for DSH 0.2.0-rc.2: SettingsForms replaced the
 * manual per-section API — forms now auto-generate from the plugin's exported
 * Config schema, and the only manual registration left is the page policy via
 * `settings.configure({ auto }, ownerFiber)`. Legacy hosts (installSection)
 * keep the historical wiring so the same build runs on both release lines.
 *
 * @param ctx - plugin context.
 * @param entry - the composition entry config (schema defaults).
 * @param reload - rebuild tools after a settings change.
 */
export function installSettingsNamespace(ctx, entry, reload) {
    ctx.inject(['settings'], (scope) => {
        if (typeof scope.settings.configure === 'function') {
            const dispose = scope.settings.configure({ auto: true }, ctx.fiber);
            if (typeof dispose === 'function' && typeof ctx.effect === 'function') {
                ctx.effect(() => dispose);
            }
            return;
        }
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
