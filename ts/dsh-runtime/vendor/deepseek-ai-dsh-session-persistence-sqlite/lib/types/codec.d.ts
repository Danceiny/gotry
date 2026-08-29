/**
 * Schema-19 physical chunk-row codec. This package owns the durable tags,
 * validation, and row-size limits independently from other persistence formats.
 * @module @deepseek-ai/dsh-session-persistence-sqlite/codec
 */
import type { StreamChunk } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
interface RunDataBase {
    readonly turn: number;
    readonly step: number;
    readonly index: number;
    readonly dt: number[];
}
interface TextRunData extends RunDataBase {
    readonly texts: string[];
}
interface ToolCallRunData extends RunDataBase {
    readonly id: Extract<StreamChunk, {
        type: 'tool-call-delta';
    }>['id'];
    readonly name?: string;
    readonly args: string[];
}
/** One schema-19 packed physical record. */
export type ChunkRow = {
    readonly type: 'text-chunks';
    readonly seq0: number;
    readonly time0: number;
    readonly data: TextRunData;
} | {
    readonly type: 'reasoning-chunks';
    readonly seq0: number;
    readonly time0: number;
    readonly data: TextRunData;
} | {
    readonly type: 'tool-call-chunks';
    readonly seq0: number;
    readonly time0: number;
    readonly data: ToolCallRunData;
};
/** One scalar event or schema-19 packed physical record. */
export type StorageRecord = SessionEvent | ChunkRow;
/** Minimum eligible members in a packed physical record. */
export declare const MIN_PACKED_ROW_MEMBERS = 3;
/** Maximum logical members represented by one packed physical record. */
export declare const MAX_PACKED_ROW_MEMBERS = 1024;
/** Maximum UTF-8 bytes in one packed physical record's data column. */
export declare const MAX_PACKED_DATA_BYTES = 1048576;
/**
 * Pack eligible logical chunk runs into bounded schema-19 records.
 * @param events - logical events in sequence order.
 * @returns scalar and packed physical records in equivalent order.
 */
export declare function packChunkRuns(events: readonly SessionEvent[]): StorageRecord[];
/**
 * Decode one scalar or packed schema-19 record.
 * @param value - parsed physical-record value.
 * @returns the represented logical events.
 */
export declare function decodeStorageRecord(value: unknown): SessionEvent[];
/**
 * Decode one packed row from its exact uncompressed data value. The byte bound
 * rejects oversized input before JSON parsing and avoids serializing it again.
 * @param tag - validated packed physical type.
 * @param seq0 - first represented logical sequence number.
 * @param time0 - first represented logical timestamp.
 * @param serializedData - decoded SQLite data-column text.
 * @returns the represented logical events.
 */
export declare function decodeSerializedChunkRow(tag: ChunkRow['type'], seq0: number, time0: number, serializedData: string): SessionEvent[];
export {};
//# sourceMappingURL=codec.d.ts.map