import type { WorkWindowProfile } from './contracts.ts'
import type { JourneySpecTS, WorkWindowSpec } from './unified.ts'
import { FLIGHT_PACK_VERSION } from './flight-pack-contract.ts'
import { isKnownZoneLoose } from './tz-resolver.ts'

export class WorkWindowPrecedenceError extends Error {
  readonly code: 'v2_profile_requires_pack_home_zone' | 'v1_profile_requires_numeric_home_offset'

  constructor(code: 'v2_profile_requires_pack_home_zone' | 'v1_profile_requires_numeric_home_offset', message: string) {
    super(message)
    this.name = 'WorkWindowPrecedenceError'
    this.code = code
  }
}

/**
 * Merge the user's schedule onto a parsed flight-pack window.
 *
 * v2 pack metadata owns the home zone. The profile contributes only schedule
 * fields; its legacy numeric offset is intentionally ignored on that path.
 * Legacy v1 keeps the adapter's historical numeric replacement behavior.
 */
export function mergeProfileWorkWindow(spec: JourneySpecTS, profileWindow: WorkWindowProfile | undefined): JourneySpecTS {
  // Vacation is an explicit profile fact, not an omitted schedule. It clears
  // any pack window for both versions before the version-specific merge.
  if (profileWindow?.vacation === true) return { ...spec, workWindow: undefined }

  if (spec[FLIGHT_PACK_VERSION] === 2) {
    if (!profileWindow) return spec
    const packWindow = spec.workWindow
    if (!packWindow?.homeZone || !isKnownZoneLoose(packWindow.homeZone)) {
      throw new WorkWindowPrecedenceError(
        'v2_profile_requires_pack_home_zone',
        'v2 profile schedule requires a valid explicit pack work_window.home_zone',
      )
    }
    const workWindow: WorkWindowSpec = {
      ...packWindow,
      startMin: profileWindow.startMin,
      endMin: profileWindow.endMin,
      workdays: profileWindow.workdays,
    }
    return { ...spec, workWindow }
  }

  // v1 adapter behavior: profile replaces the legacy pack window; no profile
  // clears it as the existing adapters historically did.
  if (!profileWindow) return { ...spec, workWindow: undefined }
  if (typeof profileWindow.homeTzOffsetMin !== 'number') {
    throw new WorkWindowPrecedenceError(
      'v1_profile_requires_numeric_home_offset',
      'v1 profile work window requires homeTzOffsetMin',
    )
  }
  return {
    ...spec,
    workWindow: {
      homeTzOffsetMin: profileWindow.homeTzOffsetMin,
      startMin: profileWindow.startMin,
      endMin: profileWindow.endMin,
      workdays: profileWindow.workdays,
    },
  }
}
