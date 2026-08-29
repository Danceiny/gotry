/** Locale bundles for the agent-preset settings row, hero chip, header label, and management section. */
/** Locale keys these surfaces render. */
export type AgentPresetSettingsKey = 'title' | 'description' | 'loading' | 'error' | 'userTrust' | 'seatHint' | 'headerHint' | 'nav' | 'sectionIntro' | 'builtIn' | 'setDefault' | 'view' | 'presetStandardName' | 'presetStandardDescription' | 'presetPtcName' | 'presetPtcDescription' | 'presetMinimalName' | 'presetMinimalDescription' | 'presetCordisName' | 'presetCordisDescription' | 'duplicate' | 'duplicateUnavailable' | 'delete' | 'presetId' | 'presetIdPlaceholder' | 'copyOf' | 'displayName' | 'displayNamePlaceholder' | 'inUse' | 'noDescription' | 'builtInGroup' | 'customGroup' | 'brokenBadge' | 'brokenNoCopy' | 'switchRefused' | 'composition' | 'cancel' | 'close' | 'retry' | 'copyTitle' | 'copyIntro' | 'create' | 'creating' | 'creatorDraft' | 'openLocation' | 'showLocation' | 'revealedPathLabel' | 'idRequired' | 'idInvalid' | 'idTaken' | 'deleteTitle' | 'deleteDescription' | 'deleteConfirm' | 'deleting';
/** English copy. */
export declare const en: Record<AgentPresetSettingsKey, string>;
/** Simplified Chinese copy. */
export declare const zh: Record<AgentPresetSettingsKey, string>;
/** Preset roster fields needed to resolve Web display copy. */
export interface PresetDisplaySource {
    /** Stable preset id. */
    readonly id: string;
    /** Whether the deployment ships the preset or the user owns it. */
    readonly trust: 'system' | 'user';
    /** Unlocalized name published by the preset. */
    readonly name?: string;
    /** Unlocalized description published by the preset. */
    readonly description?: string;
}
/** Display copy resolved for the active Web locale. */
export interface PresetDisplayText {
    /** Localized built-in name or the preset's own fallback name. */
    readonly name: string;
    /** Localized built-in description or the preset's own description. */
    readonly description?: string;
}
/**
 * Resolve preset display copy without making user-authored metadata translatable.
 * @param preset - roster row whose copy is being rendered.
 * @param t - active Web locale lookup.
 * @returns localized copy for a known shipped preset, otherwise file metadata.
 */
export declare function presetDisplayText(preset: PresetDisplaySource, t: (key: AgentPresetSettingsKey) => string): PresetDisplayText;
//# sourceMappingURL=locales.d.ts.map