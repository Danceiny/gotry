/** State owner for the optional local settings-document action. */
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client';
import { type SnapshotStore } from '@deepseek-ai/dsh-client-store';
import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client';
/** Browser state of the Host-owned settings document. */
export interface SettingsDocumentState {
    /** Metadata-loading phase; unavailable means the provider has no local document or the read failed. */
    status: 'idle' | 'loading' | 'ready' | 'unavailable';
    /** Whether one native-open request is in flight. */
    opening: boolean;
    /** Last metadata/native-open diagnostic; UI exposes only localized copy. */
    error: string | null;
}
/** Derives local-document availability from the shared mirror and invokes the pathless Host-owned open operation. */
export declare class SettingsDocumentStore {
    private readonly remote;
    private readonly describeFace;
    /** uSES-safe state source shared by the registered header action. */
    readonly store: SnapshotStore<SettingsDocumentState>;
    private following;
    /**
     * @param api - loopback settings wire face that opens the provider document.
     * @param describeFace - the shared mirror's describe face (`hasDocument` source).
     */
    constructor(remote: Pick<ClientRemote, 'settings'>, describeFace: SettingsDescribeFace);
    /**
     * Begin following the mirror (idempotent) and reflect whether the current
     * provider owns a local document.
     * @returns settlement once the snapshot reflects the mirror.
     */
    load(): Promise<void>;
    /**
     * Open the loaded document once; concurrent gestures collapse behind the in-flight action.
     * @returns after the native-open request settles, or immediately when unavailable/already opening.
     */
    open(): Promise<void>;
    /** Stop following the mirror. */
    dispose(): void;
    private derive;
}
//# sourceMappingURL=settings-document-store.d.ts.map