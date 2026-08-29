/**
 * Fixed physical-record compression for SQLite. Schema-owned functions
 * encode logical events and decode tagged rows before persistence consumers
 * observe them.
 * @module @deepseek-ai/dsh-session-persistence-sqlite/compression
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { type StorageRecord } from './codec.ts';
import type { EventRow } from './schema.ts';
/** One physical row ready for SQLite parameter binding. */
export interface BoundRecord {
    readonly seq: number;
    readonly type: string;
    readonly time: number;
    readonly data: string | Uint8Array;
    readonly sourceEventSeqs: Uint8Array | null;
    readonly surfaceOp: string | null;
    readonly isPacked: 0 | 1;
}
/**
 * Decode one physical SQLite row into its complete logical event span.
 * @param row - detached SQLite event row.
 * @returns every logical event represented by the row.
 */
export declare function decodeRow(row: EventRow): SessionEvent[];
/**
 * Convert a storage record to SQLite column values.
 * @param record - scalar event or packed chunk record.
 * @returns column values for one physical insert.
 */
export declare function bindRecord(record: StorageRecord): BoundRecord;
/**
 * Validate and flatten physical rows into their logical prefix. A malformed
 * row or logical gap is committed corruption when a later valid turn end
 * exists; otherwise it starts a removable physical tail.
 * @param rows - physical rows ordered by their first logical sequence.
 * @param base - logical sequence expected from the first selected row.
 * @returns the contiguous logical prefix and optional physical deletion base.
 */
export declare function scanRows(rows: readonly EventRow[], base?: number): {
    preserved: SessionEvent[];
    tornFrom?: number;
};
//# sourceMappingURL=compression.d.ts.map