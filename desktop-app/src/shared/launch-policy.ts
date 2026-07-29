export type SpectraLaunchMode = 'manual' | 'automation' | 'open-post' | 'session-import';

export interface LaunchPolicyInput {
  launchMode?: SpectraLaunchMode;
  autoStartTwitterBot?: boolean;
  targetTweetUrl?: string | null;
  sessionImportAttemptId?: string | null;
}

export function resolveLaunchMode(input: LaunchPolicyInput): SpectraLaunchMode {
  if (input.launchMode) return input.launchMode;
  if (input.sessionImportAttemptId) return 'session-import';
  if (input.targetTweetUrl) return 'open-post';
  if (input.autoStartTwitterBot) return 'automation';
  return 'manual';
}

export function isManagedLaunch(mode: SpectraLaunchMode): boolean {
  return mode !== 'manual';
}

export function shouldAppendLaunchUrl(
  mode: SpectraLaunchMode,
  hasRestorableSession: boolean
): boolean {
  return isManagedLaunch(mode) || !hasRestorableSession;
}

export function shouldOpenSetupTab(
  mode: SpectraLaunchMode,
  hasRestorableSession: boolean
): boolean {
  return mode === 'manual' && !hasRestorableSession;
}

export interface WindowRectangle {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function fitWindowToWorkArea(
  bounds: WindowRectangle,
  workArea: WorkArea,
  margin = 8
): WindowRectangle | null {
  const values = [
    bounds.left,
    bounds.top,
    bounds.right,
    bounds.bottom,
    workArea.x,
    workArea.y,
    workArea.width,
    workArea.height,
  ];
  if (!values.every(Number.isFinite) || workArea.width < 200 || workArea.height < 200) {
    return null;
  }

  const originalWidth = bounds.right - bounds.left;
  const originalHeight = bounds.bottom - bounds.top;
  if (originalWidth < 200 || originalHeight < 200) return null;

  const availableWidth = Math.max(200, workArea.width - margin * 2);
  const availableHeight = Math.max(200, workArea.height - margin * 2);
  const width = Math.min(originalWidth, availableWidth);
  const height = Math.min(originalHeight, availableHeight);
  const minLeft = workArea.x + margin;
  const minTop = workArea.y + margin;
  const maxLeft = workArea.x + workArea.width - margin - width;
  const maxTop = workArea.y + workArea.height - margin - height;
  const left = Math.min(Math.max(bounds.left, minLeft), maxLeft);
  const top = Math.min(Math.max(bounds.top, minTop), maxTop);

  const fitted = { left, top, right: left + width, bottom: top + height };
  const changed = fitted.left !== bounds.left ||
    fitted.top !== bounds.top ||
    fitted.right !== bounds.right ||
    fitted.bottom !== bounds.bottom;
  return changed ? fitted : null;
}
