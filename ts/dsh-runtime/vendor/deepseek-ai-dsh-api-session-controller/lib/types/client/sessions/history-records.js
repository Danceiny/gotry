/** Client range access and type narrowing for aligned Session history records. */
/**
 * Narrow aligned wire records to their Client event types without allocation.
 * @param records - validated history transport records.
 * @returns the same record array with typed inner events.
 */
export function historyEntries(records) {
    return records;
}
/**
 * Read the first logical sequence represented by one wire record.
 * @param record - validated scalar event or packed Assistant delta run.
 * @returns inclusive first Session sequence.
 */
export function historyRecordFirstSeq(record) {
    return record.event.seq;
}
/**
 * Read the final logical sequence represented by one wire record.
 * @param record - validated scalar event or packed Assistant delta run.
 * @returns inclusive final Session sequence.
 */
export function historyRecordLastSeq(record) {
    if (record.type === 'event')
        return record.event.seq;
    const length = record.event.type === 'chunkrow/tool-call-chunks'
        ? record.event.data.args.length
        : record.event.data.texts.length;
    return record.event.seq + length - 1;
}
//# sourceMappingURL=history-records.js.map