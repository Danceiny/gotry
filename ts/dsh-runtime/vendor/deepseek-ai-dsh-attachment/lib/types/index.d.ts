/** Durable attachment storage seam (`ctx.attachments`). @module @deepseek-ai/dsh-attachment */
import { Context, Service } from '@deepseek-ai/cordis';
import type { ImageAttachmentLimits, ImageAttachmentRef, ImageRequestPolicy, RequestImageAttachment, SaveImageAttachment, StoredImageAttachment } from './types.ts';
export { AttachmentId, ImageVariantId } from './brand.ts';
export { AttachmentError, isImageAdmissionError } from './error.ts';
export type { AttachmentErrorCode, ImageAdmissionErrorCode } from './error.ts';
export { admitEncodedImages } from './admission.ts';
export { requestImageDimensions } from './request-projection.ts';
export type { AttachmentId as AttachmentIdType, EncodedImageAttachment, ImageAttachmentLimits, ImageAttachmentRef, ImageRequestPolicy, ImageMediaType, RequestImageAttachment, SaveImageAttachment, StoredImageAttachment, } from './types.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        attachments: AttachmentStore;
    }
}
/** Immutable binary attachment service. Implementations validate bytes before publishing a reference. */
export declare abstract class AttachmentStore extends Service {
    constructor(ctx: Context);
    /** Deployment-resolved image policy used by authoritative and fast-path validation. */
    abstract readonly imageLimits: ImageAttachmentLimits;
    /**
     * Validate one image without persisting it.
     * Batch callers validate every member before saving any member.
     * @param input - encoded bytes, declared media type, and optional display name.
     * @returns completion after the encoded raster has been fully decoded.
     */
    abstract validateImage(input: SaveImageAttachment): Promise<void>;
    /**
     * Validate one ordered image batch before committing any member.
     * Validation failures start no writes; storage failures return no partial
     * references, although already published content-addressed objects may stay
     * unreachable until a future retention policy collects them.
     * @param inputs - encoded images in their owning message order.
     * @returns durable references in the exact input order.
     */
    protected validateImageBatch(inputs: readonly SaveImageAttachment[]): void;
    /**
     * Validate and durably commit one ordered image batch.
     * @param inputs - encoded images in owning-message order.
     * @returns durable normalized attachment references in the same order after every member succeeds.
     */
    saveImages(inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]>;
    /**
     * Validate and durably commit one image before its owning session event is appended.
     * The returned reference describes the persisted normalized image. When
     * normalization reduces the raster, its `originalDimensions` records the
     * orientation-applied input dimensions.
     * @param input - encoded bytes, declared media type, and optional display name.
     * @returns the durable content-addressed normalized image reference.
     */
    abstract saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>;
    /**
     * Read one image and verify that bytes still match the recorded reference.
     * @param ref - durable reference from the session log.
     * @param signal - optional cancellation for backend read and verification work.
     * @returns the verified bytes and normalized attachment reference.
     * @throws the signal reason when aborted, or a storage error when verification fails.
     */
    abstract readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment>;
    /**
     * Locate the provider-owned normalized object in the harness host filesystem.
     * @param ref - durable normalized attachment reference.
     * @returns an absolute host path, or undefined when this backend is not host-file-backed.
     * @throws an AttachmentError when the durable reference is invalid.
     */
    imageHostPath(ref: ImageAttachmentRef): string | undefined;
    /**
     * Generate or read one deterministic model-request version from the stored normalized image.
     * @param ref - durable provider-independent normalized attachment reference.
     * @param policy - exact route pixel budget and encoded-byte target; a target no ladder quality meets yields the smallest ladder output.
     * @param signal - optional cancellation.
     * @returns request bytes and the cache/upload identity covering every transform input.
     */
    readImageRequest(ref: ImageAttachmentRef, policy: ImageRequestPolicy, signal?: AbortSignal): Promise<RequestImageAttachment>;
}
export default AttachmentStore;
//# sourceMappingURL=index.d.ts.map