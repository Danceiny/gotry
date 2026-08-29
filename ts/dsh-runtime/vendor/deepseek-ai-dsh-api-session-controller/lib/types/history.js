/** Cold Session history pagination and live-event source. */
var __addDisposableResource = (this && this.__addDisposableResource) || function (env, value, async) {
    if (value !== null && value !== void 0) {
        if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
        var dispose, inner;
        if (async) {
            if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
            dispose = value[Symbol.asyncDispose];
        }
        if (dispose === void 0) {
            if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
            dispose = value[Symbol.dispose];
            if (async) inner = dispose;
        }
        if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
        if (inner) dispose = function() { try { inner.call(this); } catch (e) { return Promise.reject(e); } };
        env.stack.push({ value: value, dispose: dispose, async: async });
    }
    else if (async) {
        env.stack.push({ async: true });
    }
    return value;
};
var __disposeResources = (this && this.__disposeResources) || (function (SuppressedError) {
    return function (env) {
        function fail(e) {
            env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
            env.hasError = true;
        }
        var r, s = 0;
        function next() {
            while (r = env.stack.pop()) {
                try {
                    if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
                    if (r.dispose) {
                        var result = r.dispose.call(r.value);
                        if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) { fail(e); return next(); });
                    }
                    else s |= 1;
                }
                catch (e) {
                    fail(e);
                }
            }
            if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
            if (env.hasError) throw env.error;
        }
        return next();
    };
})(typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session';
import { isChunkRow, packChunkRuns } from '@deepseek-ai/dsh-session/chunk-rows';
import { SessionQueryError } from '@deepseek-ai/dsh-session-query';
import { TypertRemoteFailure } from '@deepseek-ai/dsh-typert-protocol';
const DEFAULT_MAX_MESSAGES = 50;
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message']);
/** Implements cold-safe history operations delegated by the Session Controller. */
export class SessionHistoryController {
    ctx;
    promote;
    closeFollowers = new Set();
    /**
     * @param ctx - Host context carrying Session query and projection services.
     * @param promote - starts ordinary Session activation after snapshot delivery.
     */
    constructor(ctx, promote) {
        this.ctx = ctx;
        this.promote = promote;
        ctx.effect(() => () => {
            for (const close of this.closeFollowers)
                close();
            this.closeFollowers.clear();
        }, 'session-controller.history');
    }
    /**
     * Read one message-aligned history page without activating an Agent.
     * @param request - durable address and backwards-page cursor.
     * @param signal - caller cancellation for persistence reads.
     * @returns a contiguous event page.
     */
    async page(request, signal) {
        const env_1 = { stack: [], error: void 0, hasError: false };
        try {
            validatePageRequest(request);
            const source = __addDisposableResource(env_1, await this.sourceFor(request.address, signal, false), false);
            signal.throwIfAborted();
            const sourceLog = source.events;
            const sourceCursor = sourceLog.at(-1)?.seq ?? -1;
            if (request.throughSeq > sourceCursor) {
                reject('bad-request', `session page through seq ${String(request.throughSeq)} is past cursor ${String(sourceCursor)}`, {});
            }
            /* v8 ignore next -- Session and persistence validation guarantee a dense zero-based event prefix. */
            if (request.throughSeq >= 0 && sourceLog[request.throughSeq]?.seq !== request.throughSeq) {
                reject('internal', `session log does not contain through seq ${String(request.throughSeq)}`, {});
            }
            const page = paginate(sourceLog, request.beforeSeq, request.maxMessages ?? DEFAULT_MAX_MESSAGES, request.throughSeq);
            const records = pageRecords(page.events);
            return {
                records,
                hasMore: page.hasMore,
            };
        }
        catch (e_1) {
            env_1.error = e_1;
            env_1.hasError = true;
        }
        finally {
            __disposeResources(env_1);
        }
    }
    /**
     * Follow events appended after an initial cursor on one durable address.
     * @param request - durable address and last committed sequence already held by the caller.
     * @param signal - stream cancellation owned by the Remote carrier.
     * @returns a complete opening snapshot followed by gap-free event frames.
     */
    async *follow(request, signal) {
        validateFollowRequest(request);
        const { address } = request;
        const target = addressId(address);
        const buffered = [];
        let snapshotCursor;
        let wake;
        const notify = () => {
            const resume = wake;
            wake = undefined;
            resume?.();
        };
        const follower = { closed: false };
        const close = () => {
            follower.closed = true;
            notify();
        };
        this.closeFollowers.add(close);
        const disposeEvent = this.ctx.on('session/event', (session, event) => {
            if (session.id !== target)
                return;
            buffered.push(event);
            notify();
        }, { global: true });
        const disposeCreated = this.ctx.on('session/created', (session) => {
            if (session.id !== target)
                return;
            // Constructor seed events have no session/event notification. Normally
            // only the end-seed suffix is new; if persistence advanced after the
            // opening observation, replay everything beyond that snapshot cursor.
            const suffix = session.events.slice(snapshotCursor === undefined
                ? session.firstLiveSeq
                : snapshotCursor + 1);
            buffered.unshift(...suffix);
            notify();
        }, { global: true });
        const onAbort = () => { notify(); };
        signal.addEventListener('abort', onAbort, { once: true });
        try {
            const env_2 = { stack: [], error: void 0, hasError: false };
            try {
                const source = __addDisposableResource(env_2, await this.sourceFor(address, signal, true), false);
                const events = source.events;
                signal.throwIfAborted();
                const cursor = source.cursor;
                snapshotCursor = cursor;
                const page = paginate(events, undefined, request.maxMessages ?? DEFAULT_MAX_MESSAGES);
                yield {
                    type: 'snapshot',
                    header: source.header,
                    cursor,
                    records: pageRecords(page.events),
                    hasMore: page.hasMore,
                    projections: source.projections === undefined
                        ? { asOfSeq: cursor, values: {} }
                        : projectionBlock(source.projections),
                };
                if (address.kind === 'session' && source.source === 'prepared') {
                    const promotion = source.retain();
                    try {
                        this.promote(promotion);
                    }
                    catch (error) {
                        promotion[Symbol.dispose]();
                        throw error;
                    }
                }
                let nextSeq = cursor + 1;
                while (!follower.closed && !signal.aborted) {
                    const item = buffered.shift();
                    if (item === undefined) {
                        await new Promise((resolve) => { wake = resolve; });
                        continue;
                    }
                    if (item.seq < nextSeq)
                        continue;
                    if (item.seq !== nextSeq) {
                        reject('internal', `session event stream skipped seq ${String(nextSeq)}`, {});
                    }
                    nextSeq++;
                    yield entryFor(item);
                }
            }
            catch (e_2) {
                env_2.error = e_2;
                env_2.hasError = true;
            }
            finally {
                __disposeResources(env_2);
            }
        }
        finally {
            this.closeFollowers.delete(close);
            signal.removeEventListener('abort', onAbort);
            disposeCreated();
            disposeEvent();
        }
    }
    async sourceFor(address, signal, withProjections) {
        const sessionId = addressId(address);
        try {
            const observation = await this.ctx.sessionQuery.observeSession(sessionId, {
                signal,
                projectionMode: withProjections || address.kind === 'subagent' ? 'all' : 'none',
            });
            if (observation.header.cwd === undefined) {
                observation[Symbol.dispose]();
                rejectNotFound(address);
            }
            try {
                validateAddress(address, observation.header, observation.projections);
            }
            catch (error) {
                observation[Symbol.dispose]();
                throw error;
            }
            return observation;
        }
        catch (error) {
            if (error instanceof SessionQueryError
                && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND')
                rejectNotFound(address);
            throw error;
        }
    }
}
function projectionBlock(snapshot) {
    return {
        asOfSeq: snapshot.asOfSeq,
        // Projection definitions validate whole JSON values before snapshot publication.
        values: snapshot.values,
    };
}
function validatePageRequest(request) {
    if (!Number.isSafeInteger(request.throughSeq) || request.throughSeq < -1) {
        reject('bad-request', 'throughSeq must be an integer greater than or equal to -1', {});
    }
    if (request.beforeSeq !== undefined
        && (!Number.isSafeInteger(request.beforeSeq) || request.beforeSeq < 0)) {
        reject('bad-request', 'beforeSeq must be a non-negative safe integer', {});
    }
    if (request.maxMessages !== undefined
        && (!Number.isSafeInteger(request.maxMessages) || request.maxMessages <= 0)) {
        reject('bad-request', 'maxMessages must be a positive safe integer', {});
    }
}
function validateFollowRequest(request) {
    if (request.maxMessages !== undefined
        && (!Number.isSafeInteger(request.maxMessages) || request.maxMessages <= 0)) {
        reject('bad-request', 'maxMessages must be a positive safe integer', {});
    }
}
function addressId(address) {
    return address.kind === 'session' ? address.sessionId : address.childSessionId;
}
function validateAddress(address, header, projections) {
    if (address.kind === 'session') {
        if (header.origin === 'subagent') {
            reject('agent-busy', 'subagent Sessions require their durable parent address', {
                reason: 'use subagent delivery for this child session',
            });
        }
        return;
    }
    if (header.origin !== 'subagent' || header.parentSession !== address.parentSessionId) {
        reject('subagent-unauthorized', 'subagent does not belong to the supplied parent', {
            childSessionId: address.childSessionId,
        });
    }
    const identity = projections?.values.subagent;
    if (identity === null) {
        reject('subagent-catalog-diagnostic', 'subagent descriptor is corrupt', {
            parentSessionId: address.parentSessionId,
            childSessionId: address.childSessionId,
            reason: 'corrupt',
        });
    }
    if (identity === undefined || identity.seq < (header.seedLength ?? 0)) {
        reject('subagent-catalog-diagnostic', 'subagent descriptor is unavailable', {
            parentSessionId: address.parentSessionId,
            childSessionId: address.childSessionId,
            reason: 'unsupported',
        });
    }
    if (identity.mode !== address.mode) {
        reject('subagent-unauthorized', 'subagent mode does not match the supplied address', {
            childSessionId: address.childSessionId,
        });
    }
}
function rejectNotFound(address) {
    if (address.kind === 'session') {
        reject('session-not-found', `session "${address.sessionId}" not found`, { sessionId: address.sessionId });
    }
    reject('subagent-not-found', 'subagent is unavailable', {
        parentSessionId: address.parentSessionId,
        childSessionId: address.childSessionId,
    });
}
function reject(code, message, details) {
    throw new TypertRemoteFailure({ code, message, details });
}
function paginate(events, beforeSeq, maxMessages, throughSeq = events.at(-1)?.seq ?? -1) {
    const end = Math.min(throughSeq + 1, beforeSeq ?? throughSeq + 1);
    let count = 0;
    let cut = 0;
    for (let index = end - 1; index >= 0; index--) {
        const event = events[index];
        if (!MESSAGE_TYPES.has(event.type) || !isAppendSurfaceEvent(event))
            continue;
        count++;
        const sources = event.sourceEventSeqs;
        let groupStart = event.seq;
        if (sources !== undefined) {
            for (const source of sources)
                groupStart = Math.min(groupStart, source);
        }
        if (count >= maxMessages) {
            cut = groupStart;
            break;
        }
    }
    return { events: events.slice(cut, end), hasMore: cut > 0 };
}
function entryFor(event) {
    return {
        type: 'event',
        // Session.append validates and freezes event data as JSON before publication.
        event: event,
    };
}
function chunkEntryFor(row) {
    switch (row.type) {
        case 'text-chunks':
            return {
                type: 'chunks',
                event: { type: 'chunkrow/text-chunks', seq: row.seq0, time: row.time0, data: row.data },
            };
        case 'reasoning-chunks':
            return {
                type: 'chunks',
                event: { type: 'chunkrow/reasoning-chunks', seq: row.seq0, time: row.time0, data: row.data },
            };
        case 'tool-call-chunks':
            return {
                type: 'chunks',
                event: { type: 'chunkrow/tool-call-chunks', seq: row.seq0, time: row.time0, data: row.data },
            };
    }
}
/** Encode one bounded logical page without changing its pagination cut. */
function pageRecords(events) {
    return packChunkRuns(events).map(record => isChunkRow(record)
        ? chunkEntryFor(record)
        : entryFor(record));
}
//# sourceMappingURL=history.js.map