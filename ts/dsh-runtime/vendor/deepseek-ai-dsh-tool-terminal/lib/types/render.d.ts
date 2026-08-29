/** Model and UI rendering for persistent terminal tool results. */
interface RenderedSessionStatusRunning {
    kind: 'running';
}
interface RenderedSessionStatusExited {
    kind: 'exited';
    exitCode: number | null;
    signal: string | null;
}
type RenderedSessionStatus = RenderedSessionStatusRunning | RenderedSessionStatusExited;
interface RenderedSessionSnapshot {
    sessionId: string;
    name?: string;
    type: string;
    pid?: number;
    status: RenderedSessionStatus;
}
interface RenderedSpawnResult extends RenderedSessionSnapshot {
    motd: string;
}
interface RenderedSendResult {
    viewport: string;
    waitReason: 'stdin_read' | 'inferred_idle' | 'timeout' | 'session_exit';
    sessionStatus: RenderedSessionStatus;
    truncated: boolean;
}
interface RenderedSendRead {
    delta: string;
    truncated: boolean;
}
interface RenderedReadResult {
    text: string;
    totalLines: number;
    lineBegin: number;
    lineEnd: number;
    truncated: boolean;
}
/**
 * Bound one complete terminal acknowledgement while preserving UTF-8 cuts.
 * @param text - complete acknowledgement text.
 * @param maxBytes - positive final result cap.
 * @returns bounded text with a truncation marker when it fits.
 */
export declare function boundTerminalText(text: string, maxBytes: number): string;
/**
 * Render one created session and its bounded MOTD.
 * @param result - published spawn result.
 * @param maxBytes - complete UTF-8 result cap.
 * @returns Model-facing session acknowledgement.
 */
export declare function renderSpawn(result: RenderedSpawnResult, maxBytes: number): string;
/**
 * Render one settled interactive send.
 * @param result - settled send outcome.
 * @param maxBytes - complete UTF-8 result cap.
 * @returns Terminal output plus wait/session markers.
 */
export declare function renderSend(result: RenderedSendResult, maxBytes: number): string;
/**
 * Render one incremental background operation read.
 * @param read - consuming operation delta.
 * @returns Delta plus its upstream truncation marker. The generic task control
 *   applies the producer's complete-result cap after adding job status.
 */
export declare function renderSendRead(read: RenderedSendRead): string;
/**
 * Render one bounded historical page.
 * @param result - retained scrollback page.
 * @param maxBytes - complete UTF-8 result cap.
 * @returns Page text plus pagination and truncation markers.
 */
export declare function renderRead(result: RenderedReadResult, maxBytes: number): string;
/**
 * Render owner-visible live sessions.
 * @param sessions - fresh owner-scoped snapshots.
 * @param maxBytes - complete UTF-8 result cap.
 * @returns One line per session or the empty marker.
 */
export declare function renderList(sessions: readonly RenderedSessionSnapshot[], maxBytes: number): string;
export {};
//# sourceMappingURL=render.d.ts.map