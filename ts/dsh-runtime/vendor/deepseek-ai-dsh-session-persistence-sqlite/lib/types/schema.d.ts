/**
 * SQLite schema ownership and durable-row validation.
 * @module @deepseek-ai/dsh-session-persistence-sqlite/schema
 */
import type { DatabaseSync } from 'node:sqlite';
import { type SessionHeader } from '@deepseek-ai/dsh-session';
/** Current physical-record schema with packed and compressed event rows. */
export declare const SCHEMA_VERSION = 19;
/** Application id reserved for DeepSeek Harness SQLite session databases. */
export declare const SESSION_PERSISTENCE_SQLITE_APPLICATION_ID = 1146308688;
/** A materialized session's metadata and monotonic revision. */
export interface SessionRow {
    readonly id: string;
    readonly version: number;
    readonly created_at: number;
    readonly cwd: string | null;
    readonly parent_session: string | null;
    readonly seed_length: number | null;
    readonly origin: 'subagent' | null;
    readonly incarnation: string;
    readonly revision: number;
    readonly delegation_depth: number | null;
    readonly agent_preset: string | null;
}
/** One physical event row; packed rows may represent multiple logical events. */
export interface EventRow {
    readonly seq: number;
    readonly type: string;
    readonly time: number;
    readonly data: string | Uint8Array;
    readonly source_event_seqs: Uint8Array | null;
    readonly surface_op: string | null;
    readonly is_packed: 0 | 1;
}
/** Durable journal modes accepted by the backend. */
export type JournalMode = 'wal' | 'delete' | 'truncate' | 'persist';
type DatabaseSyncConstructor = typeof import('node:sqlite')['DatabaseSync'];
/**
 * Open and validate a SQLite session database.
 * @param Database - lazily imported Node SQLite constructor.
 * @param path - SQLite path, including `:memory:`.
 * @param journalMode - validated journal pragma.
 * @param busyTimeoutMs - validated maximum wait for a competing SQLite lock.
 * @returns the configured database handle.
 * @throws when connection settings, schema ownership, or SQLite setup cannot be validated.
 */
export declare function openDatabase(Database: DatabaseSyncConstructor, path: string, journalMode: JournalMode, busyTimeoutMs: number): Promise<DatabaseSync>;
/**
 * Recheck schema ownership inside the caller's mutation transaction.
 * @param Database - constructor used to validate the canonical schema.
 * @param db - open owned database with an active immediate transaction.
 * @param path - database location used in ownership diagnostics.
 * @throws when another writer changed the application identity, schema, or version.
 */
export declare function validateSchemaForMutation(Database: DatabaseSyncConstructor, db: DatabaseSync, path: string): void;
/**
 * Decode and validate one durable session row.
 * @param value - value returned by SQLite.
 * @returns a validated session row.
 */
export declare function decodeSessionRow(value: unknown): SessionRow;
/**
 * Decode and validate one durable event row before JSON interpretation.
 * @param value - value returned by SQLite.
 * @returns a validated physical event row.
 */
export declare function decodeEventRow(value: unknown): EventRow;
/**
 * Validate the singleton identity read from durable storage.
 * @param value - value returned by SQLite.
 * @returns the UUID store identity.
 */
export declare function decodeStoreIdentity(value: unknown): string;
/**
 * Reconstruct an immutable session header from a validated metadata row.
 * @param row - validated stored metadata row.
 * @returns the session header.
 */
export declare function rowToMeta(row: SessionRow): SessionHeader;
export {};
//# sourceMappingURL=schema.d.ts.map