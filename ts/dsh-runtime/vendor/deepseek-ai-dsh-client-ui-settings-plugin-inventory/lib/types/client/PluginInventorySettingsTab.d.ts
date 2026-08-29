import { type ReactNode } from 'react';
import type { PluginInventorySnapshot } from '@deepseek-ai/dsh-api-remotes/client';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
/** Registration-side Remote face used by the section. */
export interface PluginInventorySettingsTabInjected {
    /** Read a current Host inventory snapshot. */
    list: () => Promise<PluginInventorySnapshot>;
}
/** Full component props assembled by the Settings slot renderer. */
export type PluginInventorySettingsTabProps = PropsRuntime<'settings.plugins.tab'> & PropsLocale<'settings.pluginInventory'> & InjectFace<PluginInventorySettingsTabInjected>;
/** Render the read-only current Loader inventory. */
export declare function PluginInventorySettingsTab({ list, t }: PluginInventorySettingsTabProps): ReactNode;
//# sourceMappingURL=PluginInventorySettingsTab.d.ts.map