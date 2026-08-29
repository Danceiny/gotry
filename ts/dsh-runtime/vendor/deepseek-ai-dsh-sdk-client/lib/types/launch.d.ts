/**
 * Resolve the public SDK launch configuration to one dsh subprocess.
 * @module @deepseek-ai/dsh-sdk-client/launch
 */
import type { HarnessClientOptions } from './types.ts';
/** Default bound for a profile to answer the SDK initialize handshake. */
export declare const DEFAULT_INITIALIZE_TIMEOUT_MS = 10000;
/** Internal generic process launch used by the transport and fake-runtime tests. */
export interface RuntimeProcessOptions {
    command: string;
    args: string[];
    cwd?: string;
    /** Materialize the complete child environment when the client starts its subprocess. */
    environment: () => NodeJS.ProcessEnv;
    description: string;
    initializeTimeoutMs: number;
    requestTimeoutMs?: number;
    shutdownTimeoutMs?: number;
    disposeEofGraceMs?: number;
    disposeGraceMs?: number;
}
/** Node argv plus internal profile patches required by one resolved dsh entry. */
export interface DshNodeLaunch {
    /** Arguments before the profile selector. */
    nodeArgs: string[];
    /** Internal patches applied below caller-supplied patches. */
    patches: string[];
    /** Environment values required by the resolved entry mode. */
    environment: NodeJS.ProcessEnv;
}
/**
 * Resolve and version-check a dsh executable from package manifests.
 * @param dshManifestUrl - resolved URL of the dsh package manifest.
 * @param clientManifestUrl - resolved URL of the SDK client manifest.
 * @returns the absolute dsh executable path.
 */
export declare function resolveDshBinFromManifests(dshManifestUrl: string, clientManifestUrl: string): string;
/**
 * Resolve and version-check the built dsh executable installed with this SDK.
 * @returns the absolute built executable path, whether or not it exists in a source checkout.
 */
export declare function installedDshBin(): string;
/**
 * Resolve the Node launch for one same-version dsh package.
 * @param dshManifestUrl - resolved URL of the dsh package manifest.
 * @param clientManifestUrl - resolved URL of the SDK client manifest.
 * @param sourceLoaderUrl - optional absolute tsx loader URL for deterministic tests.
 * @returns built output, or the source entry plus its compatibility patch and tsx environment.
 */
export declare function resolveDshNodeLaunchFromManifests(dshManifestUrl: string, clientManifestUrl: string, sourceLoaderUrl?: string): DshNodeLaunch;
/**
 * Resolve caller-relative filesystem inputs and construct canonical dsh argv.
 * @param options - public SDK launch options.
 * @param callerCwd - parent-process directory used for lexical resolution.
 * @returns one generic subprocess spec for the JSON-RPC transport.
 */
export declare function resolveDshLaunch(options?: HarnessClientOptions, callerCwd?: string): RuntimeProcessOptions;
//# sourceMappingURL=launch.d.ts.map