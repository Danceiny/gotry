/**
 * Agent-preset preference row: the preset new sessions are composed from.
 * A running session keeps the composition it began with, so this row never
 * disturbs work in progress.
 */
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { AgentPresetSettingsState } from './settings-store.ts';
import { type AgentPresetSettingsKey } from './locales.ts';
/** Registration-side business face for the host-backed preference. */
export interface AgentPresetRowInjected {
    hooks: {
        /** Agent-preset settings snapshot bound by the renderer as useAgentPreset. */
        agentPreset: SnapshotStore<AgentPresetSettingsState>;
    };
    /** Load the roster when the row first renders. */
    load: () => Promise<void>;
    /** Persist one preset as the default for later sessions. */
    select: (id: string) => Promise<void>;
}
/** Full component props. */
export type AgentPresetRowProps = PropsRuntime<'settings.general.item'> & PropsLocale<'settings.agentPreset'> & InjectFace<AgentPresetRowInjected>;
/**
 * Render the new-session agent-preset selector.
 * @param props - composed slot props.
 * @returns the row, or null when the deployment composes no presets.
 */
export declare function AgentPresetRow({ load, select, useAgentPreset, t }: AgentPresetRowProps): import("react").JSX.Element | null;
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** Agent-preset row copy. */
        'settings.agentPreset': AgentPresetSettingsKey;
    }
}
//# sourceMappingURL=AgentPresetRow.d.ts.map