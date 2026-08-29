/** Live Session queue, jobs, and projection state with reconnect baselines. */
/** Owns the Host-wide Session control stream. */
export class SessionControlController {
    ctx;
    streams = new Set();
    /** @param ctx - Host context carrying live Agent, projection, and jobs services. */
    constructor(ctx) {
        this.ctx = ctx;
        ctx.on('session/event', (session, event) => { this.onSessionEvent(session, event); });
        ctx.inject(['sessionProjections'], (projectionCtx) => {
            projectionCtx.sessionProjections.onChanged((session, key, value, seq) => {
                this.broadcast({
                    type: 'projection',
                    sessionId: session.id,
                    key,
                    value: value,
                    seq,
                });
            });
        });
        ctx.inject(['jobs'], (jobsCtx) => {
            jobsCtx.jobs.onJobsChanged((owner) => { this.onJobsChanged(owner); });
        });
        ctx.on('session/created', (session) => {
            const jobs = this.jobsFor(this.ctx.agents.get(session.id));
            if (jobs.length > 0)
                this.broadcast({ type: 'jobs', sessionId: session.id, jobs });
        });
        ctx.effect(() => () => {
            for (const stream of this.streams)
                stream.end();
            this.streams.clear();
        }, 'session-controller.control');
    }
    /**
     * Open one generation of Host-wide live control state.
     * @param signal - Remote stream cancellation.
     * @returns one complete baseline followed by live replacement frames.
     */
    async *control(signal) {
        signal.throwIfAborted();
        const queue = new ControlQueue();
        this.streams.add(queue);
        try {
            yield { type: 'baseline', value: this.baseline() };
            yield* queue.iterate(signal);
        }
        finally {
            this.streams.delete(queue);
            queue.end();
        }
    }
    baseline() {
        const sessions = this.ctx.sessions.list();
        const queues = Object.create(null);
        const jobs = Object.create(null);
        for (const session of sessions) {
            const agent = this.ctx.agents.get(session.id);
            queues[session.id] = agent?.session === session ? queueItems(agent) : [];
            jobs[session.id] = this.jobsFor(agent);
        }
        return {
            queues,
            jobs,
            projections: this.projectionBaseline(sessions),
        };
    }
    projectionBaseline(sessions) {
        const registry = this.ctx.get('sessionProjections');
        const blocks = Object.create(null);
        for (const session of sessions) {
            const snapshot = registry?.snapshot(session);
            blocks[session.id] = snapshot === undefined
                ? { asOfSeq: session.seq - 1, values: {} }
                : {
                    asOfSeq: snapshot.asOfSeq,
                    // Every projection definition validates its value before snapshot publication.
                    values: snapshot.values,
                };
        }
        return blocks;
    }
    onSessionEvent(session, event) {
        if (event.type !== 'agent/inbox/spliced')
            return;
        const agent = this.ctx.agents.get(session.id);
        if (agent?.session !== session)
            return;
        this.broadcast({
            type: 'queue',
            sessionId: session.id,
            items: queueItems(agent, event.data),
        });
    }
    onJobsChanged(owner) {
        if (owner !== undefined) {
            this.broadcast({ type: 'jobs', sessionId: owner.id, jobs: this.jobsFor(owner) });
            return;
        }
        for (const session of this.ctx.sessions.list()) {
            this.broadcast({
                type: 'jobs',
                sessionId: session.id,
                jobs: this.jobsFor(this.ctx.agents.get(session.id)),
            });
        }
    }
    jobsFor(agent) {
        const jobs = this.ctx.get('jobs');
        return jobs === undefined ? [] : jobs.list(agent).map(jobView);
    }
    broadcast(frame) {
        for (const stream of this.streams)
            stream.push(frame);
    }
}
class ControlQueue {
    buffer = [];
    wake;
    done = false;
    push(frame) {
        if (this.done)
            return;
        this.buffer.push(frame);
        const wake = this.wake;
        this.wake = undefined;
        wake?.();
    }
    end() {
        if (this.done)
            return;
        this.done = true;
        const wake = this.wake;
        this.wake = undefined;
        wake?.();
    }
    async *iterate(signal) {
        const onAbort = () => { this.end(); };
        signal.addEventListener('abort', onAbort, { once: true });
        try {
            while (!this.done && !signal.aborted) {
                const frame = this.buffer.shift();
                if (frame !== undefined) {
                    yield frame;
                    continue;
                }
                await new Promise((resolve) => { this.wake = resolve; });
            }
            while (this.buffer.length > 0 && !signal.aborted)
                yield this.buffer.shift();
        }
        finally {
            signal.removeEventListener('abort', onAbort);
            this.end();
        }
    }
}
function queueItems(agent, splice) {
    const project = (target) => {
        const messages = target === 'next-turn' ? agent.inbox.nextTurn : agent.inbox.nextStep;
        return splice?.target === target
            ? messages.toSpliced(splice.start, splice.removedCount ?? 0, ...splice.inserted)
            : messages;
    };
    return [
        ...project('next-turn').map(message => ({
            id: message.id,
            placement: 'queued',
            ...promptRpcId(message),
            message: { id: message.id, content: message.content },
        })),
        ...project('next-step').map(message => ({
            id: message.id,
            placement: message.source.kind === 'user' ? 'steering' : 'context',
            ...promptRpcId(message),
            message: { id: message.id, content: message.content },
        })),
    ];
}
/** Prompt-RPC identity carried by a browser-submitted message's user source. */
function promptRpcId(message) {
    const source = message.source;
    return source.kind === 'user' && 'rpcId' in source ? { rpcId: source.rpcId } : {};
}
function jobView(job) {
    return {
        id: job.id,
        kind: job.kind,
        label: job.label,
        status: job.status,
        ...(job.detail === undefined ? {} : { detail: job.detail }),
        startedAt: job.startedAt,
        ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
    };
}
//# sourceMappingURL=control.js.map