/**
 * Model-driven Typert artifact emitter. It consumes only FaceModel and
 * TypeGraph data; TypeScript compiler nodes are not part of this boundary.
 * @module @deepseek-ai/dsh-typert-generator/emitter
 */
import type { FaceModel } from './model.ts';
/** Failure to project a modeled construct into an emitted artifact. */
export declare class TypertEmitError extends Error {
    name: string;
}
/** JavaScript and declaration artifacts for one package on one face. */
export interface ModelEmitResult {
    readonly package: string;
    readonly face: FaceModel['face'];
    readonly exports: readonly string[];
    readonly js: string;
    readonly dts: string;
    readonly remote?: RemoteModelEmitResult;
}
/** Host-for-Client Remote contribution generated from the Host Program. */
export interface RemoteModelEmitResult {
    readonly js: string;
    readonly dts: string;
    readonly dtsMap: string;
}
/** Emit generated runtime and type artifacts from one independently analyzed face. */
export declare class FaceModelEmitter {
    private readonly face;
    private readonly renderer;
    /**
     * Create an emitter for one face graph.
     * @param face - independently analyzed face.
     */
    constructor(face: FaceModel);
    /**
     * Emit one modeled package.
     * @param packageName - exact package name in the face model.
     * @returns executable JavaScript and its precise declaration file.
     */
    emit(packageName: string): ModelEmitResult;
    private runtimeModel;
    private runtimeMember;
    private runtimeTypes;
    private renderJs;
    private renderDts;
    private emitRemote;
    private invocationLiteral;
    private renderRemoteDts;
    private pushRemoteSignature;
    private pushRemoteNamespaceSignature;
    private pushMappedRemoteSignature;
    private remoteSignature;
    private remoteFunctionType;
}
//# sourceMappingURL=emitter.d.ts.map