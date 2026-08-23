export type SpectraLaunchMode =
  | 'manual'
  | 'automation'
  | 'open-post'
  | 'session-import'
  | 'publication';

export interface LaunchPolicyInput {
  launchMode?: SpectraLaunchMode;
  autoStartTwitterBot?: boolean;
  targetTweetUrl?: string | null;
  sessionImportAttemptId?: string | null;
  /** Un mass post ou un branding : Spectra pilote l'instance, l'utilisateur non. */
  publication?: boolean;
}

/**
 * A quel titre ce profil s'ouvre-t-il.
 *
 * `publication` a ete ajoute le 23 aout 2026. Un mass post ne portait aucun
 * des trois marqueurs precedents : il tombait donc en « manuel », avec deux
 * consequences qui le rendaient inoperant des que le profil avait deja servi.
 *
 *   1. shouldAppendLaunchUrl n'imposait aucune adresse -- Chrome rouvrait ses
 *      onglets d'avant, souvent une page vide, et le navigateur restait la ;
 *   2. l'extension ne se mettait pas en mode pilote, donc personne ne la
 *      renvoyait sur X.
 *
 * Cela ne se voyait pas sur un poste ou ces profils ne servent qu'au mass
 * post : sans session Chrome a restaurer, l'adresse etait imposee et tout
 * marchait. Sur un VPS ou les memes profils sont ouverts a la main tous les
 * jours, aucun mass post n'aboutissait -- constate le 23 aout 2026, et ce
 * chemin n'avait alors jamais servi sur un VPS.
 */
export function resolveLaunchMode(input: LaunchPolicyInput): SpectraLaunchMode {
  if (input.launchMode) return input.launchMode;
  if (input.sessionImportAttemptId) return 'session-import';
  if (input.targetTweetUrl) return 'open-post';
  if (input.publication) return 'publication';
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
