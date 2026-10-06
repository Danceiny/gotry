export interface FlyaiCandidateVerification {
  verdict: 'hit' | 'auth-error' | 'forbidden' | 'needs-setup' | 'rate-limited' | 'timeout' | 'cancelled' | 'error'
  count?: number
  error?: string
}
export declare function verifyFlyaiCandidate(candidate: string, options?: {
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}): Promise<FlyaiCandidateVerification>
