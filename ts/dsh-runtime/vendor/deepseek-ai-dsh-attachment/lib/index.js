import { Service } from "@deepseek-ai/cordis";
import { Buffer } from "node:buffer";
//#region lib/types/error.js
/** Runtime membership for structurally compatible errors crossing package boundaries. */
const IMAGE_ADMISSION_ERROR_CODE_SET = new Set([
	"TOO_MANY_IMAGES",
	"IMAGES_TOO_LARGE",
	"UNSUPPORTED_IMAGE_TYPE",
	"INVALID_IMAGE_BASE64",
	"INVALID_IMAGE",
	"IMAGE_TYPE_MISMATCH",
	"IMAGE_TOO_LARGE",
	"IMAGE_TOO_MANY_PIXELS",
	"IMAGE_DIMENSION_TOO_LARGE"
]);
/**
* Stable failures suitable for host RPC error mapping.
*
* Deliberately re-implements the `HarnessError` shape instead of extending it:
* the base lives in `@deepseek-ai/dsh-llm`, which itself depends on this
* package (`ImageBlock` references `ImageAttachmentRef`), so sharing the base
* would create a dependency cycle. Consumers route on `code`, never on the
* prototype chain, so the shapes stay interchangeable at the wire boundary.
*/
var AttachmentError = class extends Error {
	/** Stable machine-routing failure code. */
	code;
	/**
	* @param message - human-readable failure description without raw bytes or host paths.
	* @param code - stable machine-routing code.
	* @param options - optional chained cause.
	*/
	constructor(message, code, options) {
		super(message, options);
		this.name = "AttachmentError";
		this.code = code;
	}
};
/**
* Distinguish caller-correctable image admission failures from storage faults.
* @param error - failure raised while validating or persisting an image batch.
* @returns whether the caller can correct the proposed image content or batch.
*/
function isImageAdmissionError(error) {
	return error instanceof Error && "code" in error && typeof error.code === "string" && IMAGE_ADMISSION_ERROR_CODE_SET.has(error.code);
}
//#endregion
//#region lib/types/brand.js
/** Attachment identifier brand. @module @deepseek-ai/dsh-attachment/brand */
/**
* Brand a validated storage identifier.
* @param value - backend-produced opaque identifier.
* @returns the branded identifier.
*/
function AttachmentId(value) {
	return value;
}
/**
* Brand a validated request-image transformation identifier.
* @param value - attachment-provider-produced opaque identifier.
* @returns the branded identifier.
*/
function ImageVariantId(value) {
	return value;
}
//#endregion
//#region lib/types/admission.js
/** Wire-form admission of base64-encoded image uploads. @module @deepseek-ai/dsh-attachment/admission */
/** Decode one upload payload while rejecting non-canonical base64 forms. */
function decodeBase64(data) {
	const decoded = Buffer.from(data, "base64");
	if (data.length === 0 || decoded.toString("base64") !== data) throw new AttachmentError("Image upload is not canonical base64.", "INVALID_IMAGE_BASE64");
	return new Uint8Array(decoded);
}
/** Store input for one decoded upload. */
function saveInput(image) {
	return {
		data: decodeBase64(image.data),
		mediaType: image.mediaType,
		...image.name === void 0 ? {} : { name: image.name }
	};
}
/**
* Admit one wire image batch: enforce canonical base64 on every member, then
* delegate batch admission — count and aggregate-byte limits, media-type and
* per-image validation, ordered commit — to {@link AttachmentStore.saveImages}.
* The shared entry for every RPC endpoint accepting browser uploads.
* @param attachments - the deployment attachment store owning batch policy.
* @param images - base64-encoded uploads in caller order.
* @returns durable references in the same order as `images`.
* @throws AttachmentError on a non-canonical payload or a refused batch.
*/
async function admitEncodedImages(attachments, images) {
	return attachments.saveImages(images.map(saveInput));
}
//#endregion
//#region lib/types/request-projection.js
/**
* Pure request-projection geometry shared by attachment providers and
* provider-side request pricing. @module @deepseek-ai/dsh-attachment/request-projection
*/
/**
* Compute aspect-preserving integer dimensions within a hard total-pixel budget.
* @param width - positive source width.
* @param height - positive source height.
* @param maxPixels - positive width-times-height cap.
* @returns inward-rounded dimensions; small images are not enlarged.
*/
function requestImageDimensions(width, height, maxPixels) {
	const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)));
	if (scale === 1) return {
		width,
		height
	};
	if (width >= height) {
		let projectedWidth = Math.max(1, Math.floor(width * scale));
		let projectedHeight = Math.max(1, Math.round(projectedWidth * height / width));
		while (projectedWidth * projectedHeight > maxPixels && projectedWidth > 1) {
			projectedWidth -= 1;
			projectedHeight = Math.max(1, Math.round(projectedWidth * height / width));
		}
		return {
			width: projectedWidth,
			height: projectedHeight
		};
	}
	let projectedHeight = Math.max(1, Math.floor(height * scale));
	let projectedWidth = Math.max(1, Math.round(projectedHeight * width / height));
	while (projectedWidth * projectedHeight > maxPixels && projectedHeight > 1) {
		projectedHeight -= 1;
		projectedWidth = Math.max(1, Math.round(projectedHeight * width / height));
	}
	return {
		width: projectedWidth,
		height: projectedHeight
	};
}
//#endregion
//#region lib/types/index.js
/** Durable attachment storage seam (`ctx.attachments`). @module @deepseek-ai/dsh-attachment */
/** Immutable binary attachment service. Implementations validate bytes before publishing a reference. */
var AttachmentStore = class extends Service {
	constructor(ctx) {
		super(ctx, "attachments");
	}
	/**
	* Validate one ordered image batch before committing any member.
	* Validation failures start no writes; storage failures return no partial
	* references, although already published content-addressed objects may stay
	* unreachable until a future retention policy collects them.
	* @param inputs - encoded images in their owning message order.
	* @returns durable references in the exact input order.
	*/
	validateImageBatch(inputs) {
		const { maxImagesPerMessage, maxMessageImageBytes, mediaTypes } = this.imageLimits;
		if (inputs.length > maxImagesPerMessage) throw new AttachmentError("Image batch exceeds the configured image-count limit.", "TOO_MANY_IMAGES");
		if (inputs.reduce((sum, input) => sum + input.data.byteLength, 0) > maxMessageImageBytes) throw new AttachmentError("Image batch exceeds the configured aggregate image-byte limit.", "IMAGES_TOO_LARGE");
		for (const input of inputs) if (!mediaTypes.includes(input.mediaType)) throw new AttachmentError(`Image type ${input.mediaType} is not accepted by this deployment.`, "UNSUPPORTED_IMAGE_TYPE");
	}
	/**
	* Validate and durably commit one ordered image batch.
	* @param inputs - encoded images in owning-message order.
	* @returns durable normalized attachment references in the same order after every member succeeds.
	*/
	async saveImages(inputs) {
		this.validateImageBatch(inputs);
		for (const input of inputs) await this.validateImage(input);
		const refs = [];
		for (const input of inputs) refs.push(await this.saveImage(input));
		return refs;
	}
	/**
	* Locate the provider-owned normalized object in the harness host filesystem.
	* @param ref - durable normalized attachment reference.
	* @returns an absolute host path, or undefined when this backend is not host-file-backed.
	* @throws an AttachmentError when the durable reference is invalid.
	*/
	imageHostPath(ref) {}
	/**
	* Generate or read one deterministic model-request version from the stored normalized image.
	* @param ref - durable provider-independent normalized attachment reference.
	* @param policy - exact route pixel budget and encoded-byte target; a target no ladder quality meets yields the smallest ladder output.
	* @param signal - optional cancellation.
	* @returns request bytes and the cache/upload identity covering every transform input.
	*/
	readImageRequest(ref, policy, signal) {
		signal?.throwIfAborted();
		return Promise.reject(new AttachmentError("The mounted attachment provider cannot derive model-request images.", "ATTACHMENT_PROJECTION_UNSUPPORTED"));
	}
};
//#endregion
export { AttachmentError, AttachmentId, AttachmentStore, AttachmentStore as default, ImageVariantId, admitEncodedImages, isImageAdmissionError, requestImageDimensions };
