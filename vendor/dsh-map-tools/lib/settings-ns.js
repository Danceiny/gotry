import { Config as ConfigSchema } from './config.js';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
/** Namespace the settings page keys this plugin's card to. */
export const MAP_TOOLS_NS = settingsNamespace('dsh-map-tools');
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
    installSettingsSection(ctx, MAP_TOOLS_NS, ConfigSchema, entry, {
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
}
