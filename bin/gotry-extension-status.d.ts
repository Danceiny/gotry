export interface ExtensionStatusOptions {
  homeDir?: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  ports?: readonly number[]
  timeoutMs?: number
}
export function checkExtensionStatus(opts?: ExtensionStatusOptions): Promise<{
  status: 'ok' | 'degraded'
  detail: string
  fix?: string
}>
