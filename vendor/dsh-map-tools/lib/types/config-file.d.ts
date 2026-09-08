/**
 * dsh-map-tools persisted config file (~/.dsh-map-tools/config.json).
 *
 * Follows the modlens pattern: the plugin's API keys and provider choice live
 * in its own file (shared across profiles, never in the DSH settings
 * document), and the settings card reads/writes it through a loopback route.
 */
/** The file the plugin's settings card reads and writes. Overridable for tests. */
export declare function configPath(): string;
/** What the plugin persists and serves to the settings card. */
export interface MapToolsFileConfig {
    provider?: 'amap' | 'osm';
    amapKey?: string;
    timeoutMs?: number;
    maxQps?: number;
}
/**
 * Read the shared config, or a thrown error. Only a missing file reads as
 * empty: an existing-but-unparsable file is somebody's configuration, and a
 * card that treated it as empty would overwrite it on the next save.
 */
export declare function readConfig(): MapToolsFileConfig;
/** Persist a patch onto the config file, then return the new whole. */
export declare function applyConfig(patch: Partial<MapToolsFileConfig>): MapToolsFileConfig;
/** Whether the config file exists (the card can offer "open config file"). */
export declare function configFileExists(): boolean;
/** Non-secret summary served to the settings card (keys are never echoed). */
export declare function configSummary(): {
    provider: MapToolsFileConfig['provider'];
    timeoutMs?: number;
    maxQps?: number;
    hasAmapKey: boolean;
};
