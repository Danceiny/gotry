/** Parse and validate one recorded-session snapshot manifest. */
/** Public `dsh` profile used to control a recorded-session scenario. */
export type SnapshotProfile = 'headless' | 'sdk' | 'acp' | 'web';
/** How a canonical session may be regenerated. */
export type SnapshotRecording = 'live' | 'authored';
/** Request-header ownership metadata for one composition. */
export interface SnapshotHeaderManifest {
    /** Stable class name shared only by byte-identical request headers. */
    class: string;
    /** Whether this scenario owns the class's tokenized header sequence. */
    pin?: true;
    /** Scenario that owns the readable system-prompt sidecar. */
    systemPromptSource?: string;
    /** Scenario that owns the readable tool-schema sidecar. */
    toolSchemasSource?: string;
    /** Child fixture indexes that own distinct system-prompt sidecars. */
    childSystemPrompts?: number[];
    /** Child fixture indexes that own distinct tool-schema sidecars. */
    childToolSchemas?: number[];
    /** Legitimate changed-header count after the initial request header. */
    changes?: number;
}
/** Replay facts that cannot be reconstructed from successful model chunks. */
export interface SnapshotReplayManifest {
    /** A scenario-local `replay.override.json` replaces or patches the recorded model script. */
    override: true;
}
/** Host requirements for a scenario's process-level controller. */
export type SnapshotPlatform = 'posix' | 'pwsh';
/** Deployment permission preset selected before the scenario starts. */
export type SnapshotPermission = 'read-only' | 'workspace-write' | 'danger-full-access';
/** Scenario-local workspace preparation and expected-state metadata. */
export interface SnapshotWorkspaceManifest {
    /** Named setup needed for state Git cannot represent directly. */
    setup?: string;
    /** Whether `workspace.expected/` owns the complete final world state. */
    final?: true;
    /** Place the generated cwd under the user's home instead of a temporary root. */
    parent?: 'home';
}
/** Controller input that cannot enter a session because admission rejects it. */
export interface SnapshotInputAttachment {
    /** Content-addressed attachment id stored in the session message. */
    id: string;
    /** MIME type supplied by the controlling interface. */
    mediaType: string;
    /** Complete base64 payload needed to reconstruct the input block. */
    data: string;
}
/** Controller input bytes or rejected text that the persisted session cannot retain. */
export interface SnapshotInputManifest {
    /** One-shot task absent from the canonical log only when no user event was accepted. */
    task?: string;
    /** Binary inputs keyed by the content-addressed ids retained in session JSONL. */
    attachments?: SnapshotInputAttachment[];
}
/** Optional reference to another scenario's canonical session. */
export interface SnapshotSessionReference {
    /** Repository-relative POSIX path from this scenario directory to the owning `session.jsonl`. */
    source: string;
}
/** Declarative ownership metadata stored beside a recorded session. */
export interface SnapshotManifest {
    /** Manifest format version. */
    version: 1;
    /** Scenario directory name, repeated for reviewable move and copy diagnostics. */
    scenario?: string;
    /** Shipped profile whose public interface controls the scenario. */
    profile: SnapshotProfile;
    /** Composition id whose sole pin owns its profile patches. */
    composition?: string;
    /** Whether the session is live-recordable or deliberately authored. */
    recording?: SnapshotRecording;
    /** Request-header class and sidecar ownership. */
    header?: SnapshotHeaderManifest;
    /** Exceptional replay metadata absent for ordinary successful recordings. */
    replay?: SnapshotReplayManifest;
    /** Optional host requirement; portable scenarios omit it. */
    platform?: SnapshotPlatform;
    /** Explicit process fallback permission preset. */
    permission?: SnapshotPermission;
    /** Test-only string environment additions needed by the declared composition. */
    environment?: Record<string, string>;
    /** Workspace setup and external final-state ownership. */
    workspace?: SnapshotWorkspaceManifest;
    /** Exceptional controller input absent for ordinary log-driven scenarios. */
    input?: SnapshotInputManifest;
    /** Absent when this directory owns `session.jsonl`; present for a read-only borrower. */
    session?: SnapshotSessionReference;
}
/**
 * Parse one `snapshot.yml` without admitting JavaScript YAML tags or unknown fields.
 * @param source - complete manifest text.
 * @param path - diagnostic path.
 * @returns validated manifest metadata.
 */
export declare function parseSnapshotManifest(source: string, path?: string): SnapshotManifest;
//# sourceMappingURL=manifest.d.ts.map