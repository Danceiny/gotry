/** Browser owner for the Gateway multiplexed Remote stream socket. */
import { parseRemoteStreamServerMessage, REMOTE_STREAM_MUX_PATH, } from "../stream-protocol.js";
import { randomUUID } from '@deepseek-ai/dsh-util-crypto';
const INTERNAL_BASE = 'http://dsh.internal';
const RECONNECT_BASE_MS = 500;
const RECONNECT_FACTOR = 2;
const RECONNECT_MAX_MS = 10_000;
/** One Host-reported Remote stream failure. */
export class RemoteStreamError extends Error {
    /** Stable carrier or Gateway error category. */
    code;
    /** Host-provided structured failure context. */
    details;
    /**
     * @param code - stable Gateway or business error category.
     * @param message - Host-provided failure description.
     * @param details - Host-provided structured failure context.
     */
    constructor(code, message, details) {
        super(message);
        this.name = 'RemoteStreamError';
        this.code = code;
        this.details = details;
    }
}
/** Physical Remote stream socket failure that may be retried by a domain transport. */
export class RemoteStreamCarrierError extends Error {
    /**
     * @param message - physical carrier failure description.
     * @param options - optional causal error.
     */
    constructor(message, options) {
        super(message, options);
        this.name = 'RemoteStreamCarrierError';
    }
}
/** Keep one physical WebSocket and share it among independently cancellable Remote streams. */
export class RemoteStreamMuxClient {
    socket;
    cancelCandidate;
    keepAlive;
    keepAliveAbort;
    streams = new Map();
    waiters = new Set();
    running = false;
    disposed = false;
    /** Start the persistent physical connection; repeated calls are inert. */
    start() {
        if (this.running || this.disposed)
            return;
        this.running = true;
        this.maintain();
    }
    /**
     * Open one logical stream on the persistent physical connection.
     * @param endpoint - Typert Remote stream endpoint.
     * @param payload - endpoint request encoded on the wire.
     * @param signal - cancellation for this logical stream.
     * @returns Host items until completion, cancellation, or failure.
     */
    async *open(endpoint, payload, signal) {
        this.start();
        signal.throwIfAborted();
        const streamId = randomUUID();
        const inbox = new StreamInbox();
        let carrier;
        let opened = false;
        let terminal = false;
        const abort = () => { inbox.fail(signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
        try {
            const socket = await this.waitForSocket(signal);
            signal.throwIfAborted();
            carrier = socket;
            this.streams.set(streamId, inbox);
            this.send(socket, { type: 'open', streamId, endpoint, payload });
            opened = true;
            while (true) {
                const frame = await inbox.next();
                signal.throwIfAborted();
                if (frame.type === 'item') {
                    yield frame.value;
                    continue;
                }
                terminal = true;
                if (frame.type === 'error') {
                    throw new RemoteStreamError(frame.error.code, frame.error.message, frame.error.details);
                }
                return;
            }
        }
        finally {
            signal.removeEventListener('abort', abort);
            this.streams.delete(streamId);
            if (opened && !terminal && carrier?.readyState === WebSocket.OPEN) {
                this.send(carrier, { type: 'cancel', streamId });
            }
        }
    }
    /**
     * Permanently stop reconnecting, close the physical socket, and fail every active logical stream.
     * @returns once the background connection loop has stopped.
     */
    async close() {
        if (!this.disposed) {
            this.disposed = true;
            this.running = false;
            const error = new Error('api gateway: Remote stream client disposed');
            this.keepAliveAbort?.abort(error);
            this.keepAliveAbort = undefined;
            this.failAll(error);
            for (const waiter of [...this.waiters])
                waiter.reject(error);
            this.cancelCandidate?.(error);
            const socket = this.socket;
            this.socket = undefined;
            socket?.close(1000, 'disposed');
        }
        await this.keepAlive;
    }
    connect() {
        const socket = new WebSocket(remoteStreamUrl());
        const connecting = new Promise((resolve, reject) => {
            let settled = false;
            const rejectCandidate = (error) => {
                settled = true;
                socket.removeEventListener('open', opened);
                socket.removeEventListener('error', failed);
                socket.removeEventListener('message', received);
                socket.removeEventListener('close', closed);
                this.cancelCandidate = undefined;
                socket.close();
                reject(error);
            };
            const opened = () => {
                settled = true;
                this.cancelCandidate = undefined;
                this.socket = socket;
                for (const waiter of [...this.waiters])
                    waiter.resolve(socket);
                resolve(socket);
            };
            const failed = () => {
                if (!settled) {
                    rejectCandidate(new RemoteStreamCarrierError('api gateway: Remote stream WebSocket failed to open'));
                    return;
                }
                const error = new RemoteStreamCarrierError('api gateway: Remote stream WebSocket failed');
                this.lost(socket, error);
                socket.close();
            };
            const closed = () => {
                if (!settled) {
                    rejectCandidate(new RemoteStreamCarrierError('api gateway: Remote stream WebSocket closed before opening'));
                    return;
                }
                this.lost(socket);
            };
            const received = (event) => { this.receive(socket, event.data); };
            this.cancelCandidate = rejectCandidate;
            socket.addEventListener('open', opened, { once: true });
            socket.addEventListener('error', failed, { once: true });
            socket.addEventListener('message', received);
            socket.addEventListener('close', closed, { once: true });
        });
        return connecting;
    }
    waitForSocket(signal) {
        signal.throwIfAborted();
        if (this.socket?.readyState === WebSocket.OPEN)
            return Promise.resolve(this.socket);
        if (this.disposed)
            return Promise.reject(new Error('api gateway: Remote stream client disposed'));
        this.start();
        return new Promise((resolve, reject) => {
            const aborted = () => { waiter.reject(signal.reason); };
            const cleanup = () => {
                this.waiters.delete(waiter);
                signal.removeEventListener('abort', aborted);
            };
            const waiter = {
                resolve: (socket) => {
                    cleanup();
                    resolve(socket);
                },
                reject: (error) => {
                    cleanup();
                    // AbortSignal.reason belongs to the caller and may intentionally be a non-Error sentinel.
                    // oxlint-disable-next-line typescript/prefer-promise-reject-errors
                    reject(error);
                },
            };
            this.waiters.add(waiter);
            signal.addEventListener('abort', aborted, { once: true });
        });
    }
    receive(socket, data) {
        if (socket !== this.socket)
            return;
        try {
            if (typeof data !== 'string')
                throw new Error('api gateway: Remote stream WebSocket requires text messages');
            const frame = parseRemoteStreamServerMessage(data);
            this.streams.get(frame.streamId)?.push(frame);
        }
        catch (error) {
            const failure = new RemoteStreamCarrierError('api gateway: invalid Remote stream frame', { cause: error });
            this.failAll(failure);
            this.lost(socket, failure);
            socket.close(4002, 'invalid Remote stream frame');
        }
    }
    lost(socket, error = new RemoteStreamCarrierError('api gateway: Remote stream WebSocket closed')) {
        if (this.socket !== socket)
            return;
        this.socket = undefined;
        this.failAll(error);
        this.maintain(error);
    }
    maintain(previousFailure) {
        if (!this.running)
            return;
        if (this.keepAlive !== undefined) {
            void this.keepAlive.then(() => { this.maintain(previousFailure); });
            return;
        }
        const abort = new AbortController();
        this.keepAliveAbort = abort;
        const task = this.reconnect(abort.signal, previousFailure);
        this.keepAlive = task;
        void task.then(() => {
            this.keepAlive = undefined;
            this.keepAliveAbort = undefined;
        });
    }
    async reconnect(signal, previousFailure) {
        let attempt = 0;
        let failure = previousFailure;
        while (this.isRunning(signal) && this.socket?.readyState !== WebSocket.OPEN) {
            if (failure !== undefined) {
                attempt += 1;
                console.warn(`[api-gateway] Remote stream connection unavailable, retry #${String(attempt)}`, failure);
                await sleep(backoffDelay(attempt), signal);
                if (!this.isRunning(signal))
                    return;
            }
            try {
                await this.connect();
                return;
            }
            catch (error) {
                if (!this.isRunning(signal))
                    return;
                failure = error;
            }
        }
    }
    isRunning(signal) {
        return this.running && !signal.aborted;
    }
    failAll(error) {
        for (const stream of this.streams.values())
            stream.fail(error);
    }
    send(socket, message) {
        socket.send(JSON.stringify(message));
    }
}
function backoffDelay(attempt) {
    const cap = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * RECONNECT_FACTOR ** Math.max(0, attempt - 1));
    return cap / 2 + Math.random() * (cap / 2);
}
function sleep(ms, signal) {
    return new Promise((resolve) => {
        const timer = setTimeout(done, ms);
        signal.addEventListener('abort', done, { once: true });
        function done() {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
        }
    });
}
class StreamInbox {
    frames = [];
    wake;
    failure;
    push(frame) {
        if (this.failure !== undefined)
            return;
        this.frames.push(frame);
        this.wake?.();
        this.wake = undefined;
    }
    fail(error) {
        if (this.failure !== undefined)
            return;
        this.failure = error instanceof Error ? error : new Error(String(error), { cause: error });
        this.frames.length = 0;
        this.wake?.();
        this.wake = undefined;
    }
    async next() {
        while (this.frames.length === 0) {
            if (this.failure !== undefined)
                throw this.failure;
            await new Promise((resolve) => { this.wake = resolve; });
        }
        return this.frames.shift();
    }
}
function remoteStreamUrl() {
    const location = globalThis.location;
    const base = location?.origin !== undefined && location.origin !== 'null' ? location.origin : INTERNAL_BASE;
    const url = new URL(REMOTE_STREAM_MUX_PATH, base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.href;
}
//# sourceMappingURL=stream-client.js.map