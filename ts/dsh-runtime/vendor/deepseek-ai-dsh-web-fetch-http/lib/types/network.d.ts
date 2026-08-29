/**
 * Public-network resolution and address-pinned HTTP transport for `web-fetch-http`.
 * One DNS answer set is validated before Undici receives it through a custom lookup,
 * so the connection cannot resolve the hostname again to a private address.
 *
 * @module @deepseek-ai/dsh-web-fetch-http/network
 */
import type { LookupAddress, LookupOptions } from 'node:dns';
import type { Response } from 'undici';
/** One address resolved and retained for the subsequent pinned connection. */
export interface PublicAddress {
    /** Canonical textual IPv4 or IPv6 address. */
    readonly address: string;
    /** Address family accepted by Node's connection lookup callback. */
    readonly family: 4 | 6;
}
/** The result of one address-pinned request; closing releases its private pool. */
export interface PinnedResponse {
    /** HTTP response whose body remains readable until `close()` is called. */
    readonly response: Response;
    /** Release the request's dispatcher after the response body is consumed or cancelled. */
    close(): Promise<void>;
}
/** Resolver signature used to test public-address policy without process DNS changes. */
export type AddressResolver = (hostname: string, options: {
    all: true;
    order: 'verbatim';
}) => Promise<LookupAddress[]>;
/**
 * Return whether an address is globally reachable unicast. IPv4-mapped IPv6 is
 * classified by its embedded IPv4 address; transition and translation prefixes
 * remain blocked because their eventual IPv4 destination cannot be pinned here.
 *
 * @param input - textual IPv4 or IPv6 address.
 * @returns true only for a public unicast destination.
 */
export declare function isPublicIpAddress(input: string): boolean;
/**
 * Resolve a hostname once and reject the complete answer set if any destination
 * is not public. The returned addresses are the only ones the transport may use.
 *
 * @param hostname - URL hostname, including brackets when it is an IPv6 literal.
 * @param signal - aborts the wait for system resolution; an in-flight OS lookup may finish unused.
 * @param resolver - lookup implementation, overridden only by focused tests.
 * @returns the validated, non-empty address set.
 */
export declare function resolvePublicAddresses(hostname: string, signal: AbortSignal, resolver?: AddressResolver): Promise<PublicAddress[]>;
/**
 * Fetch through an Undici agent whose lookup callback returns only the already
 * validated address set. The URL hostname remains intact for HTTP Host and TLS SNI.
 *
 * @param url - validated HTTP(S) URL.
 * @param addresses - public addresses returned by {@link resolvePublicAddresses}.
 * @param headers - request headers.
 * @param signal - request and body-read cancellation signal.
 * @returns a response plus the dispatcher disposer its consumer must call.
 */
export declare function requestPinned(url: URL, addresses: readonly PublicAddress[], headers: Record<string, string>, signal: AbortSignal): Promise<PinnedResponse>;
/** Production network operations kept as an object so provider tests can replace resolution only. */
export declare const publicHttpNetwork: {
    resolve: typeof resolvePublicAddresses;
    request: typeof requestPinned;
};
type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
/**
 * Build the connector lookup that serves a fixed validated answer set.
 *
 * @param addresses - public addresses retained from the preceding resolution.
 * @returns a Node-compatible lookup callback that performs no network resolution.
 */
export declare function createPinnedLookup(addresses: readonly PublicAddress[]): (hostname: string, options: LookupOptions, callback: LookupCallback) => void;
export {};
//# sourceMappingURL=network.d.ts.map