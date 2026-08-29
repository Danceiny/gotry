/** `feedback` namespace dictionaries. */
/** Simplified Chinese dictionary (the key-set source of truth). */
export declare const zh: {
    'action.like': string;
    'action.likeActive': string;
    'action.dislike': string;
    'action.dislikeActive': string;
    'note.open': string;
    'note.dialog': string;
    'note.placeholder': string;
    'note.save': string;
    'note.cancel': string;
    'note.aria': string;
    'error.conflict': string;
    'error.load': string;
    'error.generic': string;
};
/** The feedback namespace key union. */
export type MessageFeedbackKey = keyof typeof zh;
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** The per-message feedback controls' copy. */
        feedback: MessageFeedbackKey;
    }
}
/** English dictionary, checked complete against the zh key set. */
export declare const en: {
    'action.like': string;
    'action.likeActive': string;
    'action.dislike': string;
    'action.dislikeActive': string;
    'note.open': string;
    'note.dialog': string;
    'note.placeholder': string;
    'note.save': string;
    'note.cancel': string;
    'note.aria': string;
    'error.conflict': string;
    'error.load': string;
    'error.generic': string;
};
//# sourceMappingURL=locales.d.ts.map