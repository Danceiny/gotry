/** Client operation results spanning the Session and subagent Remote calls. */
/**
 * Fold a rejected carrier operation into the Client Session failure vocabulary.
 * @param error - rejection from a Remote or local carrier call.
 * @returns the failure branch of a Client Session result.
 */
export function transportResult(error) {
    return {
        ok: false,
        error: {
            code: 'internal',
            message: error instanceof Error ? error.message : String(error),
            details: {},
        },
    };
}
//# sourceMappingURL=result.js.map