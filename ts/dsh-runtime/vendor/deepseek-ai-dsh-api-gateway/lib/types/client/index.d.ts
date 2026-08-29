/**
 * Client projection of generated Typert Remote descriptors. Contributions
 * install traced `remote.<namespace>` services; no JavaScript Proxy
 * participates in method lookup, invocation, or type exposure.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol';
import { RemoteStream, type RemoteStreamOptions } from './remote-stream.ts';
export { RemoteStreamCarrierError, RemoteStreamError } from './stream-client.ts';
export { RemoteJournalStream } from './journal-stream.ts';
export type { RemoteJournalChange, RemoteJournalFrame, RemoteJournalStreamOptions, RemoteStreamFactory, } from './journal-stream.ts';
export { RemoteStream } from './remote-stream.ts';
export type { RemoteStreamItem, RemoteStreamOptions } from './remote-stream.ts';
export { RemoteSnapshotStream } from './snapshot-stream.ts';
export type { RemoteSnapshotStreamOptions } from './snapshot-stream.ts';
/** Typed Remote service augmented by generated direct namespaces and Gateway stream supervision. */
export interface ClientRemote extends TypertClientRemote {
    /**
     * Create one independently cancellable, reconnecting logical stream.
     * @param options - domain-owned opener and generation-end classification.
     * @returns a single-consumer stream annotated with physical generation ids.
     */
    $stream<Item>(options: RemoteStreamOptions<Item>): RemoteStream<Item>;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Generated Remote namespaces selected by the Client assembly. */
        remote: ClientRemote;
    }
}
/** Required Client services: the Typert registry and the existing Connection carrier. */
export declare const inject: string[];
/**
 * Install the typed Client Remote service.
 * @param ctx - Client Cordis root.
 */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=index.d.ts.map