/**
 * SQLite storage primitives: transactional append-batch packing, physical
 * reads, schema validation, revisions, repair, and lifecycle closure.
 * @module @deepseek-ai/dsh-session-persistence-sqlite/store
 */
import { type SessionEvent, type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session';
import { type PersistenceBackend, type SessionPersistenceRevision as PersistenceRevision, type SessionPersistenceSnapshot, type StoredPrefix, type StoredSuffix } from '@deepseek-ai/dsh-session-persistence';
import { type JournalMode } from './schema.ts';
/** Storage options resolved by the service provider. */
export interface SqliteStoreOptions {
    readonly path: string;
    readonly journalMode: JournalMode;
    readonly busyTimeoutMs: number;
}
/** SQLite implementation of the coordinator's physical backend hooks. */
export declare class SqliteStore implements PersistenceBackend<number> {
    private readonly options;
    readonly name = "session-persistence-sqlite";
    private db;
    private databaseConstructor;
    private storeIdentity;
    private databasePath;
    private opened;
    private pathReady;
    private ready;
    constructor(options: SqliteStoreOptions);
    /**
     * Validate filesystem ownership without importing or opening Node SQLite.
     * @returns settlement of the store's one path-validation operation.
     */
    validatePath(): Promise<void>;
    /**
     * Lazily open and validate the database on first persistence use.
     * @returns settlement of the store's one database-open operation.
     */
    open(): Promise<void>;
    private preparePath;
    private openDb;
    loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<number> | undefined>;
    readStoredRevision(id: SessionId, signal?: AbortSignal): Promise<PersistenceRevision | undefined>;
    loadStoredFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<StoredSuffix | undefined>;
    appendBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): Promise<void>;
    materializeHeader(meta: SessionHeader): Promise<void>;
    commitRepair(meta: SessionHeader, tornMarker: number | undefined, closers: readonly SessionEvent[]): Promise<void>;
    list(signal?: AbortSignal): Promise<SessionHeader[]>;
    /**
     * Return every materialized header with its source-qualified revision.
     * @param signal - optional cancellation before or after the metadata query.
     * @returns stored headers and revisions without loading event rows.
     */
    listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]>;
    close(): Promise<void>;
    private rowFor;
    private sessionKey;
    private observe;
    private readTransaction;
    private sessionRows;
    private rollback;
    private incrementRevision;
    private tailRows;
    /** Select the bounded physical span that may represent `fromSeq`. */
    private physicalSpanFrom;
    private logicalLastEvent;
    private insertStatement;
    private insertRecord;
    private writeRow;
}
//# sourceMappingURL=store.d.ts.map