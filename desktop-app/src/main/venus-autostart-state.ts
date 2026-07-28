export interface VenusAutostartState {
  autonomousPhase?: unknown;
  autonomousPhaseStartTime?: unknown;
  autonomousRequestsTime?: unknown;
  autonomousDmsTime?: unknown;
}

export interface VenusAutostartPlan {
  valid: boolean;
  reason: string;
  phase: 'requests' | 'dms' | 'posting';
  phaseStartTime: number | null;
  remainingMilliseconds: number | null;
  targetUrl: string;
  updates: Record<string, boolean | string | number>;
}

export function resolveVenusAutostartState(
  state: VenusAutostartState,
  now = Date.now(),
  launchId = ''
): VenusAutostartPlan {
  const validPhases = new Set(['requests', 'dms', 'posting']);
  const savedPhase = String(state.autonomousPhase || '');
  const savedStartedAt = Number(state.autonomousPhaseStartTime);
  let valid = validPhases.has(savedPhase);
  let reason = '';

  if (!valid) {
    reason = savedPhase ? `unknown phase: ${savedPhase}` : 'first startup';
  } else if (
    savedPhase !== 'posting' &&
    (!Number.isFinite(savedStartedAt) || savedStartedAt <= 0)
  ) {
    valid = false;
    reason = 'missing phase start time';
  } else if (savedPhase !== 'posting' && savedStartedAt > now + 300000) {
    valid = false;
    reason = 'phase start time is in the future';
  }

  if (!valid) {
    return {
      valid: false,
      reason,
      phase: 'requests',
      phaseStartTime: now,
      remainingMilliseconds: null,
      targetUrl: 'https://x.com/i/chat/requests',
      updates: {
        pendingAutoStart: true,
        pendingMode: 'autonomous',
        ...(launchId ? { spectraPendingLaunchId: launchId } : {}),
        autonomousPhase: 'requests',
        autonomousPhaseStartTime: now,
        requestsWasIdle: false,
      },
    };
  }

  const phase = savedPhase as VenusAutostartPlan['phase'];
  const durationMinutes = phase === 'requests'
    ? Number(state.autonomousRequestsTime || 5)
    : Number(state.autonomousDmsTime || 5);
  const remainingMilliseconds = phase === 'posting'
    ? null
    : Math.max(0, durationMinutes * 60000 - (now - savedStartedAt));

  return {
    valid: true,
    reason: '',
    phase,
    phaseStartTime: phase === 'posting' ? null : savedStartedAt,
    remainingMilliseconds,
    targetUrl: phase === 'requests'
      ? 'https://x.com/i/chat/requests'
      : phase === 'dms'
        ? 'https://x.com/i/chat'
        : 'https://x.com/home',
    updates: {
      pendingAutoStart: true,
      pendingMode: 'autonomous',
      ...(launchId ? { spectraPendingLaunchId: launchId } : {}),
    },
  };
}
