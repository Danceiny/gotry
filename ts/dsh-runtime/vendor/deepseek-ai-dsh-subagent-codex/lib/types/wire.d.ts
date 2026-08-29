/**
 * Minimal Codex app-server 0.149.1 protocol adapter. The shared JSON-RPC
 * transport owns framing and request correlation; this module owns only the
 * product methods, current thread/turn association, unattended approval
 * responses, and terminal-answer selection.
 *
 * @module @deepseek-ai/dsh-subagent-codex/wire
 */
import type { Readable, Writable } from 'node:stream';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { SubagentResult } from '@deepseek-ai/dsh-subagent';
import type { CodexPermissionMode } from './run.ts';
/** Product facts owned by the Codex wire after publication. */
export interface CodexWireFailureFacts {
    readonly stage: 'turn-start' | 'turn';
    readonly category: 'limit' | 'access-policy' | 'service' | 'transport' | 'product-error' | 'invalid-result' | 'unknown';
    readonly httpStatus?: number | undefined;
}
/**
 * One app-server connection and its single ephemeral thread/turn.
 *
 * The class deliberately exposes no generic request surface. Supporting
 * another product method must first become part of the provider contract.
 */
export declare class CodexAppServerWire {
    private readonly input;
    private readonly permissionMode;
    private readonly model?;
    private readonly transport;
    private readonly fatal;
    private threadId;
    private turnId;
    private pendingTurnId;
    private turnCompleted;
    private readonly earlyTurnNotifications;
    private lastFinalAnswer;
    private lastUnphasedAnswer;
    private diagnostic;
    private failure;
    private diagnosticOrder;
    private observationOrder;
    private pendingDiagnostic;
    private inputEnded;
    private terminalObserved;
    private closed;
    constructor(input: Readable, output: Writable, permissionMode: CodexPermissionMode, model?: string | undefined);
    /** Start reading app-server frames. */
    start(): void;
    /**
     * Whether protocol output ended before a terminal turn notification.
     * @returns `true` only for an early protocol close without a terminal turn.
     */
    endedBeforeTerminal(): boolean;
    /**
     * Perform the required app-server initialize/initialized handshake.
     * @param signal - unpublished-start cancellation.
     */
    initialize(signal: AbortSignal): Promise<void>;
    /**
     * Create the run's private ephemeral thread and retain its identity.
     * @param cwd - parent Session workspace.
     * @param signal - unpublished-start cancellation.
     */
    startThread(cwd: string, signal: AbortSignal): Promise<void>;
    /**
     * Submit the one text-only task and wait for this thread/turn's authoritative
     * terminal notification.
     * @param texts - already validated task text blocks.
     * @param signal - local cancellation for the published run.
     * @returns the shared subagent result.
     */
    runTurn(texts: readonly string[], signal: AbortSignal): Promise<SubagentResult>;
    /**
     * Best-effort remote cancellation. Local settlement and process teardown
     * remain authoritative when the child no longer accepts protocol requests.
     */
    interrupt(): void;
    /**
     * The best non-commentary answer observed so far, preserving exact bytes.
     * @returns the selected final or nullable-phase text block, if any.
     */
    collectOutput(): ContentBlock[];
    /**
     * The latest safe unattended permission fact observed for this run.
     * @returns provider-authored diagnostic text, when one was observed.
     */
    collectDiagnostic(): string | undefined;
    /**
     * The structured failure fact observed for this published turn.
     * Call only after a non-completed return or rejection from {@link runTurn}.
     * @returns the fixed stage/category pair and optional HTTP status.
     */
    collectFailure(): CodexWireFailureFacts;
    /** Detach JSON-RPC listeners and reject outstanding requests. Idempotent. */
    close(): void;
    private guarded;
    private fail;
    private readonly onInputError;
    private readonly onOutputError;
    private readonly onInputEnd;
    private observePendingTurnId;
    private commitTurnId;
    /**
     * Validate the request's thread and turn association.
     * @returns `true` when the matching turn is still provisional, so the caller
     * defers its diagnostic until `commitTurnId()`.
     */
    private validateRunIds;
    private recordRequestDiagnostic;
    private recordDiagnostic;
    private recordFailure;
    private nextObservationOrder;
    private recordDeclinedItem;
    private handleServerRequest;
    private handleNotification;
}
//# sourceMappingURL=wire.d.ts.map