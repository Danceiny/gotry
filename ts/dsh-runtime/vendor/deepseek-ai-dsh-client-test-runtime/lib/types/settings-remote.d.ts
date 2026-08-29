/** Test double for the `settings` Remote namespace a bench's plugins inject. */
import { vi } from 'vitest';
/** The minimum a scripted namespace view carries for the double's own bookkeeping. */
export interface ScriptedNamespace {
    /** Namespace key the write addresses. */
    ns: string;
}
/** One scripted `settings` namespace face plus the controls a bench drives it with. */
export interface ScriptedSettingsRemote<View extends ScriptedNamespace> {
    /**
     * The namespace face handed to `TestRemote` as `settings`. A plugin injecting
     * `remote.settings` unparks on it, which is what most benches need; the
     * describe answer is the same one the shared mirror would read.
     */
    settings: {
        describe(): Promise<{
            ok: true;
            value: {
                writable: boolean;
                hasDocument: boolean;
                namespaces: readonly View[];
            };
        }>;
        update(ns: string, patch: unknown, expectedRevision: number | undefined): Promise<{
            ok: true;
            value: View;
        } | {
            ok: false;
            error: {
                code: string;
                message: string;
                details: object;
            };
        }>;
        replace(ns: string, section: unknown, expectedRevision: number | undefined): Promise<{
            ok: true;
            value: View;
        } | {
            ok: false;
            error: {
                code: string;
                message: string;
                details: object;
            };
        }>;
        mutate(ns: string, ops: unknown, expectedRevision: number | undefined): Promise<{
            ok: true;
            value: View;
        } | {
            ok: false;
            error: {
                code: string;
                message: string;
                details: object;
            };
        }>;
    };
    /** Spy behind `settings.update`, for argument assertions. */
    update: ReturnType<typeof vi.fn>;
    /** Spy behind `settings.replace`, for argument assertions. */
    replace: ReturnType<typeof vi.fn>;
    /** Spy behind `settings.mutate`, for argument assertions. */
    mutate: ReturnType<typeof vi.fn>;
    /**
     * Replace what the next describe answers with, as a Host commit would.
     * @param namespaces - the namespace views to serve from now on.
     */
    publish(namespaces: readonly View[]): void;
}
/**
 * Build a scripted `settings` Remote namespace for a bench. Each write answers
 * with the addressed namespace unchanged, so a bench that only needs its
 * plugins to activate scripts nothing; one asserting a write reads the
 * corresponding spy or replaces the face.
 * @param namespaces - namespace views the first describe answers with.
 * @param options - deployment facts the describe answer reports.
 * @returns the face and its controls.
 */
export declare function scriptedSettingsRemote<View extends ScriptedNamespace>(namespaces?: readonly View[], options?: {
    writable?: boolean;
    hasDocument?: boolean;
}): ScriptedSettingsRemote<View>;
//# sourceMappingURL=settings-remote.d.ts.map