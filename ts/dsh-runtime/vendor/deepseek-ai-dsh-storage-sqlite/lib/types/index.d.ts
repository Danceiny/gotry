/**
 * SQLite storage backend for the storage hub: one database file hosts every
 * routed unit, document-per-row (`key TEXT` / `value TEXT` JSON). Registers
 * as backend `sqlite`; the disposer unregisters first, then closes the medium.
 * @module @deepseek-ai/dsh-storage-sqlite
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { KvFacet, StorageBackend } from '@deepseek-ai/dsh-storage';
import { type JournalMode } from './schema.ts';
export { STORAGE_SQLITE_SCHEMA_VERSION, type JournalMode } from './schema.ts';
/** Cordis plugin name. */
export declare const name = "storage-sqlite";
/** The backend registers on the storage hub. */
export declare const inject: string[];
/** Plugin configuration. */
export interface Config {
    /**
     * Filesystem path to the SQLite database file. The special value `:memory:`
     * opens an in-process database (tests). On filesystems with POSIX modes,
     * missing directories and databases are created owner-only; existing path
     * modes are preserved. Filesystem setup errors other than an existing
     * database fail the open. The backend does not protect confidentiality or
     * integrity when another principal can replace the database entry in its
     * parent directory.
     */
    path: string;
    /**
     * SQLite `journal_mode` pragma. `wal` (the default) suits local disks; pick
     * a rollback-journal mode (`delete`/`truncate`/`persist`) on filesystems
     * where WAL's shared-memory files do not work (network mounts). See
     * {@link JournalMode}.
     */
    journalMode?: JournalMode;
}
/** Schemastery validator for {@link Config}. */
export declare const Config: z<Config>;
/**
 * The SQLite {@link StorageBackend}. Owns one `DatabaseSync` connection and
 * the open-unit table; `kv.open` validates names, enforces the per-unit
 * version stamp in `units`, and ensures the unit's record tables.
 */
export declare class SqliteStorageBackend implements StorageBackend {
    /** The key-value facet; the only shape this backend serves. */
    readonly kv: KvFacet;
    private readonly ready;
    /** Open (or still-opening) units by name; presence is the double-open guard. */
    private readonly units;
    private closing;
    /**
     * @param config - Validated plugin configuration.
     */
    constructor(config: Config);
    private openUnit;
    private materializeUnit;
    /**
     * Close every open unit and release the database. Idempotent; concurrent
     * and repeated calls resolve once teardown finishes.
     * @returns resolution after the medium is released.
     */
    close(): Promise<void>;
    private doClose;
}
/**
 * Register the SQLite backend as `sqlite` on the storage hub. The disposer
 * unregisters the name first, then closes the backend.
 * @param ctx - Plugin context (must inject `storage`).
 * @param config - Validated plugin configuration.
 */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map