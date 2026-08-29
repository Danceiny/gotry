/** Platform-neutral assembly of generated Host Remote contributions. */
import type { Context } from '@deepseek-ai/cordis';
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client';
export type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client';
export type { PluginInventorySnapshot } from '@deepseek-ai/dsh-host-plugin-inventory/types';
export type {} from '@deepseek-ai/dsh-agent-presets/remote';
export type {} from '@deepseek-ai/dsh-commands/remote';
export type {} from '@deepseek-ai/dsh-api-settings-controller/remote';
export type {} from '@deepseek-ai/dsh-goal/remote';
export type {} from '@deepseek-ai/dsh-llm/remote';
export type {} from '@deepseek-ai/dsh-host-plugin-inventory/remote';
export type {} from '@deepseek-ai/dsh-message-feedback/remote';
export type {} from '@deepseek-ai/dsh-session-reference/remote';
export type {} from '@deepseek-ai/dsh-subagent/remote';
export type * from '@deepseek-ai/dsh-subagent/client';
export type {} from '@deepseek-ai/dsh-api-session-controller/remote';
export type * from '@deepseek-ai/dsh-api-session-controller/types';
export type {} from '@deepseek-ai/dsh-api-workspace-controller/remote';
export type * from '@deepseek-ai/dsh-api-workspace-controller/types';
export type { SessionJob as JobView } from '@deepseek-ai/dsh-api-session-controller/types';
export type { ApiRemoteForwardedEvent } from '../types.ts';
export type {} from '@deepseek-ai/dsh-commands/types';
export type {} from '@deepseek-ai/dsh-cordis-host-runner/types';
export type {} from '@deepseek-ai/dsh-credentials/types';
export type {} from '@deepseek-ai/dsh-llm/types';
export type {} from '@deepseek-ai/dsh-agent-presets/types';
export type {} from '@deepseek-ai/dsh-settings/types';
export type {} from '@deepseek-ai/dsh-user-approval/types';
export type {} from '@deepseek-ai/dsh-user-questions/types';
export type {} from '@deepseek-ai/dsh-api-session-controller/types';
/**
 * The carrier's Client-facing types, re-exported so a business package names one
 * assembly package instead of both this facade and the Connection plugin. Type-only:
 * the carrier's runtime values stay behind their own module edge.
 */
export type { ConnectionHandle, ConnectionSinks, ContentBlock, MessageId, RpcError, RpcId, RpcRequest, RpcResponse, RpcResult, SessionId, StreamChunk, } from '@deepseek-ai/dsh-client-connection/client';
export type {} from '@deepseek-ai/dsh-api-gateway/client';
export type {} from '@deepseek-ai/dsh-cordis-host-runner/remote';
export type { ApprovalRequestId, CordisHalfState, CordisDynamicPackageId, CordisDynamicPluginId, CordisDynamicPluginRunId, CordisDynamicRunMode, CordisInspectMethodManifest, CordisInspectPlatform, CordisInspectProviderManifest, CordisInspectProviderView, CordisInspectQueryRequest, CordisInspectQueryResolution, CordisInspectQueryResolved, CordisInspectRequestId, CordisInspectResolveAck, CordisRunDiagnostic, CordisRunStatus, DynamicCordisClientSource, DynamicCordisHostHalfResult, DynamicCordisInventoryRow, DynamicCordisInvokeResult, DynamicCordisPackage, DynamicCordisRequestResolved, DynamicCordisResolveAck, DynamicCordisRetracted, DynamicCordisRunRequest, DynamicCordisRunResolution, DynamicCordisRunAttempt, DynamicCordisRunResponse, DynamicCordisStopResponse, DynamicCordisUndefineReceipt, RequestRunOutcome, } from '@deepseek-ai/dsh-cordis-host-runner/types';
export type { JsonValue } from '@deepseek-ai/dsh-session/types';
export type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types';
export type { SettingsDescribeValue, SettingsNamespaceView, SettingsPathOpView, SettingsSecretView, } from '@deepseek-ai/dsh-settings/types';
export type { LlmConfigurableProvider, LlmDiscoveredModel, LlmModelDiscoveryError, LlmModelDiscoveryRequest, LlmProviderInfo, } from '@deepseek-ai/dsh-llm/types';
export type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference/types';
export type { SessionReferenceMentionCandidate } from '@deepseek-ai/dsh-session-reference/types';
/** Failure vocabulary exposed by the assembled Client data layer. */
export type ClientFailure = import('@deepseek-ai/dsh-client-connection/client').RpcError | import('@deepseek-ai/dsh-agent-presets/types').AgentPresetError | import('@deepseek-ai/dsh-api-session-controller/types').SessionError | import('@deepseek-ai/dsh-api-settings-controller/types').CredentialError | import('@deepseek-ai/dsh-api-settings-controller/types').SettingsError | import('@deepseek-ai/dsh-llm/types').LlmModelDiscoveryError | import('@deepseek-ai/dsh-subagent/client').SubagentControlError | import('@deepseek-ai/dsh-api-workspace-controller/types').WorkspaceError;
/** Success or failure returned by Client operations spanning both API families. */
export type ClientResult<T> = {
    readonly ok: true;
    readonly value: T;
} | {
    readonly ok: false;
    readonly error: ClientFailure;
};
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Generated Remote namespaces selected by this Client assembly. */
        remote: ClientRemote;
    }
}
/** Required service: the typed Client Remote contribution mount. */
export declare const inject: string[];
/**
 * Mount the Host capabilities explicitly selected for this Client assembly.
 * @param ctx - Client Cordis root carrying the typed API service.
 * @returns disposer after every selected Remote namespace is ready.
 */
export declare function apply(ctx: Context): Promise<() => Promise<void>>;
//# sourceMappingURL=index.d.ts.map