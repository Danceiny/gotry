/** Test double for the client settings-scope seam. */
import { vi } from 'vitest';
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client';
/** Handle over one stubbed scope: the scope, its write spy, and publication controls. */
export interface StubSettingsScope<T> {
    /** The scope face handed to the service under test. */
    scope: SettingsScope<T>;
    /** Spy behind `scope.set`; resolves immediately. */
    set: ReturnType<typeof vi.fn>;
    /** Spy behind `scope.mutate`; resolves immediately. */
    mutate: ReturnType<typeof vi.fn>;
    /** Spy behind `scope.unset`; resolves immediately. */
    unset: ReturnType<typeof vi.fn>;
    /** @returns how many listeners are currently subscribed (disposal assertions). */
    listenerCount(): number;
    /**
     * Replace part of the snapshot and notify subscribers, as a Host
     * acceptance would.
     * @param next - snapshot fields to replace.
     */
    publish(next: Partial<SettingsScopeSnapshot<T>>): void;
}
/**
 * Build an in-memory settings scope for service specs: starts in the host
 * loading state, records writes, and lets the test publish Host acceptances.
 * @returns the stub handle.
 */
export declare function stubSettingsScope<T>(): StubSettingsScope<T>;
//# sourceMappingURL=settings-scope.d.ts.map