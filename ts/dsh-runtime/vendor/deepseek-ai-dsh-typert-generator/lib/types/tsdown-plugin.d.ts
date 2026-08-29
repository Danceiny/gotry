/**
 * Optional tsdown (rolldown) plugin face of the typert generator. It lowers
 * standard decorators in TypeScript dependencies before bundling, then emits
 * model-driven face artifacts at the package output root. Packages without a
 * Typert or Remote export are skipped.
 * @module @deepseek-ai/dsh-typert-generator/tsdown
 */
import type { TypertFace } from './model.ts';
/** The subset of the rolldown plugin contract used here (structural; avoids a rolldown type dependency). */
interface TypertPlugin {
    name: string;
    transform: (code: string, id: string) => {
        code: string;
        map: string | undefined;
    } | undefined;
    writeBundle: (options: {
        dir?: string;
    }) => void;
}
/** Generation scope selected by a tsdown build phase. */
export interface TypertPluginOptions {
    /** Package mode emits only the package being bundled; workspace mode emits every explicit contributor once. */
    readonly mode?: 'package' | 'workspace';
    /** Independent TypeScript program faces included in this phase. */
    readonly faces?: readonly TypertFace[];
}
/**
 * Create the decorator-lowering and typert-generation plugin for the root tsdown config.
 * @param pluginOptions - package/workspace emission mode and independent program faces.
 * @returns a rolldown-compatible plugin that lowers source decorators and emits local and Host-for-Client artifacts.
 */
export declare function typertPlugin(pluginOptions?: TypertPluginOptions): TypertPlugin;
export {};
//# sourceMappingURL=tsdown-plugin.d.ts.map