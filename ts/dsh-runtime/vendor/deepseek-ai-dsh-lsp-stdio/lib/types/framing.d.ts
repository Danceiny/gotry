/**
 * LSP base-protocol framing: `Content-Length`-delimited JSON-RPC over a byte stream. The encoder
 * produces one framed buffer; the decoder buffers incoming bytes and yields complete message bodies,
 * bounding the header and total message size so a hostile or broken server cannot exhaust memory.
 * @module @deepseek-ai/dsh-lsp-stdio/framing
 */
/**
 * Encode one JSON-RPC message as a framed LSP buffer (`Content-Length: N\r\n\r\n<utf-8 json>`).
 * @param message - the JSON-RPC message object to serialize.
 * @returns the framed bytes ready to write to the server's stdin.
 */
export declare function encodeMessage(message: unknown): Buffer;
/**
 * A streaming decoder for `Content-Length`-framed JSON-RPC. Feed it stdout chunks; it returns any
 * whole message bodies that completed. It parses only the `Content-Length` header and ignores other
 * headers (e.g. `Content-Type`), matching the base protocol.
 */
export declare class MessageDecoder {
    private buffer;
    private readonly maxMessageBytes;
    /**
     * @param maxMessageBytes - reject any single framed body larger than this (guards memory).
     */
    constructor(maxMessageBytes: number);
    /**
     * Append a chunk and return every message body that is now complete.
     * @param chunk - raw bytes from the server's stdout.
     * @returns the parsed JSON bodies, in arrival order (possibly empty).
     * @throws Error when a header is malformed or a body exceeds `maxMessageBytes`.
     */
    push(chunk: Buffer): unknown[];
    /** Parse and consume the next complete message, or report that more bytes are needed. */
    private next;
}
//# sourceMappingURL=framing.d.ts.map