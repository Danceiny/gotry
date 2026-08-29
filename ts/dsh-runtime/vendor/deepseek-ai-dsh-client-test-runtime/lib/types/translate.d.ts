/**
 * Test double of the locale lookup chain: a translate stub over plain
 * dictionaries, mirroring LocaleRuntime's resolution order (first dictionary
 * that owns the key wins, then the key itself stays visible) and its
 * `{name}` template interpolation. Specs stub the framework-injected `t`
 * seat with `makeTranslate(zh, commonZh)` instead of re-implementing the
 * chain per suite.
 */
/**
 * Build a translate stub resolving through `dicts` in order (namespace
 * first, then the shared common vocabulary), falling back to the key.
 * @param dicts - dictionaries consulted in order.
 * @returns the translate function (assignable to any `XxxProps['t']` seat).
 */
export declare function makeTranslate(...dicts: readonly Record<string, string>[]): (key: string, params?: Record<string, unknown>) => string;
//# sourceMappingURL=translate.d.ts.map