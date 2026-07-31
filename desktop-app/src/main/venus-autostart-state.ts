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
  const savedPhase = String(state.autonomousPhase || '');
  return {
    valid: false,
    reason: savedPhase
      ? `Open Selected fresh Requests start (previous phase: ${savedPhase})`
      : 'Open Selected fresh Requests start',
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
