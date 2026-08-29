import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { AttachmentRailLabels } from '../AttachmentRail.tsx';
import type { DropOverlayLabels } from '../DropOverlay.tsx';
import type { ImageLightboxLabels } from '../ImageLightbox.tsx';
import type { MessageImageLabels } from '../MessageImage.tsx';
/**
 * Resolve original-image lightbox strings from the conversation namespace.
 * @param t - conversation namespace translator.
 * @returns translated lightbox labels.
 */
export declare function lightboxLabels(t: TranslateNS<'conversation'>): ImageLightboxLabels;
/**
 * Resolve historical message-image strings from the conversation namespace.
 * @param t - conversation namespace translator.
 * @returns translated message-image labels.
 */
export declare function messageImageLabels(t: TranslateNS<'conversation'>): MessageImageLabels;
/**
 * Resolve the document-level drop invitation and its optional limits line.
 * @param t - conversation namespace translator.
 * @param accepting - whether the composer can accept dropped files.
 * @param limits - optional translated count and size values.
 * @returns translated drop-overlay labels.
 */
export declare function dropOverlayLabels(t: TranslateNS<'conversation'>, accepting: boolean, limits?: {
    readonly count: number;
    readonly size: string;
}): DropOverlayLabels;
/**
 * Resolve draft-image rail strings from the conversation namespace.
 * @param t - conversation namespace translator.
 * @returns translated attachment-rail labels.
 */
export declare function attachmentRailLabels(t: TranslateNS<'conversation'>): AttachmentRailLabels;
//# sourceMappingURL=labels.d.ts.map