/** Bounded host-side projection of a complete output file retained in E2B. */
import { Buffer } from 'node:buffer';
import type { SubprocessOutputRead, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess';
/** Reserved non-base64 frame proving that one remote encoder reached clean EOF. */
export declare const E2B_OUTPUT_COMPLETE_FRAME = "!dsh-e2b-output-complete!";
/** Incrementally decode newline-delimited base64 frames emitted by one remote encoder. */
export declare class E2BBase64Decoder {
    private pending;
    private complete;
    /**
     * Decode every complete newline-delimited frame in one arbitrarily split SDK callback.
     * @param text - ASCII base64 frames from E2B's decoded callback.
     * @returns the complete raw bytes made available by this callback.
     */
    push(text: string): Buffer;
    /**
     * Validate clean encoder completion, or discard an interrupted trailing frame after requested termination.
     * @param requireComplete - Whether natural completion requires the reserved EOF frame.
     */
    finish(requireComplete?: boolean): void;
}
/** Offset reader used for one collect-mode E2B stream. */
export declare class E2BOutputReader implements SubprocessOutputReader {
    private readonly maxBytes;
    private readonly maxSpillBytes;
    private readonly spillPath;
    private chunks;
    private retainedBytes;
    private totalBytes;
    private spillValid;
    /**
     * Create a bounded reader over one remote spill path.
     * @param maxBytes - In-memory tail cap.
     * @param maxSpillBytes - Maximum complete remote file size the caller accepts.
     * @param spillPath - Remote full-output path.
     */
    constructor(maxBytes: number, maxSpillBytes: number | undefined, spillPath: string);
    /** Total bytes observed from the SDK stream. */
    get size(): number;
    /** Stop advertising a remote spill whose writer did not reach clean EOF. */
    invalidateSpill(): void;
    /**
     * Append one byte-faithful decoded transport event.
     * @param bytes - Raw command bytes recovered from the ASCII SDK transport.
     */
    push(bytes: Uint8Array): void;
    /** @inheritdoc */
    readFrom(fromByte: number): SubprocessOutputRead;
}
//# sourceMappingURL=output.d.ts.map