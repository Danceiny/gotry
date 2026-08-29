/**
 * One opened SQLite KV unit: prepared per-table statements over the
 * `u_<unit>_<table>` record tables plus this unit's row in the shared
 * `unit_globals` table. Each primitive is a single statement, so atomicity
 * comes from SQLite itself — no explicit transactions, and no write queue
 * (write ordering is the caller's responsibility per the KV contract).
 * @module @deepseek-ai/dsh-storage-sqlite/unit
 */
import type { DatabaseSync } from 'node:sqlite';
import type { KvUnit, KvUnitDescriptor } from '@deepseek-ai/dsh-storage';
/**
 * The SQLite {@link KvUnit}. Constructed by the backend AFTER the unit's
 * record tables exist; statements are prepared once here and reused for every
 * primitive. Values are stored as JSON text in the `value` column.
 */
export declare class SqliteKvUnit implements KvUnit {
    private readonly descriptor;
    private readonly onClose;
    private readonly tables;
    private readonly globalUpsert;
    private readonly globalSelect;
    private closed;
    /**
     * @param db - Open database handle owned by the backend (never closed here).
     * @param descriptor - Validated descriptor whose record tables already exist.
     * @param onClose - Backend callback releasing this unit's open-name slot.
     */
    constructor(db: DatabaseSync, descriptor: KvUnitDescriptor, onClose: () => void);
    loadAll(): Promise<{
        tables: Record<string, Record<string, unknown>>;
        global: unknown;
    }>;
    /** Parse one stored value column, mapping bad JSON to `malformed-medium`. */
    private parseValue;
    putRecord(table: string, key: string, value: unknown): Promise<void>;
    deleteRecord(table: string, key: string): Promise<void>;
    setGlobal(value: unknown): Promise<void>;
    close(): Promise<void>;
    /**
     * Run one synchronous primitive behind the closed guard, mapping a throw to
     * a rejection so the Promise-returning contract never throws synchronously.
     */
    private settle;
    private ensureOpen;
    private statementsFor;
}
//# sourceMappingURL=unit.d.ts.map