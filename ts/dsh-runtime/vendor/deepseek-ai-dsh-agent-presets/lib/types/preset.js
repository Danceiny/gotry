/** Agent-preset vocabulary shared by discovery, mounting, and consumers. */
/**
 * Ids a preset directory may use.
 *
 * The id becomes a path segment, so this is a containment boundary rather than
 * a style rule: `..`, a separator, or an absolute-looking name would place the
 * composition outside the root the deployment authorised. Discovery shares it:
 * a directory whose name no copy could ever claim is not a preset slot.
 */
export const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/;
/**
 * No configured root supplies the requested preset.
 *
 * Separate from a mount failure because the two mean different things to a
 * caller: an unknown id is a bad request, while an unusable composition is a
 * broken preset the deployment must fix.
 */
export class UnknownPresetError extends Error {
    presetId;
    available;
    constructor(
    /** The id that was requested. */
    presetId, 
    /** Ids the roster does supply, for the caller to offer instead. */
    available) {
        super(`agent-presets: preset "${presetId}" not found (available: ${available.join(', ') || 'none'})`);
        this.presetId = presetId;
        this.available = available;
    }
}
/**
 * The session's composition is fixed: its conversation has started, so its
 * history was produced under the preset it runs and swapping the composition
 * would leave logged tool calls the new one cannot make.
 */
export class PresetLockedError extends Error {
    sessionId;
    presetId;
    constructor(
    /** The session whose composition is already fixed. */
    sessionId, 
    /** The preset that was refused. */
    presetId) {
        super(`agent-presets: session "${sessionId}" has already started; its agent preset is fixed`);
        this.sessionId = sessionId;
        this.presetId = presetId;
    }
}
/** A preset exists but its composition cannot be installed. */
export class PresetMountError extends Error {
    presetId;
    reason;
    constructor(
    /** The preset whose composition failed. */
    presetId, 
    /** Why it failed, without this package's own message prefix. */
    reason, options) {
        super(`agent-presets: preset "${presetId}" failed to mount: ${reason}`, options);
        this.presetId = presetId;
        this.reason = reason;
    }
}
//# sourceMappingURL=preset.js.map