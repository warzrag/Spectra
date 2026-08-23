export interface ExtensionLaunchPolicyInput {
  extensionName: string;
  hasTargetTweet: boolean;
  autoStartTwitterBot: boolean;
}

/**
 * Toutes les extensions du profil se chargent, quel que soit le mode d'ouverture.
 *
 * Une restriction avait ete posee le 11 aout 2026 : VenusBot etait ecarte des
 * lancements manuels, pour donner aux pages de connexion X un contexte propre.
 * C'etait une hypothese sur la cause des refus de connexion, et elle etait
 * fausse. La bisection du 12 aout a montre que le robot n'y etait pour rien --
 * les causes reelles etaient le binaire Chrome for Testing, puis les
 * substitutions d'identite en JavaScript (voir puppeteer-launcher.ts).
 *
 * La restriction ne protegeait donc de rien et privait l'utilisateur de ses
 * extensions en ouverture normale. Elle est levee.
 *
 * La fonction est conservee : c'est le point unique ou brancher une regle si
 * un jour une extension doit vraiment etre ecartee d'un mode de lancement.
 */
export function shouldLoadExtensionForLaunch(
  _input: ExtensionLaunchPolicyInput
): boolean {
  return true;
}
