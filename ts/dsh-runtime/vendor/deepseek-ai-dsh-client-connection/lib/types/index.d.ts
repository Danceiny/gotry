/** Host HTTP bridge for browser-client RPC. */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export type { ConnectionFetchMethod, ConnectionFetchHandler, ConnectionFetchRoute, ConnectionIndexRequest, ConnectionIndexResponse, ConnectionRpcEndpointMatcher, ConnectionRpcFailure, ConnectionRpcHandler, ConnectionRequestRejection, ConnectionRpcResult, ConnectionTrustRequest, ClientRequest, HostConnectionHandle, HostConnectionFetch, HostConnectionRpc, RpcMessage, ServerResponse, } from './rpc.ts';
export { RpcId, transportError } from './rpc.ts';
export { clientRequestSchema, rpcErrorSchema, rpcIdSchema, rpcMessageSchema, rpcResultSchema, serverResponseSchema, } from './rpc-schema.ts';
export { HostConnectionService } from './rpc-host.ts';
export { API_PATH } from './api-path.ts';
/** Stable Cordis plugin name. */
export declare const name = "client-connection";
/** Services required before providing Connection. */
export declare const inject: string[];
/** Plugin config: the deployment's non-loopback serving authorities. */
export interface ConnectionConfig {
    /**
     * Authorities this deployment serves beyond loopback: exact `host:port`, or
     * port-less `host` matching any port. The /api trust fence refuses any
     * request whose Host is neither loopback nor listed here, so a
     * non-loopback (`0.0.0.0`) deployment must declare the names it is reached
     * by; the Web runtime derives LAN IP literals from an active all-interface
     * bind. An entry that is not a bare, canonical authority fails plugin load.
     */
    trustedHosts?: string[];
    /** Absolute browser-session lifetime in days. Default: 30. */
    cookieMaxAgeDays?: number;
    /** Maximum buffered JSON body for every `/api` request. Default: 300 MiB. */
    maxRequestBodyBytes?: number;
}
export declare const Config: z<ConnectionConfig>;
/**
 * Mounts the API gateway under the browser transport prefix. Every request on
 * the prefix passes the Host/Origin browser-trust fence and persistent browser
 * authentication before dispatch.
 * @param ctx - Host plugin context.
 * @param config - resolved plugin config (schema defaults applied).
 */
export declare function apply(ctx: Context, config?: ConnectionConfig): Promise<void>;
//# sourceMappingURL=index.d.ts.map