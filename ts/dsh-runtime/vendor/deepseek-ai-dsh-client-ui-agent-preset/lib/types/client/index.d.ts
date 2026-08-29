/**
 * Agent-preset surface plugin, browser half — four surfaces over one roster:
 * a General-settings row for the default preset, a chip on the new-session
 * screen for the session about to start, a read-only label in the session
 * header, and a settings section that manages the roster (copy, delete,
 * default, and the way into a preset's own files).
 *
 * A running session keeps the composition it began with (the host refuses to
 * adopt an existing session under a different preset). That is what splits
 * the choice from the display: the General row and the hero chip are both
 * before-the-fact, while the header only reports what a session already runs.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis';
export type { AgentPresetLabelInjected, AgentPresetLabelProps } from './AgentPresetLabel.tsx';
export type { AgentPresetRowInjected, AgentPresetRowProps } from './AgentPresetRow.tsx';
export type { AgentPresetSeatInjected, AgentPresetSeatProps } from './AgentPresetSeat.tsx';
export type { AgentPresetSectionInjected, AgentPresetSectionProps } from './AgentPresetSection.tsx';
export type { AgentPresetSeatState } from './seat-store.ts';
export { draftBlocker, type AgentPresetSectionState, type CopyDraft, type PresetRow, type PresetView, } from './section-store.ts';
export type { AgentPresetOption, AgentPresetSettingsState } from './settings-store.ts';
export { AGENT_PRESET_SETTINGS_NS, writeDefaultPreset } from './settings-store.ts';
/** Required services (cordis fiber inject). */
export declare const inject: string[];
/**
 * Mount the General-settings row.
 * @param ctx - the browser plugin context.
 */
export declare function apply(ctx: ClientContext): void;
//# sourceMappingURL=index.d.ts.map