/**
 * Opt-in SQLite persistence provider. Logical sessions remain unchanged;
 * the physical backend packs eligible chunk runs into schema-19 rows.
 * @module @deepseek-ai/dsh-session-persistence-sqlite
 */
import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { Session, SessionEvent, SessionHeader, SessionId, SessionPreparation } from '@deepseek-ai/dsh-session';
import { type BorrowedSessionSource, SessionPersistence, type SessionInspection, type SessionLocation, type SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence';
import type { JournalMode } from './schema.ts';
export { SCHEMA_VERSION } from './schema.ts';
/** Default wait for another SQLite connection's write reservation. */
export declare const DEFAULT_BUSY_TIMEOUT_MS = 5000;
/** Largest busy timeout accepted by SQLite's signed millisecond interface. */
export declare const MAX_BUSY_TIMEOUT_MS = 2147483647;
/** Plugin configuration. */
export interface Config {
    /** SQLite database path, or `:memory:` for an in-process database. */
    path: string;
    /** Durable SQLite journal mode; defaults to `wal`. */
    journalMode?: JournalMode;
    /** Maximum wait for another SQLite connection's lock; defaults to 5,000 ms. */
    busyTimeoutMs?: number;
    /** Maximum cold Session preparations retained for history-to-resume reuse. */
    preparedSessionCacheSize?: number;
    /** Fixed live-event coalescing window; not a backend completion deadline. */
    writeBatchMaxDelayMs?: number;
}
/**
 * SQLite `SessionPersistence` provider with a schema-owned physical codec.
 */
export declare class SqliteSessionPersistence extends SessionPersistence {
    config: Config;
    readonly supportsRawArtifacts = false;
    readonly name = "session-persistence-sqlite";
    static inject: string[];
    static Config: z<Config>;
    private readonly store;
    private readonly coordinator;
    constructor(ctx: Context, config: Config);
    /** Reject self-contained path and ownership failures without loading Node SQLite. */
    protected [Service.init](): Promise<void>;
    /** SQLite has one database, not an independent per-session artifact. */
    locate(_meta: SessionHeader): SessionLocation | undefined;
    create(meta: SessionHeader): Promise<void>;
    ensureMaterialized(session: Session): Promise<void>;
    append(id: SessionId, events: readonly SessionEvent[]): Promise<void>;
    prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation>;
    load(id: SessionId): Promise<SessionInspection>;
    inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection>;
    borrowSession(id: SessionId, signal?: AbortSignal): Promise<BorrowedSessionSource>;
    readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{
        meta: SessionHeader;
        events: SessionEvent[];
    }>;
    list(signal?: AbortSignal): Promise<SessionHeader[]>;
    listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]>;
}
export default SqliteSessionPersistence;
//# sourceMappingURL=index.d.ts.map