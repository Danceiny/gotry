/**
 * Browser-local object layer over one Session's durable message-feedback
 * sidecar. The Host owns per-item compare-and-set: every mutation carries the
 * version this controller last observed, and a `version-conflict` reply carries
 * the authoritative item, so a lost race reconciles from the reply itself
 * instead of refetching the whole Session.
 * @module @deepseek-ai/dsh-client-ui-message-feedback/client/controller
 */
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots';
import type { MessageId } from '@deepseek-ai/dsh-client-connection/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { MessageFeedbackDeleteResult, MessageFeedbackItem, MessageFeedbackListResult, MessageFeedbackPutResult, MessageFeedbackRating } from '@deepseek-ai/dsh-message-feedback/types';
/**
 * The three Remote calls this controller needs. The generated face wraps every
 * business result in {@link RemoteResult}: a carrier failure arrives as the
 * `ok: false` branch rather than a rejection, so this controller reads one
 * envelope and never wraps a call to recover a transport error.
 */
export interface MessageFeedbackRemote {
    list: (request: {
        sessionId: SessionId;
    }) => Promise<RemoteResult<MessageFeedbackListResult>>;
    put: (request: {
        sessionId: SessionId;
        messageId: MessageId;
        rating: MessageFeedbackRating;
        note?: string;
        ifVersion: MessageFeedbackItem['version'] | null;
    }) => Promise<RemoteResult<MessageFeedbackPutResult>>;
    delete: (request: {
        sessionId: SessionId;
        messageId: MessageId;
        ifVersion: MessageFeedbackItem['version'];
    }) => Promise<RemoteResult<MessageFeedbackDeleteResult>>;
}
/** Load state of the one list read that seeds every per-message control. */
export type MessageFeedbackStatus = 'cold' | 'loading' | 'ready' | 'error';
/** Immutable view published to every per-message control in one Session. */
export interface MessageFeedbackView {
    status: MessageFeedbackStatus;
    /** Current item per message, keyed by the addressed message id. */
    items: ReadonlyMap<MessageId, MessageFeedbackItem>;
    /** Reason the last load failed, cleared by the next successful load. */
    error: string | null;
}
/** Settled action shape rendered by the message-level controls. */
export type MessageFeedbackActionResult = {
    ok: true;
} | {
    ok: false;
    error: {
        code: string;
        message: string;
    };
};
/**
 * Per-session feedback object layer. One instance backs every per-message
 * control in that Session, so a single list read seeds them all.
 */
export declare class MessageFeedbackController implements HostObservable<MessageFeedbackView> {
    private readonly remote;
    private readonly sessionId;
    private view;
    private readonly listeners;
    private loadPromise;
    private operationTail;
    private disposed;
    /**
     * @param remote - the messageFeedback Remote namespace.
     * @param sessionId - Session owning every addressed assistant message.
     */
    constructor(remote: MessageFeedbackRemote, sessionId: SessionId);
    /** Return the cached immutable view. */
    getSnapshot: () => MessageFeedbackView;
    /** Subscribe to view replacement. */
    subscribe: (listener: () => void) => (() => void);
    /**
     * Load once; a failed load stays retryable.
     * @returns the settled load result, shared by concurrent callers.
     */
    ensure(): Promise<MessageFeedbackActionResult>;
    /**
     * Re-read the authoritative list, collapsing concurrent callers onto one
     * in-flight read.
     *
     * This is the unserialized read used to seed a cold controller, where no
     * mutation can be in flight yet. A reconnect must use {@link resync} instead:
     * an unserialized list response can otherwise arrive after a newer mutation's
     * reply and overwrite the version that mutation just committed.
     * @returns the settled reload result.
     */
    refresh(): Promise<MessageFeedbackActionResult>;
    /**
     * Re-read the list behind this Session's queued mutations, so a reconnect
     * cannot resurrect a version an in-flight mutation already replaced.
     * @returns the settled reload result.
     */
    resync(): Promise<MessageFeedbackActionResult>;
    /**
     * Create or replace feedback for one message, comparing against the version
     * this controller last observed.
     *
     * The note is resolved here rather than by the caller: `mutate` awaits the
     * one list read first, so this body always sees the committed item, while a
     * control that rendered before that read completed would still be holding
     * `undefined`. Omitting `note` therefore keeps whatever is stored; only
     * {@link clearNote} removes one.
     * @param messageId - target assistant message.
     * @param rating - desired judgment.
     * @param note - replacement explanation; omitted keeps the stored note.
     * @returns the settled mutation result.
     */
    rate(messageId: MessageId, rating: MessageFeedbackRating, note?: string): Promise<MessageFeedbackActionResult>;
    /**
     * Replace one message's rating with the opposite judgment, or retract it when
     * the committed rating already matches. The decision reads the committed item
     * inside the serialized mutation, so a click that lands before the first list
     * read still toggles against the stored value rather than the empty view a
     * cold control rendered.
     * @param messageId - target assistant message.
     * @param rating - the judgment the human asked for.
     * @returns the settled mutation result.
     */
    toggle(messageId: MessageId, rating: MessageFeedbackRating): Promise<MessageFeedbackActionResult>;
    /**
     * Drop the note while keeping the rating. Absent feedback needs no call.
     * @param messageId - target assistant message.
     * @returns the settled mutation result.
     */
    clearNote(messageId: MessageId): Promise<MessageFeedbackActionResult>;
    /**
     * Remove feedback for one message. A message with no known item is already
     * in the requested state, so no call is made.
     * @param messageId - target assistant message.
     * @returns the settled mutation result.
     */
    clear(messageId: MessageId): Promise<MessageFeedbackActionResult>;
    /** Commit one put against the observed version and reconcile a conflict. */
    private putCommitted;
    /** Commit one delete against the observed version and reconcile a conflict. */
    private deleteCommitted;
    /** Drop subscribers and refuse further work when the owning fiber unloads. */
    dispose(): void;
    /** Fetch the whole sidecar and publish it as the seeded view. */
    private load;
    /**
     * Serialize one mutation behind this Session's prior mutation so queued
     * operations always compare against the committed version, and translate a
     * transport throw into the same settled shape the controls already render.
     */
    private mutate;
    /**
     * Replace one message's entry, keeping every other entry's identity. Only a
     * `mutate` operation reaches this, and `mutate` refuses admission once the
     * controller is disposed, so no disposal guard belongs here; `publish` is
     * the single place that stops notifying after listeners are dropped.
     */
    private commit;
    /** Replace the view and contain subscriber failures at the observable boundary. */
    private publish;
}
//# sourceMappingURL=controller.d.ts.map