/**
 * Pin `navigator.languages`/`navigator.language` for every test in the
 * calling file (or describe block), restoring the environment's own values
 * afterwards. Call at suite level, like the other vitest hooks.
 * @param primary - most preferred BCP 47 tag; also becomes `navigator.language`.
 * @param rest - further tags in preference order.
 */
export declare function usePinnedBrowserLanguages(primary: string, ...rest: string[]): void;
//# sourceMappingURL=locale-env.d.ts.map