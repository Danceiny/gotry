/**
 * Agent-preset default-settings controller.
 *
 * Options and the current default both come from one `agentPresets.list` call:
 * the roster already reports which id a session with no explicit choice gets,
 * so the row needs no schema introspection. Writes target the settings
 * namespace's `default` field, which is what the host resolves at creation.
 */
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client';
import { type SnapshotStore } from '@deepseek-ai/dsh-client-store';
import type { AgentPresetRoster } from '@deepseek-ai/dsh-agent-presets/types';
import type { SettingsDescribeFace, SettingsWireFace } from '@deepseek-ai/dsh-client-ui-settings/client';
/** The agent-preset settings namespace on the host wire. */
export declare const AGENT_PRESET_SETTINGS_NS = "agent-presets";
/**
 * Human text for a rejected wire call. A transport failure rejects with an
 * Error; a host or a runtime can reject with anything, and the surface still
 * has to say something.
 * @param error - the rejection value.
 * @returns the message to show.
 */
export declare function messageOf(error: unknown): string;
/**
 * Persist one preset as the default for sessions created later.
 *
 * The default is a settings field rather than a preset property, so both the
 * General row and the management section write it here — one home for which
 * namespace and field the host resolves at session creation.
 * @param api - the settings wire face.
 * @param id - the preset to make default.
 * @returns the failure message, or undefined once the write landed.
 */
export declare function writeDefaultPreset(api: SettingsWireFace, id: string): Promise<string | undefined>;
/** One selectable preset. */
export interface AgentPresetOption {
    /** Preset id, written to Settings and the label's fallback. */
    id: string;
    /** Whether the preset ships with the deployment or was authored locally. */
    trust: 'system' | 'user';
    /** Display name the preset published, absent when it published none. */
    name?: string;
    /** One sentence on what the preset is for. */
    description?: string;
}
/** One roster entry exactly as the host reports it. */
export type RosterPreset = AgentPresetRoster['presets'][number];
/** The roster, or the message to show in its place. */
export type RosterRead = {
    ok: true;
    value: AgentPresetRoster;
} | {
    ok: false;
    error: string;
};
/**
 * Read the roster, folding both refusal shapes into one message.
 *
 * The wire refuses in two ways — the transport rejects, or it answers an
 * `ok: false` envelope — and every surface treats them identically. Folding
 * them here keeps each store's `load` about what it does with a roster rather
 * than about how the call can fail.
 * @param remote - the agent-preset Remote namespace.
 * @returns the roster, or the message to show in its place.
 */
export declare function readRoster(remote: Pick<ClientRemote, 'agentPresets'>): Promise<RosterRead>;
/**
 * The opening move every roster-backed surface makes: refuse a read that is
 * already in flight, mark the store loading, then read.
 *
 * A surface that gets `undefined` returns without touching its snapshot
 * further — either another read owns it, or this one already wrote the
 * failure. What differs between surfaces starts after this.
 * @param remote - the agent-preset Remote namespace.
 * @param store - the surface's own snapshot store.
 * @returns the roster, or undefined when the caller should return.
 */
export declare function beginRosterRead<S extends {
    status: string;
    error: string | null;
}>(remote: Pick<ClientRemote, 'agentPresets'>, store: SnapshotStore<S>): Promise<AgentPresetRoster | undefined>;
/**
 * The roster entries as the pickers render them: healthy presets only.
 *
 * The chip and the row exist to choose the NEXT session's composition, and a
 * broken preset cannot compose one — offering it would defer the discovery
 * of that fact to a failed session start. The management section renders the
 * full roster (broken rows included) from its own store instead.
 *
 * The chip, the row, and the management section all show the same facts, and
 * `exactOptionalPropertyTypes` makes "absent" and "present as undefined"
 * different shapes — so the spread dance belongs in one place rather than
 * once per store.
 * @param presets - the roster the host answered with.
 * @returns one option per selectable preset, in roster order.
 */
export declare function presetOptions(presets: readonly {
    id: string;
    trust: 'system' | 'user';
    name?: string;
    description?: string;
    broken?: string;
}[]): AgentPresetOption[];
/** Agent-preset settings-row snapshot. */
export interface AgentPresetSettingsState {
    status: 'idle' | 'loading' | 'ready' | 'saving' | 'unavailable' | 'error';
    error: string | null;
    /**
     * Whether this browser may persist the choice at all. `settings.describe` is
     * enabled Host settings path reports a read-only provider as `writable: false`; the
     * row then shows the current default and disables the control rather than
     * offering a write the gateway will refuse.
     */
    writable: boolean;
    currentValue: string;
    options: readonly AgentPresetOption[];
}
/** Reads the roster and persists the chosen default. */
export declare class AgentPresetSettingsController {
    private readonly api;
    private readonly remote;
    private readonly describeFace;
    /** Row snapshot the renderer subscribes to. */
    readonly store: SnapshotStore<AgentPresetSettingsState>;
    /**
     * @param api - the settings wire face (the default write).
     * @param remote - the agent-preset Remote namespace (the roster read).
     * @param describeFace - the shared mirror's describe face (writability source).
     */
    constructor(api: SettingsWireFace, remote: Pick<ClientRemote, 'agentPresets'>, describeFace: SettingsDescribeFace);
    private set;
    /**
     * Load the roster. An empty roster means the deployment composes no
     * presets, which is a valid deployment rather than a failure — the row
     * reports `unavailable` and renders nothing.
     * @returns once the snapshot reflects the host.
     */
    load(): Promise<void>;
    /**
     * Persist one preset as the default for sessions created later. Running
     * sessions keep the composition they were created with, so this never
     * disturbs work in progress.
     * @param id - the preset to make default.
     * @returns once the write settled and the roster was re-read.
     */
    select(id: string): Promise<void>;
}
//# sourceMappingURL=settings-store.d.ts.map