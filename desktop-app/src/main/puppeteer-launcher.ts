import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import * as net from 'net';
import * as crypto from 'crypto';
import { spawn, execFile, ChildProcess } from 'child_process';
import { install, Browser, detectBrowserPlatform } from '@puppeteer/browsers';
import { resolveVenusAutostartState } from './venus-autostart-state';
import { normalizeTweetUrl } from '../shared/twitter-url';
import { hasAuthenticatedXSession } from '../shared/x-auth-snapshot';
import { shouldLoadExtensionForLaunch } from '../shared/extension-launch-policy';
import { ProxyGeoSnapshot, ProxyManager } from './proxy-manager';
import {
  isManagedLaunch,
  fitWindowToWorkArea,
  resolveLaunchMode,
  shouldAppendLaunchUrl,
  shouldOpenSetupTab,
  SpectraLaunchMode,
} from '../shared/launch-policy';

// Keep the managed browser aligned with the Chrome version advertised by new profiles.
//
// Doit suivre le canal stable de Chrome for Testing. Mesure du 11 aout 2026 sur
// tls.browserleaks.com : la 151.0.7922.47 envoie 18 extensions TLS (ja4
// t13d1518h2) la ou le Chrome stable 151.0.7922.76 en envoie 16 (t13d1516h2).
// Deux extensions de trop, 0x12E0 et 0xCA34 : la poignee de main ne correspond
// alors a aucun Chrome existant. C'est la premiere chose qu'un serveur voit,
// avant tout en-tete et tout JavaScript, et aucun masquage ne peut la corriger.
const MANAGED_CHROME_VERSION = '151.0.7922.77';

export interface PuppeteerLaunchOptions {
  profileId: string;
  profileName: string;
  launchMode?: SpectraLaunchMode;
  platform?: string;
  userAgent?: string;
  proxy?: any;
  fingerprint?: any;
  lastUrl?: string;
  connectionType?: string;
  extensionPaths?: string[];
  windowLayout?: { index: number; total: number };
  autoStartTwitterBot?: boolean;
  targetTweetUrl?: string;
  sessionImport?: { attemptId: string };
  /** Dossier de l'instance : c'est lui qui porte le modele de reglages du bot. */
  folderId?: string;
  /** Branding a poser sur le profil X. Les images arrivent en data URL. */
  branding?: {
    attemptId: string;
    nom?: string | null;
    bio?: string | null;
    lien?: string | null;
    lieu?: string | null;
    photo?: string | null;
    banniere?: string | null;
  };
  /** Une publication a envoyer depuis ce compte. Le media arrive en data URL. */
  massPost?: {
    attemptId: string;
    texte?: string | null;
    media?: string | null;
    nomMedia?: string | null;
  };
  /** Cette instance sert de reference pour le robot dans son dossier. */
  botTemplate?: boolean;
  /** Empreinte du modele deja applique ici, pour ne pas reecrire a chaque fois. */
  botTemplateApplied?: string;
}

/**
 * Ecrit un script injecte, apres avoir verifie qu'il se compile.
 *
 * Le 22 aout 2026, le mass post n'a plus rien fait pendant des heures :
 * une expression reguliere du script contenait un vrai saut de ligne --
 * un « \n » ecrit « 
 » dans le gabarit, donc transforme en retour a la
 * ligne au moment de fabriquer le fichier. Chrome refusait tout le script,
 * en silence. Le navigateur s'ouvrait sur x.com/home et restait la.
 *
 * new Function() analyse sans executer : c'est exactement le controle qui
 * manquait. On ecrit quand meme -- refuser laisserait le profil sans
 * script du tout, ce qui n'aide personne -- mais l'erreur est ecrite dans
 * la console de Spectra, la ou on la verra.
 */
function ecrireScriptInjecte(chemin: string, code: string): void {
  try {
    // eslint-disable-next-line no-new-func
    new Function(code);
  } catch (erreur) {
    console.error(
      '[Spectra] Le script injecte ' + path.basename(chemin) +
      ' ne se compile pas : ' + String(erreur && (erreur as Error).message) +
      ' — Chrome le rejettera en entier et l’action ne fera rien.'
    );
  }
  fs.writeFileSync(chemin, code);
}


export class PuppeteerLauncher {
  private static activeProfiles = new Map<string, any>();
  private static pendingProfiles = new Set<string>();
  private static pendingLaunchModes = new Map<string, SpectraLaunchMode>();
  private static cancelledProfiles = new Set<string>();
  private static launchConfirmationWaiters = new Map<
    string,
    { resolve: (status: string) => void; timeout: NodeJS.Timeout }
  >();
  private static browserVersions = new Map<string, Promise<string | null>>();
  private static mainWindow: any = null;
  private static localServerConfig: { port: number; token: string } | null = null;
  private static readonly compactWindow = { width: 900, height: 720, margin: 0, gap: 0 };
  private static readonly openSelectedWindow = {
    width: 620,
    height: 520,
    margin: 8,
    gap: 8,
  };
  /**
   * Fenetres du branding : plus petites, pour en aligner davantage.
   *
   * Personne ne travaille dedans -- on les regarde s'executer. Un ecran 1920
   * en tient six par ligne au lieu de trois, et le formulaire des reglages de X
   * reste lisible a cette largeur.
   */
  private static readonly brandingWindow = {
    width: 460,
    height: 420,
    margin: 6,
    gap: 6,
  };

  private static getProfilesRoot(): string {
    return process.platform === 'win32'
      ? path.join(os.homedir(), 'AppData', 'Local', 'AntidetectBrowser', 'Profiles')
      : path.join(os.homedir(), '.antidetect-browser', 'profiles');
  }

  private static appendLifecycleEvent(
    profileId: string,
    event: string,
    details: Record<string, unknown> = {}
  ): void {
    try {
      this.assertSafeId(profileId, 'profile ID');
      const profilesRoot = this.getProfilesRoot();
      const profilePath = path.join(profilesRoot, profileId);
      const logsPath = path.join(path.dirname(profilesRoot), 'Logs');
      fs.mkdirSync(profilePath, { recursive: true });
      fs.mkdirSync(logsPath, { recursive: true });
      const record = JSON.stringify({
        timestamp: new Date().toISOString(),
        profileId,
        event: String(event || 'unknown').slice(0, 96),
        details,
      }) + os.EOL;
      fs.appendFileSync(path.join(profilePath, '.spectra-lifecycle.ndjson'), record, 'utf8');
      fs.appendFileSync(path.join(logsPath, 'profile-lifecycle.ndjson'), record, 'utf8');
    } catch (error) {
      console.warn(`[Lifecycle] Could not persist ${event} for ${profileId}:`, error);
    }
  }

  static reportLifecycleEvent(payload: {
    profileId?: string;
    launchId?: string;
    event?: string;
    details?: Record<string, unknown>;
  }): void {
    const profileId = String(payload?.profileId || '');
    const event = String(payload?.event || '');
    if (!profileId || !event) return;
    const safeDetails = payload?.details && typeof payload.details === 'object'
      ? payload.details
      : {};
    this.appendLifecycleEvent(profileId, `chrome-${event}`, {
      launchId: String(payload?.launchId || '').slice(0, 96),
      ...safeDetails,
    });
  }

  /**
   * Une instance Open Post qui n'aboutit jamais reste ouverte exactement le
   * temps de la limite, puis se fait fermer de force. Mesure du 15 aout 2026 sur
   * le VPS 128 : une instance saine se ferme en 5 a 17 s, une instance bloquee
   * en 65 s -- trente fois de suite, sans jamais quitter la page blanche.
   *
   * Le magasin du service worker du profil en etait la cause. L'effacer suffit :
   * sept echecs a 65 s d'affilee sur `lashikipooh`, puis 8 s et un repost au
   * lancement suivant, sans qu'aucune autre chose ait change.
   *
   * On ne nettoie pas sur un seuil de taille : ce serait faux. Des profils
   * parfaitement sains portent 2988 fichiers et 1,3 Go la ou les malades en
   * avaient 1370 pour 273 Mo. On nettoie sur le symptome, et seulement pour le
   * profil qui l'a montre deux fois de suite.
   *
   * Les cookies vivent dans `Default\Network\Cookies` : la session n'est pas
   * touchee, et Chrome refabrique le magasin a l'ouverture suivante.
   */
  /**
   * Efface le cache du service worker de l'extension.
   *
   * C'est la seule facon de garantir que Chrome lit le code fraichement
   * ecrit, avec l'adresse du tweet du tour en cours. Sans cela il ressert
   * celui du lancement precedent, et l'onglet part sur l'ancien tweet.
   */
  private static viderCacheServiceWorker(profileId: string, profilePath: string): void {
    try {
      const magasin = path.join(profilePath, 'Default', 'Service Worker');
      if (!fs.existsSync(magasin)) return;
      fs.rmSync(magasin, { recursive: true, force: true });
      this.appendLifecycleEvent(profileId, 'service-worker-reset', {
        raison: 'cache vide avant le tour',
      });
    } catch (error) {
      // Un fichier verrouille ne doit pas empecher le tour : au pire
      // l'instance repartira sur l'ancien tweet, comme avant.
      console.warn('[Spectra] Cache du service worker non vide:', error);
    }
  }

  private static reinitialiserServiceWorkerSiBloque(
    profileId: string,
    profilePath: string
  ): void {
    try {
      const journal = path.join(profilePath, '.spectra-lifecycle.ndjson');
      if (!fs.existsSync(journal)) return;

      // Seule la fin du journal nous interesse, et il grossit sans limite.
      const taille = fs.statSync(journal).size;
      const debut = Math.max(0, taille - 64 * 1024);
      const descripteur = fs.openSync(journal, 'r');
      const tampon = Buffer.alloc(taille - debut);
      fs.readSync(descripteur, tampon, 0, tampon.length, debut);
      fs.closeSync(descripteur);

      const lignes = tampon.toString('utf8').split(/\r?\n/).filter(Boolean);
      const tours: Array<{ duree: number; abouti: boolean }> = [];
      let ouverture: { heure: number; openPost: boolean; abouti: boolean } | null = null;

      for (const ligne of lignes) {
        let entree: any;
        try {
          entree = JSON.parse(ligne);
        } catch {
          continue;
        }
        const heure = Date.parse(entree?.timestamp || '');
        if (!Number.isFinite(heure)) continue;

        if (entree.event === 'launch-requested') {
          ouverture = { heure, openPost: entree?.details?.hasTargetTweet === true, abouti: false };
          continue;
        }
        if (!ouverture) continue;
        // Le seul aboutissement qui compte, c'est le retweet. Une page chargee
        // ne prouve rien : une instance peut ouvrir le tweet et repartir sans
        // rien faire -- deconnectee, ou l'article jamais trouve.
        if (
          entree.event === 'chrome-open-post-verdict' && entree?.details?.retweet === true
        ) ouverture.abouti = true;
        if (
          entree.event === 'chrome-open-post-repost-result' &&
          ['reposted', 'already-reposted'].includes(String(entree?.details?.status || ''))
        ) ouverture.abouti = true;
        if (
          entree.event === 'forced-close-completed' ||
          entree.event === 'profile-processes-gone'
        ) {
          if (ouverture.openPost) {
            tours.push({ duree: heure - ouverture.heure, abouti: ouverture.abouti });
          }
          ouverture = null;
        }
      }

      /**
       * Le critere, c'est le resultat : deux tours de suite sans retweet.
       *
       * Trois criteres ont echoue avant celui-ci, chacun trop etroit :
       * une duree de 55 a 95 s, puis de 30 s, puis l'absence de page chargee.
       * Le dernier ratait `dutchdenis` -- son avant-dernier tour avait bien
       * charge la page, mais sans jamais trouver le tweet. Compte comme sain,
       * donc jamais repare, alors qu'il echouait.
       *
       * Le 18 aout 2026 a minuit : 23 instances muettes, **zero** reparation
       * declenchee. Un remede qui marche mais qui ne part jamais ne sert a
       * rien.
       *
       * Une instance qui a ouvert deux fois sans rien reposter est bloquee,
       * quelle que soit la facon dont elle a echoue. Effacer son magasin ne
       * coute rien -- le navigateur le reconstruit -- et la remet en marche.
       */
      const deuxDerniers = tours.slice(-2);
      if (deuxDerniers.length < 2 || deuxDerniers.some((tour) => tour.abouti)) return;

      const magasin = path.join(profilePath, 'Default', 'Service Worker');
      if (!fs.existsSync(magasin)) return;

      fs.rmSync(magasin, { recursive: true, force: true });
      this.appendLifecycleEvent(profileId, 'service-worker-reset', {
        raison: 'deux tours de suite sans retweet',
        durees: deuxDerniers.map((tour) => Math.round(tour.duree / 1000)),
      });
      console.log(
        `[Spectra] Magasin du service worker remis a neuf pour ${profileId} ` +
        `(${deuxDerniers.map((tour) => Math.round(tour.duree / 1000)).join(' s, ')} s muets)`
      );
    } catch (error) {
      console.warn('[Spectra] Reinitialisation du service worker impossible:', error);
    }
  }

  /**
   * A la premiere connexion, Chrome propose d'enregistrer le mot de passe dans
   * son gestionnaire. Cette fenetre appartient au navigateur, pas a la page :
   * aucun script ne peut la fermer. Elle recouvre l'ecran au moment ou X
   * demande le code 2FA, et prend le focus du clavier.
   *
   * Elle ne sert a rien ici : la session voyage par les cookies, jamais par le
   * gestionnaire de mots de passe. On demande donc a Chrome de ne plus poser la
   * question, en ecrivant la preference dans le profil avant l'ouverture.
   */
  private static desactiverGestionnaireMotsDePasse(profilePath: string): void {
    const chemin = path.join(profilePath, 'Default', 'Preferences');
    try {
      let preferences: Record<string, any> = {};
      if (fs.existsSync(chemin)) {
        // Un fichier illisible ne doit pas etre remplace : on n'y touche pas
        // plutot que de repartir d'un profil vide.
        try {
          preferences = JSON.parse(fs.readFileSync(chemin, 'utf8'));
        } catch {
          return;
        }
      }
      preferences.credentials_enable_service = false;
      preferences.credentials_enable_autosignin = false;
      preferences.profile = {
        ...(preferences.profile || {}),
        password_manager_enabled: false,
        password_manager_leak_detection: false,
      };
      fs.mkdirSync(path.dirname(chemin), { recursive: true });
      fs.writeFileSync(chemin, JSON.stringify(preferences), 'utf8');
    } catch (error) {
      console.warn('[Spectra] Preference du gestionnaire de mots de passe non ecrite:', error);
    }
  }

  private static assertSafeId(value: string, label: string): void {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(value)) {
      throw new Error(`Invalid ${label}`);
    }
  }

  private static runPowerShell(script: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error((stderr || error.message).trim()));
            return;
          }
          resolve(stdout.trim());
        }
      );
    });
  }

  private static async getBrowserVersion(executablePath: string): Promise<string | null> {
    const normalizedPath = path.resolve(executablePath);
    const managedBrowserRoot = path.join(
      os.homedir(),
      '.antidetect-browser',
      'browser',
      'chrome'
    );
    const pathVersion = normalizedPath.match(/(\d+\.\d+\.\d+\.\d+)/)?.[1];

    if (pathVersion && normalizedPath.startsWith(`${managedBrowserRoot}${path.sep}`)) {
      return pathVersion;
    }

    const cached = this.browserVersions.get(normalizedPath);
    if (cached) return cached;

    const versionPromise = (async () => {
      if (process.platform === 'win32') {
        const escapedPath = normalizedPath.replace(/'/g, "''");
        try {
          const version = await this.runPowerShell(
            `(Get-Item -LiteralPath '${escapedPath}').VersionInfo.FileVersion`
          );
          const normalized = version.match(/\d+\.\d+\.\d+\.\d+/)?.[0];
          if (normalized) return normalized;
        } catch (error) {
          console.warn('[Browser] Could not inspect executable version:', error);
        }
      }

      return pathVersion || null;
    })();

    this.browserVersions.set(normalizedPath, versionPromise);
    return versionPromise;
  }

  private static alignUserAgentToBrowser(userAgent: string, browserVersion: string | null): string {
    if (!userAgent || !browserVersion) return userAgent;

    // Chrome gele les trois derniers composants de sa version dans l'User-Agent
    // depuis la reduction de 2023 : tous les Chrome du monde annoncent
    // Chrome/<majeure>.0.0.0. Aligner sur la version complete du binaire
    // produisait une chaine qu'aucun navigateur authentique n'envoie.
    const reducedVersion = `${String(browserVersion).split('.')[0]}.0.0.0`;
    const advertisedVersion = userAgent.match(/\bChrome\/(\d+\.\d+\.\d+\.\d+)/)?.[1];
    if (!advertisedVersion || advertisedVersion === reducedVersion) return userAgent;

    console.warn(
      `[Browser] User-Agent reduit comme le fait Chrome: ${advertisedVersion} -> ${reducedVersion}`
    );
    return userAgent.replace(
      /\bChrome\/\d+\.\d+\.\d+\.\d+\b/,
      `Chrome/${reducedVersion}`
    );
  }

  /**
   * Reproduit l'algorithme GREASE de Chromium pour la liste des marques.
   *
   * Le libelle du jeton de remplissage, sa version et sa position dans la liste
   * changent a chaque version majeure, de facon deterministe. Spectra les avait
   * figes : la valeur livree etait celle de Chrome 131 avec le numero courant
   * colle dessus. Mesure du 11 aout 2026 :
   *   Chrome 151 reel : "Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"
   *   Spectra         : "Google Chrome";v="151", "Chromium";v="151", "Not_A Brand";v="24"
   * Cette etiquette part sur chaque requete, avant tout JavaScript.
   */
  private static chromeBrandList(majorVersion: string): Array<{ brand: string; version: string }> {
    const chars = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
    const greasedVersions = ['8', '99', '24'];
    const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    const seed = Number(majorVersion);
    const order = orders[seed % 6];
    const list: Array<{ brand: string; version: string }> = [];
    list[order[0]] = {
      brand: `Not${chars[seed % 11]}A${chars[(seed + 1) % 11]}Brand`,
      version: greasedVersions[seed % 3],
    };
    list[order[1]] = { brand: 'Chromium', version: majorVersion };
    list[order[2]] = { brand: 'Google Chrome', version: majorVersion };
    return list;
  }

  /**
   * Chromium derives Accept-Language from the browser locale. --lang is honoured on
   * Windows but largely ignored on macOS, where the system language wins: a US profile
   * opened on a French Mac announced "fr-FR" behind a US proxy. Build the header from
   * the fingerprint so it stays identical on every host.
   */
  private static buildAcceptLanguage(fingerprint: any): string {
    const languages: string[] = Array.isArray(fingerprint?.languages) && fingerprint.languages.length
      ? fingerprint.languages
      : [fingerprint?.language || 'en-US'];

    return languages
      .filter((language: string) => typeof language === 'string' && language.length > 0)
      .map((language: string, index: number) => {
        if (index === 0) return language;
        const quality = Math.max(0.1, 1 - index * 0.1);
        return `${language};q=${quality.toFixed(1)}`;
      })
      .join(',');
  }

  private static languagesForCountry(countryCode: string): { language: string; languages: string[] } {
    const locales: Record<string, string> = {
      US: 'en-US', GB: 'en-GB', CA: 'en-CA', AU: 'en-AU', NZ: 'en-NZ',
      FR: 'fr-FR', BE: 'fr-BE', CH: 'de-CH', DE: 'de-DE', AT: 'de-AT',
      ES: 'es-ES', MX: 'es-MX', AR: 'es-AR', BR: 'pt-BR', PT: 'pt-PT',
      IT: 'it-IT', NL: 'nl-NL', PL: 'pl-PL', CZ: 'cs-CZ', SE: 'sv-SE',
      NO: 'nb-NO', DK: 'da-DK', FI: 'fi-FI', JP: 'ja-JP', KR: 'ko-KR',
      CN: 'zh-CN', TW: 'zh-TW', HK: 'zh-HK', IN: 'en-IN', SG: 'en-SG',
      RU: 'ru-RU', UA: 'uk-UA', TR: 'tr-TR', ID: 'id-ID', TH: 'th-TH',
    };
    const language = locales[String(countryCode || '').toUpperCase()] || 'en-US';
    const base = language.split('-')[0];
    return { language, languages: base === language ? [language] : [language, base] };
  }

  private static alignFingerprintWithProxyGeo(fingerprint: any, geo: ProxyGeoSnapshot): any {
    const locale = this.languagesForCountry(geo.countryCode);
    return {
      ...fingerprint,
      timezone: geo.timezone,
      language: locale.language,
      languages: locale.languages,
      proxyGeo: {
        ip: geo.ip,
        countryCode: geo.countryCode,
        region: geo.region,
        city: geo.city,
        latitude: geo.latitude,
        longitude: geo.longitude,
        accuracy: 20000,
        checkedAt: geo.checkedAt,
      },
    };
  }

  /**
   * Chromium builds User-Agent Client Hints from the real OS and --user-agent does not
   * regenerate them, so a Windows-fingerprinted profile opened on macOS advertises
   * Sec-CH-UA-Platform: "macOS" while its User-Agent claims Windows. No CDP is available
   * on this launcher by design, so the per-profile MV3 extension rewrites the headers.
   */
  // L'interrupteur de diagnostic qui se posait ici -- un fichier temoin depose
  // dans le dossier personnel, relu a chaque lancement, capable de retirer
  // l'empreinte, les en-tetes ou les extensions -- a ete retire le 15 aout
  // 2026. Il avait servi a trouver ce que X refusait en aout 2026 ; sa reponse
  // est acquise et inscrite dans le code. Le laisser dans une version livree,
  // c'etait laisser un fichier depose par erreur eteindre les protections d'un
  // profil sans que personne le remarque. Le nom du fichier et le detail des
  // modes sont dans tests/security-regression.test.js et dans l'historique git.

  private static buildClientHintsRules(
    clientHintsPlatform: string,
    acceptLanguage: string,
    browserVersion: string
  ) {
    const majorVersion = /^\d+/.exec(browserVersion)?.[0] || '151';
    const secChUa = this.chromeBrandList(majorVersion)
      .map((b) => `"${b.brand}";v="${b.version}"`)
      .join(', ');
    return [
      {
        id: 1,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            {
              header: 'sec-ch-ua-platform',
              operation: 'set',
              value: `"${clientHintsPlatform}"`,
            },
            {
              header: 'accept-language',
              operation: 'set',
              value: acceptLanguage,
            },
            {
              header: 'sec-ch-ua',
              operation: 'set',
              value: secChUa,
            },
            // Les hints de haute entropie ne sont plus retires. Un site qui les
            // demande via Accept-CH — ce que fait X — recevait une reponse complete
            // en JavaScript et un silence total en en-tete. Aucun Chrome authentique
            // ne se comporte ainsi. L'hote etant Windows et les profils annoncant
            // Windows, les valeurs reelles sont coherentes avec l'empreinte.
            // Sur un hote dont l'OS differe du profil, il faudrait les FIXER, pas
            // les retirer.
          ],
        },
        condition: {
          urlFilter: '*',
          resourceTypes: [
            'main_frame',
            'sub_frame',
            'stylesheet',
            'script',
            'image',
            'font',
            'object',
            'xmlhttprequest',
            'ping',
            'csp_report',
            'media',
            'websocket',
            'other',
          ],
        },
      },
    ];
  }

  /**
   * Liste les processus Chrome d'un profil sur macOS et Linux.
   *
   * On lit la table complete des processus et on filtre en JavaScript plutot que
   * de passer le chemin a pgrep : un chemin de profil contient des espaces et des
   * caracteres que pgrep interpreterait comme une expression reguliere.
   */
  /**
   * La table des processus, lue en une fois.
   *
   * Separee de la recherche par profil : interroger le systeme une fois par
   * instance ferait quarante-sept appels a chaque rafraichissement de la liste.
   */
  private static async lireTableProcessus(): Promise<string> {
    return new Promise<string>((resolve) => {
      try {
        const child = spawn('ps', ['-Awwo', 'pid=,command='], {
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        let collected = '';
        child.stdout?.on('data', (chunk) => { collected += String(chunk); });
        child.on('error', () => resolve(''));
        child.on('close', () => resolve(collected));
      } catch {
        resolve('');
      }
    });
  }

  private static async getPosixProfileProcessIds(profilePath: string): Promise<number[]> {
    const output = await this.lireTableProcessus();

    const ids: number[] = [];
    for (const line of output.split('\n')) {
      if (!line.includes(profilePath)) continue;
      if (!/chrome|chromium/i.test(line)) continue;
      const processId = Number(line.trim().split(/\s+/)[0]);
      if (Number.isFinite(processId) && processId > 0) ids.push(processId);
    }
    return ids;
  }

  private static async getProfileProcessIds(profilePath: string): Promise<number[]> {
    if (process.platform !== 'win32') return this.getPosixProfileProcessIds(profilePath);
    const escapedPath = profilePath.replace(/'/g, "''");
    try {
      const output = await this.runPowerShell(`
        $profilePath = '${escapedPath}'
        Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" |
          Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profilePath) } |
          ForEach-Object { $_.ProcessId }
      `);
      return output
        .split(/\r?\n/)
        .map(Number)
        .filter(processId => Number.isFinite(processId) && processId > 0);
    } catch (error) {
      console.warn('[Chrome] Could not inspect existing profile processes:', error);
      return [];
    }
  }

  private static async terminateProfileProcesses(profilePath: string): Promise<void> {
    if (process.platform !== 'win32') {
      // Sans cette branche, fermer un profil ne faisait rien hors Windows : la
      // fenetre restait ouverte, et Open selected / Auto Post attendaient sa
      // fermeture jusqu'au delai de 60 s avant d'annoncer a tort "proxy too slow".
      const ids = await this.getPosixProfileProcessIds(profilePath);
      for (const processId of ids) {
        try {
          process.kill(processId, 'SIGTERM');
        } catch { /* processus deja termine */ }
      }
      if (!ids.length) return;
      await new Promise(resolve => setTimeout(resolve, 2000));
      for (const processId of await this.getPosixProfileProcessIds(profilePath)) {
        try {
          process.kill(processId, 'SIGKILL');
        } catch { /* processus deja termine */ }
      }
      return;
    }
    const escapedPath = profilePath.replace(/'/g, "''");
    try {
      await this.runPowerShell(`
        $profilePath = '${escapedPath}'
        Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" |
          Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profilePath) } |
          ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
          }
      `);
    } catch (error) {
      console.warn('[Chrome] Could not terminate stale profile processes:', error);
    }
  }

  private static async waitForVisibleWindow(
    profilePath: string,
    timeoutMs = 12000,
    preferredProcessId?: number
  ): Promise<number | null> {
    if (process.platform !== 'win32') return null;
    const escapedPath = profilePath.replace(/'/g, "''");
    const timeoutSeconds = Math.max(3, Math.ceil(timeoutMs / 1000));
    const preferredPid = Number.isFinite(preferredProcessId) && Number(preferredProcessId) > 0
      ? Number(preferredProcessId)
      : 0;
    const output = await this.runPowerShell(`
      $profilePath = '${escapedPath}'
      $preferredPid = ${preferredPid}
      $deadline = (Get-Date).AddSeconds(${timeoutSeconds})
      do {
        if ($preferredPid -gt 0) {
          $preferredProcess = Get-Process -Id $preferredPid -ErrorAction SilentlyContinue
          if ($preferredProcess) {
            $preferredProcess.Refresh()
            if ($preferredProcess.MainWindowHandle -ne 0) {
              Write-Output $preferredProcess.MainWindowHandle
              exit 0
            }
          }
        }
        $browserProcesses = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" |
          Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profilePath) }
        foreach ($browserProcess in $browserProcesses) {
          $process = Get-Process -Id $browserProcess.ProcessId -ErrorAction SilentlyContinue
          if ($process -and $process.MainWindowHandle -ne 0) {
            Write-Output $process.MainWindowHandle
            exit 0
          }
        }
        Start-Sleep -Milliseconds 250
      } while ((Get-Date) -lt $deadline)
      exit 2
    `);
    const handle = Number(output.split(/\r?\n/).find(Boolean));
    return Number.isFinite(handle) && handle > 0 ? handle : null;
  }

  private static clearStaleSingletonFiles(profilePath: string): void {
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      const target = path.join(profilePath, name);
      try {
        // Sur macOS et Linux, ces trois temoins sont des liens symboliques qui
        // pointent vers `machine-numero`. Apres une fermeture forcee -- ce que
        // le bot fait a chaque tour -- le lien survit alors que sa cible n'existe
        // plus. `existsSync` suit le lien et repond alors "absent" : le verrou
        // n'etait jamais retire, et Chrome refusait de rouvrir le profil.
        // `lstatSync` regarde le lien lui-meme et voit la verite.
        //
        // Sur Windows ces fichiers n'existent pas : la fonction n'y fait rien,
        // avant comme apres.
        fs.lstatSync(target);
      } catch {
        continue; // vraiment absent
      }
      try {
        fs.rmSync(target, { force: true, recursive: true });
      } catch (error) {
        console.warn(`[Chrome] Could not remove stale ${name}:`, error);
      }
    }
  }

  static setMainWindow(win: any) {
    this.mainWindow = win;
  }

  static setLocalServerConfig(config: { port: number; token: string }) {
    this.localServerConfig = config;
  }

  private static sendProgress(percent: number, status: string) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('browser:downloadProgress', { percent, status });
    }
  }

  static isProfileActive(profileId: string): boolean {
    return this.activeProfiles.has(profileId);
  }

  static reportLaunchStatus(payload: {
    profileId?: string;
    launchId?: string;
    status?: string;
    details?: Record<string, unknown>;
  }): void {
    const profileId = String(payload?.profileId || '');
    const launchId = String(payload?.launchId || '');
    const status = String(payload?.status || '');
    if (!profileId || !launchId || !status) return;

    const key = `${profileId}:${launchId}`;
    console.log(`[Spectra AutoStart] ${profileId} status: ${status}`, payload.details || {});
    const waiter = this.launchConfirmationWaiters.get(key);
    if (!waiter) return;
    if (status !== 'venus-confirmed' && status !== 'manual-pause-preserved') return;

    clearTimeout(waiter.timeout);
    this.launchConfirmationWaiters.delete(key);
    waiter.resolve(status);
  }

  private static waitForLaunchConfirmation(
    profileId: string,
    launchId: string,
    timeoutMs = 90000
  ): Promise<string> {
    const key = `${profileId}:${launchId}`;
    return new Promise(resolve => {
      const timeout = setTimeout(() => {
        this.launchConfirmationWaiters.delete(key);
        resolve('timeout');
      }, timeoutMs);
      this.launchConfirmationWaiters.set(key, { resolve, timeout });
    });
  }

  private static cancelLaunchConfirmation(profileId: string, launchId: string): void {
    const key = `${profileId}:${launchId}`;
    const waiter = this.launchConfirmationWaiters.get(key);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    this.launchConfirmationWaiters.delete(key);
    waiter.resolve('process-exited');
  }

  static async diagnoseEnvironment() {
    const cacheDir = path.join(os.homedir(), '.antidetect-browser', 'browser');
    const markerPath = path.join(cacheDir, '.installed');
    const profilesDir = process.platform === 'win32'
      ? path.join(os.homedir(), 'AppData', 'Local', 'AntidetectBrowser', 'Profiles')
      : path.join(os.homedir(), '.antidetect-browser', 'profiles');
    let managedBrowserPath = '';
    try {
      managedBrowserPath = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8').trim() : '';
    } catch {}

    let profilesDirectoryWritable = false;
    try {
      fs.mkdirSync(profilesDir, { recursive: true });
      const probe = path.join(profilesDir, `.spectra-write-test-${process.pid}`);
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      profilesDirectoryWritable = true;
    } catch {}

    let powershellAvailable = process.platform !== 'win32';
    if (process.platform === 'win32') {
      try {
        powershellAvailable = (await this.runPowerShell("Write-Output 'ok'")) === 'ok';
      } catch {}
    }

    return {
      platform: process.platform,
      architecture: process.arch,
      osRelease: os.release(),
      managedBrowserPath,
      managedBrowserReady: Boolean(managedBrowserPath && fs.existsSync(managedBrowserPath)),
      systemBrowserPath: this.findSystemChrome() || '',
      profilesDir,
      profilesDirectoryWritable,
      powershellAvailable,
      activeProfileIds: this.getActiveProfiles(),
    };
  }

  private static focusProfileWindow(profileId: string): boolean {
    const instance = this.activeProfiles.get(profileId);
    const pid = instance?.chromeProcess?.pid;
    if (!pid || process.platform !== 'win32') return false;

    const ps = `
      Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
      $p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
      if ($p) {
        $deadline = (Get-Date).AddSeconds(3)
        while ($p.MainWindowHandle -eq 0 -and (Get-Date) -lt $deadline) {
          Start-Sleep -Milliseconds 150
          $p.Refresh()
        }
        if ($p.MainWindowHandle -ne 0) {
          [Win32]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
          [Win32]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
        }
      }
    `;

    try {
      spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], {
        detached: true,
        stdio: 'ignore',
      }).unref();
      return true;
    } catch (error) {
      console.error(`[WindowFocus] Failed to focus profile ${profileId}:`, error);
      return false;
    }
  }

  private static getWindowPlacement(
    layout?: { index: number; total: number },
    launchMode?: SpectraLaunchMode,
    branding?: boolean
  ) {
    let workArea = { x: 0, y: 0, width: 1920, height: 1080 };

    try {
      const { screen } = require('electron');
      const display = this.mainWindow && !this.mainWindow.isDestroyed()
        ? screen.getDisplayMatching(this.mainWindow.getBounds())
        : screen.getPrimaryDisplay();
      workArea = display.workArea;
    } catch {}

    const win = branding
      ? this.brandingWindow
      : launchMode === 'automation'
        ? this.openSelectedWindow
        : this.compactWindow;
    const maxColumns = Math.max(1, Math.floor((workArea.width - win.margin * 2 + win.gap) / (win.width + win.gap)));
    const columns = Math.max(1, maxColumns);
    const rawSlot = Math.max(0, layout?.index ?? this.activeProfiles.size);
    const maxRows = Math.max(1, Math.floor(
      (workArea.height - win.margin * 2 + win.gap) / (win.height + win.gap)
    ));
    const visibleCapacity = Math.max(1, columns * maxRows);
    // Open Selected may launch more profiles than the display can tile. Cycle
    // through the visible slots instead of placing later windows off-screen.
    // On the VPS display this yields six slots: 7 overlays 1, 8 overlays 2, etc.
    // Cycle through the visible slots in EVERY mode. Previously only
    // 'automation' wrapped around: a manual launch used activeProfiles.size as
    // its slot with no bound, so past the display capacity the window was
    // positioned off-screen and appeared not to open at all.
    const slot = rawSlot % visibleCapacity;
    const col = slot % columns;
    const row = Math.floor(slot / columns);
    const left = workArea.x + win.margin + col * (win.width + win.gap);
    const top = workArea.y + win.margin + row * (win.height + win.gap);

    return {
      left,
      top,
      right: left + win.width,
      bottom: top + win.height,
      width: win.width,
      height: win.height,
      workArea,
    };
  }

  private static applyCleanLaunchState(profilePath: string, prefs: any) {
    prefs.profile = {
      ...(prefs.profile || {}),
      exit_type: 'Normal',
      exited_cleanly: true,
    };
    prefs.session = {
      ...(prefs.session || {}),
      restore_on_startup: 0,
      startup_urls: [],
    };

    const localStatePath = path.join(profilePath, 'Local State');
    try {
      const localState = fs.existsSync(localStatePath) ? JSON.parse(fs.readFileSync(localStatePath, 'utf8')) : {};
      localState.profile = {
        ...(localState.profile || {}),
        exit_type: 'Normal',
        exited_cleanly: true,
      };
      fs.writeFileSync(localStatePath, JSON.stringify(localState));
    } catch {}
  }

  private static applyManualLaunchState(profilePath: string, prefs: any) {
    prefs.profile = {
      ...(prefs.profile || {}),
      exit_type: 'Normal',
      exited_cleanly: true,
    };
    prefs.session = {
      ...(prefs.session || {}),
      restore_on_startup: 1,
    };

    const localStatePath = path.join(profilePath, 'Local State');
    try {
      const localState = fs.existsSync(localStatePath) ? JSON.parse(fs.readFileSync(localStatePath, 'utf8')) : {};
      localState.profile = {
        ...(localState.profile || {}),
        exit_type: 'Normal',
        exited_cleanly: true,
      };
      fs.writeFileSync(localStatePath, JSON.stringify(localState));
    } catch {}
  }

  private static hasChromeSessionRestore(profilePath: string): boolean {
    const defaultDir = path.join(profilePath, 'Default');
    const sessionTargets = [
      path.join(defaultDir, 'Current Session'),
      path.join(defaultDir, 'Current Tabs'),
      path.join(defaultDir, 'Last Session'),
      path.join(defaultDir, 'Last Tabs'),
      path.join(defaultDir, 'Sessions'),
    ];

    return sessionTargets.some(target => {
      try {
        if (!fs.existsSync(target)) return false;
        const stat = fs.statSync(target);
        if (stat.isDirectory()) return fs.readdirSync(target).length > 0;
        return stat.size > 0;
      } catch {
        return false;
      }
    });
  }

  private static fileHasAuthenticatedXSession(filePath: string): boolean {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return hasAuthenticatedXSession(parsed);
    } catch {
      return false;
    }
  }

  static hasAuthenticatedXSnapshot(profileId: string): boolean {
    this.assertSafeId(profileId, 'profile ID');
    const profilesRoot = process.platform === 'win32'
      ? path.join(os.homedir(), 'AppData', 'Local', 'AntidetectBrowser', 'Profiles')
      : path.join(os.homedir(), '.antidetect-browser', 'profiles');
    return this.ensureAuthenticatedXSnapshot(path.join(profilesRoot, profileId));
  }

  // Ce que le fichier de cookies de Chrome NE prouve pas : sur un profil pilote
  // par Open Post, Chrome est tue une seconde apres le retweet et n'a pas
  // ecrit sa base sur le disque. Le 18 aout 2026, Kirby_Maree et honeymadydy
  // avaient une base vide et ont pourtant retweete et like. La session portable
  // -- authenticated_cookies.json, reinjectee a chaque ouverture -- est donc le
  // seul temoin fiable, et c'est bien elle qu'on lit ici.
  private static ensureAuthenticatedXSnapshot(profilePath: string): boolean {
    const protectedPath = path.join(profilePath, 'authenticated_cookies.json');
    if (fs.existsSync(protectedPath) && this.fileHasAuthenticatedXSession(protectedPath)) {
      return true;
    }

    const syncedPath = path.join(profilePath, 'synced_cookies.json');
    if (!fs.existsSync(syncedPath) || !this.fileHasAuthenticatedXSession(syncedPath)) {
      return false;
    }

    try {
      const tempPath = `${protectedPath}.${process.pid}.${Date.now()}.tmp`;
      fs.copyFileSync(syncedPath, tempPath);
      fs.renameSync(tempPath, protectedPath);
      console.log('[CookieSync] Promoted current authenticated cookies to protected snapshot');
      return true;
    } catch (error) {
      console.warn('[CookieSync] Could not protect authenticated snapshot:', error);
      return false;
    }
  }

  private static clearChromeSessionRestore(profilePath: string) {
    const defaultDir = path.join(profilePath, 'Default');
    const sessionTargets = [
      path.join(defaultDir, 'Current Session'),
      path.join(defaultDir, 'Current Tabs'),
      path.join(defaultDir, 'Last Session'),
      path.join(defaultDir, 'Last Tabs'),
      path.join(defaultDir, 'Sessions'),
    ];

    for (const target of sessionTargets) {
      try {
        if (!fs.existsSync(target)) continue;
        const stat = fs.statSync(target);
        if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
        else fs.unlinkSync(target);
      } catch {}
    }
  }

  private static nextVenusRuntimeVersion(profilePath: string, sourceVersion: string): string {
    const statePath = path.join(profilePath, '.spectra-venus-runtime-version.json');
    let previousCounter = 0;

    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      previousCounter = Number(state?.counter || state?.revision || 0);
    } catch {}

    const counter = Math.max(0, previousCounter) + 1;
    const counterHigh = Math.floor(counter / 65535);
    const counterLow = counter % 65535;
    if (counterHigh > 65535) {
      throw new Error(`VenusBot runtime revision exhausted for ${sourceVersion}`);
    }

    // Early development builds used a 2026.x runtime version. Chrome rejects
    // any later 4.x copy as a downgrade and silently keeps the stale worker.
    // Reserve a high Spectra-only namespace and increase it for every mode.
    const runtimeVersion = `60000.1.${counterHigh}.${counterLow}`;
    const nextState = JSON.stringify({ sourceVersion, counter, runtimeVersion });
    const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, nextState);
    fs.renameSync(tempPath, statePath);
    return runtimeVersion;
  }

  /**
   * Reglages du robot qui appartiennent au compte, jamais au modele.
   *
   * Il y a une licence par compte X -- verifie dans la base des licences. Les
   * recopier ferait tourner deux instances sous la meme identite, et les
   * compteurs des deux comptes se melangeraient.
   */
  private static readonly CLES_PROPRES_AU_COMPTE = [
    'licenseKey',
    'currentAccount',
    'deviceId',
    'processedConversations',
    'conversationStates',
    'userGiftHistory',
    'sentGiftHistory',
    'fanMessageCount',
    'isEnabled',
    'autonomousPhase',
    'autonomousPhaseStartTime',
    'pendingAutoStart',
    'spectraPendingLaunchId',
    'manualPause',
    'nextPostingTime',
  ];

  /** Dossier ou vivent les modeles, un fichier par dossier d'instances. */
  private static cheminModeleBot(folderId: string): string {
    const racine = path.dirname(this.getProfilesRoot());
    return path.join(racine, 'BotTemplates', `${folderId}.json`);
  }

  /**
   * Range les reglages publies par une instance modele.
   *
   * Ils restent sur cette machine : ils contiennent les photos et les videos du
   * robot, jusqu'a plusieurs mega-octets, bien au-dela de ce qu'une fiche
   * Firestore accepte. Un modele ne voyage donc pas encore d'un poste a l'autre.
   */
  static enregistrerModeleBot(
    folderId: string,
    profileId: string,
    reglages: Record<string, unknown>
  ): void {
    this.assertSafeId(folderId, 'folder ID');
    this.assertSafeId(profileId, 'profile ID');

    const contenu = JSON.stringify({
      dossierId: folderId,
      profileId,
      enregistreLe: new Date().toISOString(),
      // L'empreinte dit si une instance a deja recu CE modele-la : sans elle,
      // les reglages seraient reecrits a chaque ouverture, ecrasant tout
      // ajustement fait sur place.
      empreinte: require('crypto')
        .createHash('sha256')
        .update(JSON.stringify(reglages))
        .digest('hex')
        .slice(0, 16),
      reglages,
    });

    const chemin = this.cheminModeleBot(folderId);
    fs.mkdirSync(path.dirname(chemin), { recursive: true });
    const temporaire = `${chemin}.${process.pid}.tmp`;
    fs.writeFileSync(temporaire, contenu, 'utf8');
    fs.renameSync(temporaire, chemin);
    console.log(
      `[Spectra Modele] ${Object.keys(reglages).length} reglages enregistres pour le dossier ${folderId}`
    );
  }

  /** Empreinte du modele d'un dossier, ou null s'il n'y en a pas. */
  static empreinteModeleBot(folderId: string): string | null {
    try {
      const chemin = this.cheminModeleBot(folderId);
      if (!fs.existsSync(chemin)) return null;
      return JSON.parse(fs.readFileSync(chemin, 'utf8')).empreinte || null;
    } catch {
      return null;
    }
  }

  private static configureTwitterAutoReplyAutostart(
    extensionPath: string,
    enabled: boolean,
    launchContext: {
      launchId: string;
      profileId: string;
      profileName: string;
      profilePath: string;
      /** 'modele' : cette instance sert de reference. 'copie' : elle la recoit. */
      roleModeleBot?: 'modele' | 'copie' | null;
      dossierModeleBot?: string;
    }
  ): boolean {
    const manifestPath = path.join(extensionPath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return false;

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (!this.isTwitterAutoReplyManifest(manifest)) return false;

      const venusVersion = String(manifest.version || 'unknown');
      const autoPostBridgeFile = 'spectra-auto-post-bridge.js';
      const autoPostBridgePath = path.join(extensionPath, autoPostBridgeFile);
      const autoPostBridge = `
(function () {
  const PROFILE_ID = ${JSON.stringify(launchContext.profileId)};
  const SERVER = 'http://127.0.0.1:${this.localServerConfig?.port || 0}';
  const SERVER_TOKEN = ${JSON.stringify(this.localServerConfig?.token || '')};
  // Reuse VenusBot's existing, background-allowlisted Telegram endpoint.
  const RELAY_URL = 'https://venusbot-dashboard.vercel.app/api/client/post-published';
  const PATCH_FLAG = '__spectraAutoPostBridgePatched';
  const sent = new Set();

  const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const normalizePostUrl = (value) => {
    try {
      const parsed = new URL(String(value || ''), 'https://x.com');
      const match = parsed.pathname.match(/^\\/(?:i\\/web\\/status|([A-Za-z0-9_]+)\\/status)\\/(\\d+)/i);
      if (!match) return '';
      const handle = match[1] || 'i/web';
      return handle === 'i/web'
        ? 'https://x.com/i/web/status/' + match[2]
        : 'https://x.com/' + handle + '/status/' + match[2];
    } catch {
      return '';
    }
  };

  const articleMatches = (article, expected) => {
    const textNode = article.querySelector('[data-testid="tweetText"]');
    const visibleText = normalize(textNode?.textContent || article.textContent || '');
    if (!expected) return true;
    const prefix = expected.slice(0, Math.min(80, expected.length));
    return visibleText.includes(prefix) || expected.includes(visibleText.slice(0, 80));
  };

  const findPostUrl = (text, account) => {
    const expected = normalize(text);
    const normalizedAccount = normalize(account).replace(/^@+/, '').toLowerCase();
    const candidates = Array.from(document.querySelectorAll('[data-testid="tweet"], article'));
    for (const article of candidates) {
      if (!articleMatches(article, expected)) continue;
      const links = Array.from(article.querySelectorAll('a[href*="/status/"]'));
      for (const link of links) {
        const postUrl = normalizePostUrl(link.getAttribute('href'));
        if (!postUrl) continue;
        if (
          normalizedAccount &&
          !postUrl.toLowerCase().includes('/' + normalizedAccount + '/status/')
        ) continue;
        return postUrl;
      }
    }

    const toastLinks = Array.from(
      document.querySelectorAll('[data-testid="toast"] a[href*="/status/"], a[href*="/status/"]')
    );
    for (const link of toastLinks) {
      const postUrl = normalizePostUrl(link.getAttribute('href'));
      if (
        postUrl &&
        (!normalizedAccount || postUrl.toLowerCase().includes('/' + normalizedAccount + '/status/'))
      ) return postUrl;
    }
    return '';
  };

  const resolvePostUrl = async (text, account) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const postUrl = findPostUrl(text, account);
      if (postUrl) return postUrl;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return '';
  };

  const report = async (bot, text) => {
    const stored = await new Promise((resolve) =>
      chrome.storage.local.get(['currentAccount', 'licenseKey', 'deviceId'], resolve)
    );
    const account = normalize(bot.currentAccount || stored.currentAccount || '').replace(/^@+/, '');
    const postUrl = await resolvePostUrl(text, account);
    if (!postUrl) {
      bot.sendLogToPopup && bot.sendLogToPopup('Auto Post: URL exacte introuvable');
      return;
    }
    if (sent.has(postUrl)) return;
    sent.add(postUrl);
    if (!stored.licenseKey || !stored.deviceId) {
      throw new Error('identite VenusBot incomplete');
    }
    try {
      const relayResponse = await bot._fetchViaBackground(RELAY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          licenseKey: stored.licenseKey,
        deviceId: stored.deviceId,
        relayOnly: true,
        sourceProfileId: PROFILE_ID,
          account,
          postUrl
        })
      });
      const relayPayload = await relayResponse.json().catch(() => null);
      if (!relayResponse.ok || !relayPayload?.ok) {
        throw new Error(relayPayload?.error || 'HTTP ' + relayResponse.status);
      }
      // The cloud relay is authoritative. Do not also emit locally here: two
      // Spectra installations could otherwise process the same post.
      bot.sendLogToPopup && bot.sendLogToPopup('Auto Post: publication transmise au relais Telegram');
    } catch (relayError) {
      // A local event is only a degraded-mode fallback when the cloud relay
      // could not accept the publication, so it cannot race a cloud claim.
      const localResponse = await fetch(SERVER + '/api/auto-post-event', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + SERVER_TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ sourceProfileId: PROFILE_ID, account, postUrl })
      });
      if (!localResponse.ok) throw relayError;
      bot.sendLogToPopup && bot.sendLogToPopup('Auto Post: relais central indisponible, traitement local');
    }
  };

  const install = () => {
    const bot = window.twitterAutoReplyBot || window.venusSecurityLabBot;
    if (!bot || bot[PATCH_FLAG]) return Boolean(bot?.[PATCH_FLAG]);
    for (const methodName of ['createTweet', 'createCommunityTweet']) {
      if (typeof bot[methodName] !== 'function') continue;
      const original = bot[methodName].bind(bot);
      bot[methodName] = async function spectraAutoPostAware(text, media, ...args) {
        const result = await original(text, media, ...args);
        if (result?.success) {
          report(this, text).catch((error) => {
            this.sendLogToPopup &&
              this.sendLogToPopup('Auto Post: transmission impossible (' + (error?.message || error) + ')');
          });
        }
        return result;
      };
    }
    bot[PATCH_FLAG] = true;
    return true;
  };

  if (!install()) {
    const timer = setInterval(() => {
      if (install()) clearInterval(timer);
    }, 100);
    setTimeout(() => clearInterval(timer), 10000);
  }
})();
`;
      fs.writeFileSync(autoPostBridgePath, autoPostBridge);
      // Chrome identifies VenusBot by its stable manifest key. Increment the
      // fourth version component for every runtime copy, including manual and
      // OpenPost launches, so a previous autostart worker can never survive in
      // a mode where it is disabled. The first three upstream components stay
      // intact, allowing a future VenusBot release to supersede this runtime.
      manifest.version_name = venusVersion;
      manifest.version = this.nextVenusRuntimeVersion(
        launchContext.profilePath,
        venusVersion
      );
      const contentScripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
      const contentScriptFiles = contentScripts.flatMap((script: any) =>
        Array.isArray(script.js) ? script.js : []
      );
      let contentCompatibilityPrepared = !enabled;
      for (const scriptFile of contentScriptFiles) {
        const scriptPath = path.join(extensionPath, scriptFile);
        if (!fs.existsSync(scriptPath)) continue;
        const source = fs.readFileSync(scriptPath, 'utf8');
        if (!source.includes('pendingAutoStart') || !source.includes('startAutoMode')) {
          continue;
        }
        let patched = source.replace(
          /(\[\s*['"]pendingAutoStart['"]\s*,\s*['"]pendingMode['"]\s*,\s*['"]autonomousPhase['"])((?:\s*,\s*['"](?:autonomousPhaseStartTime|manualPause|spectraPendingLaunchId)['"])*)?(\s*,\s*['"]pendingAutonomousPost['"]\s*\])/,
          (_match, prefix, optionalKeys = '', suffix) => {
            let keys = optionalKeys;
            if (!/autonomousPhaseStartTime/.test(keys)) keys += ",'autonomousPhaseStartTime'";
            if (!/manualPause/.test(keys)) keys += ",'manualPause'";
            if (!/spectraPendingLaunchId/.test(keys)) keys += ",'spectraPendingLaunchId'";
            return `${prefix}${keys}${suffix}`;
          }
        );
        const pendingGuard = 'if(e.pendingAutoStart&&!e.manualPause){';
        patched = patched.replace(
          /if\(e\.pendingAutoStart&&!e\.manualPause&&\(!sessionStorage\.getItem\(["']spectra:autostart-initializing:[^"']+["']\)\|\|e\.spectraPendingLaunchId===["'][^"']+["']\)\)\{/,
          pendingGuard
        );
        patched = patched.replace(
          /if\(e\.pendingAutoStart(?:&&!e\.manualPause)?\)\{/,
          pendingGuard
        );
        patched = patched.replace(
          /chrome\.storage\.local\.remove\(\[\s*['"]pendingAutoStart['"]\s*,\s*['"]pendingMode['"]\s*,\s*['"]autonomousPhase['"](?:\s*,\s*['"]spectraPendingLaunchId['"])?\s*\]\)/,
          "chrome.storage.local.remove(['pendingAutoStart','pendingMode','autonomousPhase','spectraPendingLaunchId'])"
        );
        patched = patched.replace(
          /:this\.isEnabled(?:&&!sessionStorage\.getItem\(["']spectra:autostart-initializing:[^"']+["']\))?&&this\.startAutoMode\(\)/,
          ':this.isEnabled&&this.startAutoMode()'
        );
        if (patched !== source) {
          fs.writeFileSync(scriptPath, patched);
          console.log(`[Spectra AutoStart] Patched cycle resume compatibility in ${scriptFile}`);
        }
        contentCompatibilityPrepared =
          patched.includes('autonomousPhaseStartTime') &&
          patched.includes('manualPause') &&
          patched.includes('spectraPendingLaunchId') &&
          patched.includes(
            "chrome.storage.local.remove(['pendingAutoStart','pendingMode','autonomousPhase','spectraPendingLaunchId'])"
          );
        if (contentCompatibilityPrepared) break;
      }
      if (!contentCompatibilityPrepared) {
        console.error('[Spectra AutoStart] VenusBot content contract is incompatible');
        return false;
      }

      const autostartFile = 'spectra-autostart.js';
      const autostartPath = path.join(extensionPath, autostartFile);
      const stateResolverSource = resolveVenusAutostartState.toString();
      const autostartScript = `
(function () {
  const PROFILE_ID = ${JSON.stringify(launchContext.profileId)};
  const PROFILE_NAME = ${JSON.stringify(launchContext.profileName)};
  const LAUNCH_ID = ${JSON.stringify(launchContext.launchId)};
  const VENUS_VERSION = ${JSON.stringify(venusVersion)};
  const READY_MARKER = 'spectra:startup-tabs-ready:' + LAUNCH_ID;
  const INIT_MARKER = 'spectra:autostart-initializing:' + LAUNCH_ID;
  const COMMAND_MARKER = 'spectra:autostart-command-sent:' + LAUNCH_ID;
  const CONFIRMED_MARKER = 'spectra:autostart-confirmed:' + LAUNCH_ID;
  const resolveVenusAutostartState = ${stateResolverSource};
  let activationInFlight = false;
  sessionStorage.setItem(INIT_MARKER, '1');

  // Les sous-pages comptent : VenusBot va lui-meme sur /requests/other pour
  // traiter la file secondaire, et sur /requests/<id> pour ouvrir une
  // conversation. Une regle qui s'arretait a /requests le renvoyait de force en
  // arriere a chaque fois, et les deux se battaient en boucle -- mesure du
  // 12 aout 2026, un aller-retour toutes les dix secondes, sans fin :
  //   QUEUE_CLICK other -> /i/chat/requests/other
  //   [Spectra AutoStart] Unexpected page, navigating back to Requests once
  //   -> /i/chat/requests, tout se recharge, et on recommence.
  const isRequestsPage = () =>
    /^\\/(?:i\\/chat|messages)\\/requests(?:\\/|$)/i.test(window.location.pathname);

  const formatRemaining = (milliseconds) => {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' +
      String(seconds % 60).padStart(2, '0');
  };

  const logHeader = () => {
    console.log('[Spectra AutoStart] Profile ' + PROFILE_ID + ' (' + PROFILE_NAME + ')');
    console.log('[Spectra AutoStart] Launch ID: ' + LAUNCH_ID);
    console.log('[Spectra AutoStart] VenusBot version: ' + VENUS_VERSION);
  };

  const waitForConfirmation = () => {
    if (sessionStorage.getItem(CONFIRMED_MARKER) === '1') return;
    const deadline = Date.now() + 30000;
    const check = () => {
      chrome.storage.local.get(
        ['isEnabled', 'mode', 'autonomousPhase', 'autonomousPhaseStartTime'],
        (state) => {
          const bot = window.twitterAutoReplyBot || window.venusSecurityLabBot;
          const running = Boolean(
            bot && bot.isRunning === true && bot.autonomousCycleRunning === true
          );
          if (state.isEnabled === true && state.mode === 'autonomous' && running) {
            sessionStorage.setItem(CONFIRMED_MARKER, '1');
            sessionStorage.removeItem(INIT_MARKER);
            chrome.storage.local.remove('spectraPendingLaunchId');
            console.log('[Spectra AutoStart] VenusBot confirmed running');
            return;
          }
          if (Date.now() < deadline) {
            window.setTimeout(check, 500);
          } else {
            sessionStorage.removeItem(INIT_MARKER);
            console.warn('[Spectra AutoStart] VenusBot start confirmation timed out');
          }
        }
      );
    };
    check();
  };

  const activate = () => {
    if (activationInFlight) {
      console.log('[Spectra AutoStart] Duplicate start blocked: initialization in progress');
      return;
    }
    if (sessionStorage.getItem(COMMAND_MARKER) === '1') {
      console.log('[Spectra AutoStart] Duplicate start blocked: command already sent');
      waitForConfirmation();
      return;
    }

    activationInFlight = true;
    chrome.storage.local.get([
      'isEnabled',
      'mode',
      'autonomousPhase',
      'autonomousPhaseStartTime',
      'autonomousRequestsTime',
      'autonomousDmsTime',
      'pendingAutoStart',
      'spectraPendingLaunchId',
      'manualPause'
    ], (state) => {
      if (chrome.runtime.lastError) {
        activationInFlight = false;
        sessionStorage.removeItem(INIT_MARKER);
        console.warn('[Spectra AutoStart] State read failed:', chrome.runtime.lastError);
        return;
      }

      if (state.manualPause === true) {
        activationInFlight = false;
        chrome.storage.local.remove(
          ['pendingAutoStart', 'pendingMode', 'spectraPendingLaunchId'],
          () => {
            sessionStorage.setItem('spectra:autostart-manual-pause:' + LAUNCH_ID, '1');
            sessionStorage.removeItem(INIT_MARKER);
            console.log('[Spectra AutoStart] Manual pause preserved; autostart skipped');
          }
        );
        return;
      }

      const bot = window.twitterAutoReplyBot || window.venusSecurityLabBot;
      if (bot && (bot.isRunning || bot.autonomousCycleRunning)) {
        sessionStorage.setItem(COMMAND_MARKER, '1');
        console.log('[Spectra AutoStart] Duplicate start blocked: VenusBot already running');
        waitForConfirmation();
        return;
      }
      if (
        state.pendingAutoStart === true &&
        state.spectraPendingLaunchId === LAUNCH_ID
      ) {
        sessionStorage.setItem(COMMAND_MARKER, '1');
        console.log('[Spectra AutoStart] Duplicate start blocked: current launch command already exists');
        // The background worker may have staged the command just after
        // VenusBot performed its one-time startup read. Reload once so the
        // native pendingAutoStart handler consumes that owned command.
        window.location.reload();
        return;
      }
      if (state.pendingAutoStart === true) {
        console.log('[Spectra AutoStart] Stale pending command replaced');
      }

      const plan = resolveVenusAutostartState(state, Date.now(), LAUNCH_ID);

      if (plan.valid) {
        console.log('[Spectra AutoStart] Existing cycle valid');
        console.log('[Spectra AutoStart] Cycle resumed');
        console.log('[Spectra AutoStart] Saved phase: ' + plan.phase);
        console.log('[Spectra AutoStart] Resuming phase: ' + plan.phase);
        console.log('[Spectra AutoStart] Saved autonomousPhaseStartTime: ' + plan.phaseStartTime);
        if (plan.remainingMilliseconds !== null) {
          console.log('[Spectra AutoStart] Remaining time: ' + formatRemaining(plan.remainingMilliseconds));
          if (plan.remainingMilliseconds === 0) {
            console.log('[Spectra AutoStart] Saved timer expired; VenusBot will perform the normal phase transition');
          }
        }
      } else {
        console.log('[Spectra AutoStart] No valid saved cycle');
        console.log('[Spectra AutoStart] Initializing phase: requests');
        console.log('[Spectra AutoStart] Reason: ' + plan.reason);
      }

      chrome.storage.local.set(plan.updates, () => {
        activationInFlight = false;
        if (chrome.runtime.lastError) {
          sessionStorage.removeItem(INIT_MARKER);
          console.warn('[Spectra AutoStart] Start command failed:', chrome.runtime.lastError);
          return;
        }
        sessionStorage.setItem(COMMAND_MARKER, '1');
        console.log('[Spectra AutoStart] Start command sent once');
        if (window.location.href === plan.targetUrl) {
          window.location.reload();
        } else {
          window.location.href = plan.targetUrl;
        }
      });
    });
  };

  logHeader();
  if (sessionStorage.getItem(COMMAND_MARKER) === '1') {
    waitForConfirmation();
    return;
  }

  const deadline = Date.now() + 60000;
  const startupTabsMarkerDeadline = Date.now() + 5000;
  const navigationFallbackDeadline = Date.now() + 15000;
  const REQUESTS_URL = 'https://x.com/i/chat/requests';
  let requestsNavigationSent = false;
  const isXHost = () => {
    const host = window.location.hostname.toLowerCase().replace('www.', '');
    return host === 'x.com' || host === 'twitter.com';
  };
  const waitForReadyRequestsTab = () => {
    try {
      if (!isRequestsPage()) {
        // Ne jamais abandonner en silence ici. X redirige parfois la page
        // Requests vers /home ou vers un ecran de verification juste apres le
        // lancement : l'ancien "return" laissait alors VenusBot a l'arret sans
        // aucun message, et il fallait relancer le profil a la main.
        if (Date.now() >= deadline) {
          sessionStorage.removeItem(INIT_MARKER);
          console.warn(
            '[Spectra AutoStart] Giving up: Requests page never reached (last path: ' +
              window.location.pathname + ')'
          );
          return;
        }
        if (!requestsNavigationSent && Date.now() > navigationFallbackDeadline && isXHost()) {
          requestsNavigationSent = true;
          console.warn(
            '[Spectra AutoStart] Unexpected page (' + window.location.pathname +
              '), navigating back to Requests once'
          );
          window.location.href = REQUESTS_URL;
          return;
        }
        window.setTimeout(waitForReadyRequestsTab, 500);
        return;
      }
      // The cookie-sync worker stores the retained Chrome tab ID as the marker
      // value. Presence means the single-tab bootstrap has completed. Do not
      // let a delayed MV3 worker prevent VenusBot from starting indefinitely:
      // Open Selected already launches Requests as its only native tab.
      if (!sessionStorage.getItem(READY_MARKER)) {
        if (Date.now() < startupTabsMarkerDeadline) {
          window.setTimeout(waitForReadyRequestsTab, 250);
          return;
        }
        console.warn('[Spectra AutoStart] Single-tab marker delayed; using Requests fallback');
      }
      const authenticatedUi = document.querySelector(
        [
          '[data-testid="AppTabBar_Home_Link"]',
          '[data-testid="SideNav_AccountSwitcher_Button"]',
          '[data-testid="primaryColumn"]',
          '[data-testid="AppTabBar_DirectMessage_Link"]',
          'nav[role="navigation"] a[href="/home"]',
        ].join(', ')
      );
      const loginUi = document.querySelector(
        [
          'input[autocomplete="username"]',
          'input[autocomplete="current-password"]',
          '[data-testid="loginButton"]',
        ].join(', ')
      );
      const completedXApp = document.readyState === 'complete' &&
        Boolean(document.querySelector('#react-root, main[role="main"], #layers'));
      if (!loginUi && (authenticatedUi || completedXApp)) {
        console.log(
          authenticatedUi
            ? '[Spectra AutoStart] Authenticated X interface detected'
            : '[Spectra AutoStart] X application ready in compact layout'
        );
        activate();
        return;
      }
      if (Date.now() < deadline) {
        window.setTimeout(waitForReadyRequestsTab, 500);
      } else {
        sessionStorage.removeItem(INIT_MARKER);
        console.warn('[Spectra AutoStart] Requests page did not become ready before timeout');
      }
    } catch (error) {
      console.warn('[Spectra AutoStart] Initialization failed:', error);
    }
  };

  waitForReadyRequestsTab();
})();
`;
      if (enabled && (!fs.existsSync(autostartPath) || fs.readFileSync(autostartPath, 'utf8') !== autostartScript)) {
        fs.writeFileSync(autostartPath, autostartScript);
      }

      // --- Modele de reglages du robot -------------------------------------
      //
      // Ce script vit dans le dossier de l'extension du robot : il partage donc
      // son stockage, seul endroit d'ou ses reglages sont lisibles. Une
      // instance modele les publie, les autres les recoivent.
      const modeleFile = 'spectra-bot-template.js';
      const modelePath = path.join(extensionPath, modeleFile);
      const role = launchContext.roleModeleBot || null;
      const dossierModele = launchContext.dossierModeleBot || '';
      let modeleAEcrire = '';

      if (role === 'copie' && dossierModele) {
        const source = this.cheminModeleBot(dossierModele);
        if (fs.existsSync(source)) {
          try {
            modeleAEcrire = fs.readFileSync(source, 'utf8');
          } catch {}
        }
      }

      if (role) {
        const modeleScript = `
(function () {
  const ROLE = ${JSON.stringify(role)};
  const PROFILE_ID = ${JSON.stringify(launchContext.profileId)};
  const DOSSIER = ${JSON.stringify(dossierModele)};
  const SERVER = 'http://127.0.0.1:${this.localServerConfig?.port || 0}';
  const SERVER_TOKEN = ${JSON.stringify(this.localServerConfig?.token || '')};
  const CLES_PROPRES = ${JSON.stringify(this.CLES_PROPRES_AU_COMPTE)};
  const MODELE = ${modeleAEcrire ? modeleAEcrire : 'null'};
  const MARQUEUR = 'spectra:modele-bot:' + PROFILE_ID;

  const envoyer = (chemin, corps) => fetch(SERVER + chemin, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SERVER_TOKEN },
    body: JSON.stringify(corps),
  }).catch(() => {});

  // Une seule fois par ouverture : le script est injecte dans chaque page.
  if (sessionStorage.getItem(MARQUEUR) === '1') return;
  sessionStorage.setItem(MARQUEUR, '1');

  if (ROLE === 'modele') {
    // Publier : on lit tout, on retire ce qui appartient au compte.
    chrome.storage.local.get(null, (tout) => {
      if (chrome.runtime.lastError || !tout) return;
      const reglages = {};
      for (const [cle, valeur] of Object.entries(tout)) {
        if (CLES_PROPRES.includes(cle)) continue;
        reglages[cle] = valeur;
      }
      envoyer('/api/bot-template', { dossierId: DOSSIER, profileId: PROFILE_ID, reglages });
      console.log('[Spectra Modele] ' + Object.keys(reglages).length + ' reglages publies');
    });
    return;
  }

  if (ROLE === 'copie' && MODELE && MODELE.reglages) {
    // Recevoir : on n'ecrase que ce qui vient du modele, et jamais l'identite.
    const aEcrire = {};
    for (const [cle, valeur] of Object.entries(MODELE.reglages)) {
      if (CLES_PROPRES.includes(cle)) continue;
      aEcrire[cle] = valeur;
    }
    chrome.storage.local.set(aEcrire, () => {
      if (chrome.runtime.lastError) {
        console.warn('[Spectra Modele] Ecriture refusee:', chrome.runtime.lastError);
        return;
      }
      console.log('[Spectra Modele] ' + Object.keys(aEcrire).length + ' reglages appliques');
      envoyer('/api/bot-template-applied', {
        profileId: PROFILE_ID,
        empreinte: MODELE.empreinte || '',
      });
    });
  }
})();
`;
        fs.writeFileSync(modelePath, modeleScript);
      } else if (fs.existsSync(modelePath)) {
        fs.rmSync(modelePath, { force: true });
      }

      const matches = [
        'https://x.com/*',
        'https://twitter.com/*',
      ];
      const alreadyRegistered = contentScripts.some((script: any) =>
        Array.isArray(script.js) && script.js.includes(autostartFile)
      );

      if (enabled && !alreadyRegistered) {
        manifest.content_scripts = [
          { matches, js: [autostartFile], run_at: 'document_start' },
          ...contentScripts,
        ];
      } else if (!enabled && alreadyRegistered) {
        manifest.content_scripts = contentScripts.filter((script: any) =>
          !(Array.isArray(script.js) && script.js.includes(autostartFile))
        );
      }
      const registeredContentScripts = Array.isArray(manifest.content_scripts)
        ? manifest.content_scripts
        : [];
      for (const script of registeredContentScripts) {
        if (!Array.isArray(script.js) || !script.js.includes('content.js')) continue;
        if (!script.js.includes(autoPostBridgeFile)) script.js.push(autoPostBridgeFile);
      }
      // Le script du modele suit le meme chemin que le pont Auto Post : il doit
      // tourner dans le contexte de l'extension du robot, pas dans la page.
      for (const script of registeredContentScripts) {
        if (!Array.isArray(script.js) || !script.js.includes('content.js')) continue;
        const present = script.js.includes(modeleFile);
        if (role && !present) script.js.push(modeleFile);
        if (!role && present) script.js = script.js.filter((nom: string) => nom !== modeleFile);
      }
      const autostartRegistered = registeredContentScripts.some((script: any) =>
        Array.isArray(script.js) && script.js.includes(autostartFile)
      );
      if (enabled !== autostartRegistered) {
        console.error('[Spectra AutoStart] VenusBot manifest registration failed');
        return false;
      }
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      return true;
    } catch (error) {
      console.error('[Extensions] Failed to prepare Twitter Auto Reply autostart:', error);
      return false;
    }
  }

  private static getExtensionName(extensionPath: string): string | null {
    const manifestPath = path.join(extensionPath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return null;

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      return typeof manifest.name === 'string' ? manifest.name : null;
    } catch {
      return null;
    }
  }

  private static isTwitterAutoReplyManifest(manifest: any): boolean {
    const name = typeof manifest?.name === 'string'
      ? manifest.name.trim().toLowerCase()
      : '';

    return name.includes('twitter auto reply dm');
  }

  private static findTwitterAutoReplyExtensionPath(): string | null {
    const extensionRoots = [
      path.join(os.homedir(), '.antidetect-browser', 'extensions'),
      path.join(os.homedir(), 'AppData', 'Local', 'AntidetectBrowser', 'Extensions'),
    ];

    for (const root of extensionRoots) {
      if (!fs.existsSync(root)) continue;
      try {
        const matches = fs.readdirSync(root)
          .map(name => path.join(root, name))
          .filter(extPath => {
            const manifestPath = path.join(extPath, 'manifest.json');
            if (!fs.existsSync(manifestPath)) return false;
            try {
              const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
              return this.isTwitterAutoReplyManifest(manifest);
            } catch {
              return false;
            }
          })
          .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        if (matches[0]) return matches[0];
      } catch {}
    }

    return null;
  }

  private static createRuntimeExtensionCopy(runtimeRoot: string, sourcePath: string, index: number): string {
    const sourceName = path.basename(sourcePath).replace(/[^A-Za-z0-9_-]/g, '_');
    const destination = path.join(runtimeRoot, `${index}-${sourceName}`);
    fs.cpSync(sourcePath, destination, { recursive: true, force: true });
    return destination;
  }

  private static getChromeExtensionId(runtimePath: string): string | null {
    const manifestPath = path.join(runtimePath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return null;

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (typeof manifest.key !== 'string' || !manifest.key.trim()) return null;
      const digest = crypto
        .createHash('sha256')
        .update(Buffer.from(manifest.key, 'base64'))
        .digest()
        .subarray(0, 16);
      return Array.from(digest)
        .map((byte) =>
          String.fromCharCode(97 + (byte >> 4)) +
          String.fromCharCode(97 + (byte & 15))
        )
        .join('');
    } catch (error) {
      console.warn('[Extensions] Could not derive extension ID:', error);
      return null;
    }
  }

  private static enforceWindowPlacement(pid: number | undefined, placement: ReturnType<typeof PuppeteerLauncher.getWindowPlacement>) {
    if (!pid || process.platform !== 'win32') return;

    const ps = `
      Start-Sleep -Milliseconds 900
      Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}
"@
      $p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
      if ($p) {
        $deadline = (Get-Date).AddSeconds(5)
        while ($p.MainWindowHandle -eq 0 -and (Get-Date) -lt $deadline) {
          Start-Sleep -Milliseconds 150
          $p.Refresh()
        }
        if ($p.MainWindowHandle -ne 0) {
          for ($attempt = 0; $attempt -lt 3; $attempt++) {
            [Win32]::SetWindowPos($p.MainWindowHandle, [IntPtr]::Zero, ${placement.left}, ${placement.top}, ${placement.width}, ${placement.height}, 0x0040) | Out-Null
            Start-Sleep -Milliseconds 250
            $p.Refresh()
          }
        }
      }
    `;

    spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  }

  /**
   * Poser l'identite du profil dans le moteur plutot qu'en JavaScript a ete
   * tente le 11 aout 2026, via le protocole de pilotage de Chrome, puis retire
   * le meme jour. Deux raisons, pour que personne ne recommence :
   *
   *   1. Ces substitutions appartiennent a la session qui les pose. Des que le
   *      client se detache, Chrome restaure ses valeurs d'origine. C'est le
   *      comportement visible quand on ferme les outils de developpement apres
   *      avoir simule un telephone : la simulation disparait avec eux. Poser
   *      l'identite puis se deconnecter ne laissait donc rien derriere.
   *   2. Les maintenir aurait demande de garder un client attache en
   *      permanence, donc un port de pilotage ouvert en continu. Ce lanceur
   *      s'en passe volontairement -- voir plus bas "SPAWN Chrome — no
   *      Puppeteer, no CDP, no debug port". Un client attache active le domaine
   *      Runtime, qu'une page sait detecter : on echangerait une incoherence
   *      contre un marqueur franc.
   *
   * L'identite reste donc posee par l'extension propre a chaque profil :
   * en-tetes par declarativeNetRequest, surface JavaScript par fingerprint.js.
   * Les tests de tests/empreinte.test.js verifient que les deux racontent la
   * meme histoire.
   */

  private static async spawnChromeAndVerify(
    chromePath: string,
    args: string[],
    env: Record<string, string | undefined>,
    profilePath: string
  ): Promise<ChildProcess> {
    const chromeProcess = await new Promise<ChildProcess>((resolve, reject) => {
      const chromeProcess = spawn(chromePath, args, {
        detached: false,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: env as any,
      });

      let settled = false;
      let stderr = '';
      let startupTimer: NodeJS.Timeout;
      const onStderr = (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-4000);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(startupTimer);
        chromeProcess.removeListener('error', onError);
        chromeProcess.removeListener('exit', onEarlyExit);
        chromeProcess.stderr?.removeListener('data', onStderr);
        if (error) reject(error);
        else resolve(chromeProcess);
      };
      const onError = (error: Error) => finish(new Error(`Chrome could not start: ${error.message}`));
      const onEarlyExit = (code: number | null, signal: NodeJS.Signals | null) => {
        const detail = stderr.trim().replace(/\s+/g, ' ').slice(-500);
        finish(new Error(`Chrome closed during startup (code ${code ?? 'unknown'}${signal ? `, signal ${signal}` : ''})${detail ? `: ${detail}` : ''}`));
      };
      startupTimer = setTimeout(() => finish(), 1500);

      chromeProcess.stderr?.on('data', onStderr);
      chromeProcess.once('error', onError);
      chromeProcess.once('exit', onEarlyExit);
    });

    if (process.platform === 'win32') {
      try {
        const handle = await this.waitForVisibleWindow(
          profilePath,
          12000,
          chromeProcess.pid
        );
        if (!handle) throw new Error('no visible window');
      } catch (error: any) {
        try { chromeProcess.kill(); } catch {}
        throw new Error(`Chrome started but no visible window appeared: ${error.message}`);
      }
    }

    return chromeProcess;
  }

  /**
   * Clean Chrome-internal state from a profile directory to fix version incompatibility.
   */
  private static cleanProfileState(profilePath: string) {
    const keepFiles = new Set([
      'pending_cookies.json', 'synced_cookies.json', 'authenticated_cookies.json',
      'fingerprint_override.json', 'open_tabs.json',
      'last_url.txt', '__proxy_auth_ext', '__brand_fix_ext',
      '__cookie_sync_ext', '__platform_fix_ext', '__startup_tab_cleaner_ext',
    ]);
    try {
      const entries = fs.readdirSync(profilePath);
      for (const entry of entries) {
        if (keepFiles.has(entry)) continue;
        const fullPath = path.join(profilePath, entry);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            fs.rmSync(fullPath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(fullPath);
          }
        } catch {}
      }
      console.log(`[Profile] Cleaned incompatible Chrome state from ${profilePath}`);
    } catch (e: any) {
      console.error(`[Profile] Error cleaning profile state:`, e.message);
    }
  }

  static async launch(options: PuppeteerLaunchOptions) {
    let autoStartLaunchId = '';
    try {
      this.assertSafeId(options.profileId, 'profile ID');
      this.cancelledProfiles.delete(options.profileId);
      const targetTweetUrl = options.targetTweetUrl
        ? normalizeTweetUrl(options.targetTweetUrl)
        : null;
      if (options.targetTweetUrl && !targetTweetUrl) {
        throw new Error('Invalid X post URL');
      }
      const sessionImportAttemptId = options.sessionImport?.attemptId || '';
      if (sessionImportAttemptId && !/^[A-Fa-f0-9-]{16,64}$/.test(sessionImportAttemptId)) {
        throw new Error('Invalid session import attempt');
      }
      const launchMode = resolveLaunchMode({
        launchMode: options.launchMode,
        sessionImportAttemptId,
        targetTweetUrl,
        autoStartTwitterBot: options.autoStartTwitterBot,
        publication: Boolean(options.massPost || options.branding),
      });
      const managedLaunch = isManagedLaunch(launchMode);

      // Get user data directory path
      const userDataDir = process.platform === 'win32'
        ? path.join(os.homedir(), 'AppData', 'Local', 'AntidetectBrowser', 'Profiles')
        : path.join(os.homedir(), '.antidetect-browser', 'profiles');

      const profilePath = path.join(userDataDir, options.profileId);
      if (!fs.existsSync(profilePath)) {
        fs.mkdirSync(profilePath, { recursive: true });
      }
      this.appendLifecycleEvent(options.profileId, 'launch-requested', {
        launchMode,
        autoStartTwitterBot: options.autoStartTwitterBot === true,
        hasTargetTweet: Boolean(targetTweetUrl),
        hasSessionImport: sessionImportAttemptId.length > 0,
      });

      // Chrome garde son propre cache du service worker de l'extension dans
      // le profil, et le reutilise au lancement suivant -- avec l'adresse du
      // tour precedent inscrite dedans. Mesure du 18 aout 2026 : background.js
      // sur le disque visait bien le tweet du jour, et l'onglet s'ouvrait sur
      // celui d'avant. Le bot cherchait alors un tweet absent de la page.
      //
      // On efface donc ce cache avant chaque tour, sans attendre deux echecs.
      // Les cookies sont ailleurs (DefaultNetworkCookies) et ne bougent
      // pas : la session est preservee. Une instance ainsi remise a neuf
      // retweete en 9 a 11 s, comme une saine.
      //
      // Une publication court exactement le meme risque, et elle etait hors
      // du compte : son script est refabrique a chaque tour avec un autre
      // texte et une autre image. Le 23 aout 2026, douze instances du VPS 128
      // sont restees sur la page blanche a 15:38 puis a 17:28 -- les douze
      // memes, pendant que treize autres publiaient dans la meme minute. Leur
      // service worker n'a jamais dit un mot ; leur magasin pesait jusqu'a
      // 570 Mo, contre 0,1 a 0,8 Mo pour une instance saine. L'effacer les a
      // remises en marche. Le bot de RT ne l'avait jamais montre : lui passe
      // par cette ligne depuis le 18 aout.
      if (targetTweetUrl || options.massPost || options.branding) {
        this.viderCacheServiceWorker(options.profileId, profilePath);
      }
      this.desactiverGestionnaireMotsDePasse(profilePath);

      const existingProfileProcesses = await this.getProfileProcessIds(profilePath);
      if (existingProfileProcesses.length > 0) {
        let visibleWindowExists = process.platform !== 'win32';
        if (process.platform === 'win32') {
          try {
            visibleWindowExists = Boolean(await this.waitForVisibleWindow(profilePath, 1500));
          } catch {
            visibleWindowExists = false;
          }
        }

        if (visibleWindowExists) {
          this.focusProfileWindow(options.profileId);
          return { success: false, error: 'Profile already running', alreadyRunning: true };
        }

        console.warn(
          `[Chrome] Found ${existingProfileProcesses.length} stale process(es) without a visible window for ${options.profileId}`
        );
        await this.terminateProfileProcesses(profilePath);
        this.activeProfiles.delete(options.profileId);
      }
      this.clearStaleSingletonFiles(profilePath);

      // Prepare Default directory and Preferences
      const defaultDir = path.join(profilePath, 'Default');
      if (!fs.existsSync(defaultDir)) {
        fs.mkdirSync(defaultDir, { recursive: true });
      }
      const prefsPath = path.join(defaultDir, 'Preferences');
      let prefs: any = {};
      if (fs.existsSync(prefsPath)) {
        try { prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8')); } catch {}
      }
      const placement = this.getWindowPlacement(
        options.windowLayout, launchMode, Boolean(options.branding || options.massPost)
      );
      const hasRestorableSession = this.hasChromeSessionRestore(profilePath);
      let manualPlacementCorrection: ReturnType<typeof fitWindowToWorkArea> = null;
      if (managedLaunch) {
        this.applyCleanLaunchState(profilePath, prefs);
        this.clearChromeSessionRestore(profilePath);
        // The tile is applied for THIS session only, via --window-size and
        // --window-position further down. It is deliberately NOT written into
        // the profile's Preferences: doing so overwrote the user's own window
        // geometry permanently, so a later manual open restored a 900x720 tile
        // in a corner instead of the window as they had left it.
      } else {
        // A normal launch must retain Chrome's tabs and the user's own window
        // placement. OpenPost and other managed workflows stay deterministic.
        this.applyManualLaunchState(profilePath, prefs);
        const storedPlacement = prefs.browser?.window_placement;
        if (storedPlacement) {
          manualPlacementCorrection = fitWindowToWorkArea(
            {
              left: Number(storedPlacement.left),
              top: Number(storedPlacement.top),
              right: Number(storedPlacement.right),
              bottom: Number(storedPlacement.bottom),
            },
            placement.workArea
          );
          if (manualPlacementCorrection) {
            prefs.browser = {
              ...(prefs.browser || {}),
              window_placement: {
                ...storedPlacement,
                ...manualPlacementCorrection,
                // Preserve the profile's own maximized state: forcing false
                // meant a window could never reopen maximized.
                maximized: storedPlacement.maximized === true,
                work_area_left: placement.workArea.x,
                work_area_top: placement.workArea.y,
                work_area_right: placement.workArea.x + placement.workArea.width,
                work_area_bottom: placement.workArea.y + placement.workArea.height,
              },
            };
            console.log('[Chrome] Manual window fitted to the active display');
          }
        }
      }
      // Enable developer mode for extensions loading
      if (!prefs.extensions) prefs.extensions = {};
      prefs.extensions.developer_mode = true;
      // Suppress "disable developer mode extensions" dialog
      if (!prefs.extensions.alerts) prefs.extensions.alerts = {};
      prefs.extensions.alerts.initialized = true;
      fs.writeFileSync(prefsPath, JSON.stringify(prefs));

      // Proxy config
      let proxy: any = null;
      if (options.proxy?.host) {
        proxy = options.proxy;
      }

      const cacheDir = path.join(profilePath, 'Cache');
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }

      // Get Chrome for Testing (supports --load-extension for unpacked extensions)
      let chromePath: string;
      try {
        chromePath = await this.downloadChromeForTesting();
      } catch (downloadError: any) {
        // Stable Google Chrome refuses --load-extension ("--load-extension is not allowed
        // in Google Chrome, ignoring"), so falling back to it would start the profile with
        // the entire fingerprint runtime silently dropped: user agent, platform, client
        // hints, WebGL and canvas. An unprotected launch is worse than no launch, so this
        // now fails loudly instead of degrading without telling anyone.
        throw new Error(
          `Managed browser unavailable: ${downloadError.message}. `
          + 'System Chrome cannot replace it because it ignores --load-extension, which '
          + 'would disable fingerprint protection for this profile.'
        );
      }

      // Build Chrome args — MINIMAL flags only
      const compactWindowSize = `${placement.width},${placement.height}`;
      const compactWindowPosition = `${placement.left},${placement.top}`;
      const browserVersion = await this.getBrowserVersion(chromePath);
      let effectiveFingerprint = { ...(options.fingerprint || {}) };
      const fingerprintOverridePath = path.join(profilePath, 'fingerprint_override.json');
      if (fs.existsSync(fingerprintOverridePath)) {
        try {
          const stat = fs.statSync(fingerprintOverridePath);
          if (stat.size > 64 * 1024) throw new Error('override is too large');
          const override = JSON.parse(fs.readFileSync(fingerprintOverridePath, 'utf8'));
          if (!override || typeof override !== 'object' || Array.isArray(override)) {
            throw new Error('override must be an object');
          }
          effectiveFingerprint = { ...effectiveFingerprint, ...override };
          console.log(`[Fingerprint] Applied profile override for ${options.profileId}`);
        } catch (error: any) {
          console.warn(`[Fingerprint] Invalid profile override ignored: ${error.message}`);
        }
      }
      // AdsPower-style "Based on IP": resolve the real proxy exit before Chrome gets
      // its first page, then align every geographical browser signal atomically.
      if (proxy?.host) {
        const liveGeo = await ProxyManager.getInstance().inspectProxyGeo(proxy);
        if (liveGeo) {
          effectiveFingerprint = this.alignFingerprintWithProxyGeo(effectiveFingerprint, liveGeo);
          fs.writeFileSync(
            path.join(profilePath, 'proxy_runtime_geo.json'),
            JSON.stringify(liveGeo, null, 2),
            'utf8'
          );
          console.log(
            `[Fingerprint] Based on IP: ${liveGeo.countryCode} · ${liveGeo.city} · ${liveGeo.timezone}`
          );
        } else if (proxy.timezone && typeof proxy.timezone === 'string') {
          try {
            new Intl.DateTimeFormat('en-US', { timeZone: proxy.timezone }).format(new Date());
            effectiveFingerprint.timezone = proxy.timezone;
            console.log(`[Fingerprint] Live geo unavailable; using saved proxy timezone: ${proxy.timezone}`);
          } catch {
            console.warn(`[Fingerprint] Invalid saved proxy timezone ignored: ${proxy.timezone}`);
          }
        } else {
          console.warn('[Fingerprint] Live proxy geo unavailable; preserving stored fingerprint geo');
        }
      }
      const configuredUserAgent = options.userAgent || effectiveFingerprint.userAgent || '';
      const userAgent = this.alignUserAgentToBrowser(configuredUserAgent, browserVersion);
      console.log(`[Browser] Executable version: ${browserVersion || 'unknown'}`);
      const args = [
        `--user-data-dir=${profilePath}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-infobars',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        `--lang=${effectiveFingerprint.language || effectiveFingerprint.languages?.[0] || 'en-US'}`,
        // BackForwardCache : Chrome garde chaque page quittee entierement vivante
        // en memoire pour rendre le bouton Retour instantane, et ne les jette que
        // sous pression memoire. Sur un VPS avec 114 Go libres cette pression
        // n'arrive jamais : le 9 aout 2026 les pages s'empilaient jusqu'a ce que
        // l'onglet atteigne 5 Go et meure en "Aw Snap, out of memory". VenusBot
        // navigue en permanence entre Requests et les conversations, et n'utilise
        // jamais le bouton Retour : ce cache ne lui sert a rien.
        // Une seule option --disable-features est prise en compte, d'ou la fusion.
        '--disable-features=CalculateNativeWinOcclusion,BackForwardCache',
        // Un serveur sans carte graphique n'a pas de WebGL du tout : mesure du
        // 11 aout 2026, "Canvas has no webgl context", alors que l'empreinte
        // annonce une Intel UHD. Une carte declaree mais inutilisable est plus
        // suspecte qu'une absence.
        //
        // Ce drapeau autorise le repli logiciel quand aucune carte n'est
        // disponible ; il ne l'impose pas. On avait d'abord ajoute
        // --use-angle=swiftshader, qui force le rendu logiciel partout : sur un
        // poste equipe d'une vraie carte, cela produit la signature des machines
        // virtuelles et des navigateurs sans ecran, soit l'inverse du but
        // recherche. Chrome bascule seul sur SwiftShader lorsque le materiel
        // manque, ce qui couvre le VPS sans penaliser le poste de travail.
        '--enable-unsafe-swiftshader',
        // La poignee de main TLS est la premiere chose qu'un serveur voit, avant
        // tout en-tete et tout JavaScript. Chrome for Testing active par defaut
        // sa configuration d'essais integree, qui allume deux extensions TLS
        // experimentales (0x12E0 et 0xCA34). Le Chrome stable recoit sa
        // configuration depuis les serveurs de Google, qui les laissent
        // eteintes. Resultat : 18 extensions au lieu de 16, une signature
        // qu'aucun navigateur reel n'envoie.
        //
        // Mesure du 11 aout 2026 sur tls.browserleaks.com, meme machine :
        //   Chrome stable 151      t13d1516h2_8daaf6152771_806a8c22fdea
        //   Spectra sans ce drapeau t13d1518h2_8daaf6152771_4980c97edce0
        //   Spectra avec ce drapeau t13d1516h2_8daaf6152771_806a8c22fdea
        //
        // C'est ce qui faisait repondre a X "We've temporarily limited your
        // login" sur chaque compte : le refus tombait avant l'empreinte, avant
        // les en-tetes, avant les extensions. Les retirer tous ne changeait rien.
        '--disable-field-trial-config',
      ];
      if (managedLaunch) {
        args.push(`--window-size=${compactWindowSize}`);
        args.push(`--window-position=${compactWindowPosition}`);
      } else if (manualPlacementCorrection) {
        args.push(
          `--window-size=${manualPlacementCorrection.right - manualPlacementCorrection.left},` +
          `${manualPlacementCorrection.bottom - manualPlacementCorrection.top}`
        );
        args.push(
          `--window-position=${manualPlacementCorrection.left},${manualPlacementCorrection.top}`
        );
      }
      // Force User-Agent to match fingerprint (consistent across Mac/Windows)
      if (userAgent) {
        args.push(`--user-agent=${userAgent}`);
        console.log(`[UA] Forced: ${userAgent.substring(0, 80)}...`);
      }

      // WebRTC leak protection when using proxy
      if (proxy && proxy.host) {
        args.push('--webrtc-ip-handling-policy=disable_non_proxied_udp');
        args.push('--enforce-webrtc-ip-permission-check');
      }

      // Proxy — local relay server handles auth transparently
      let localProxyServer: http.Server | null = null;
      if (proxy && proxy.host) {
        const proxyType = (proxy.type || 'http').toLowerCase();

        if (proxy.username && proxy.password && (proxyType === 'http' || proxyType === 'https')) {
          // Spawn a local proxy that relays to remote proxy with auth
          const localProxy = await this.createLocalProxy(proxy);
          localProxyServer = localProxy.server;
          args.push(`--proxy-server=http://127.0.0.1:${localProxy.port}`);
          console.log(`[Proxy] Local relay on port ${localProxy.port} → ${proxy.host}:${proxy.port}`);
        } else if (proxyType === 'socks5' || proxyType === 'socks4') {
          args.push(`--proxy-server=${proxyType}://${proxy.host}:${proxy.port}`);
        } else {
          args.push(`--proxy-server=http://${proxy.host}:${proxy.port}`);
        }
      }

      // Apply the stored fingerprint before page scripts execute.
      let platformFixPath: string | null = null;
      if (userAgent) {
        const isWindows = userAgent.includes('Windows');
        const isMac = userAgent.includes('Macintosh');
        const platform = isWindows ? 'Win32' : isMac ? 'MacIntel' : 'Linux x86_64';
        // Client Hints travel as HTTP headers built from the real OS, so --user-agent
        // alone leaves them contradicting the fingerprint when a profile moves machines.
        const clientHintsPlatform = isWindows ? 'Windows' : isMac ? 'macOS' : 'Linux';

        platformFixPath = path.join(profilePath, '__platform_fix_ext');
        if (fs.existsSync(platformFixPath)) {
          fs.rmSync(platformFixPath, { recursive: true, force: true });
        }
        fs.mkdirSync(platformFixPath, { recursive: true });

        fs.writeFileSync(path.join(platformFixPath, 'manifest.json'), JSON.stringify({
          manifest_version: 3,
          name: 'Spectra Fingerprint Runtime',
          version: '2.2',
          permissions: ['declarativeNetRequest'],
          host_permissions: ['<all_urls>'],
          declarative_net_request: {
            rule_resources: [
              {
                id: 'spectra_client_hints',
                enabled: true,
                path: 'client-hints-rules.json',
              },
            ],
          },
          content_scripts: [
            {
              matches: ['<all_urls>'],
              js: ['fingerprint.js'],
              run_at: 'document_start',
              all_frames: true,
              world: 'MAIN',
            },
            ...(managedLaunch ? [{
              matches: [
                'https://x.com/*',
                'https://www.x.com/*',
                'https://twitter.com/*',
                'https://www.twitter.com/*',
              ],
              js: ['x-cookie-consent.js'],
              run_at: 'document_idle',
            }] : []),
          ],
        }));

        fs.writeFileSync(
          path.join(platformFixPath, 'client-hints-rules.json'),
          JSON.stringify(
            this.buildClientHintsRules(
              clientHintsPlatform,
              this.buildAcceptLanguage(effectiveFingerprint),
              browserVersion
            ),
            null,
            2
          )
        );

        const architecture = effectiveFingerprint.architecture
          || (isMac && /Apple M\d/i.test(effectiveFingerprint.webglRenderer || '') ? 'arm' : 'x86');
        const majorVersion = /^\d+/.exec(browserVersion)?.[0] || '151';
        // Meme liste que dans l'en-tete sec-ch-ua : JavaScript et reseau doivent
        // raconter la meme histoire, et la bonne.
        const brands = PuppeteerLauncher.chromeBrandList(majorVersion);
        // Chrome sous Windows renvoie toujours 24, quelle que soit la dalle.
        // Le generateur donnait 30 aux ecrans 4K, valeur qu'aucun Windows ne
        // produit. Force ici pour corriger aussi les profils deja crees.
        const fp = {
          ...effectiveFingerprint,
          userAgent,
          platform,
          architecture,
          brands,
          colorDepth: 24,
          pixelDepth: 24,
        };
        fs.writeFileSync(path.join(platformFixPath, 'fingerprint.js'), `
(() => {
  const fp = ${JSON.stringify(fp)};
  // Les proprietes masquees doivent aussi mentir sur leur propre nature.
  // Mesure du 11 aout 2026 :
  //   Chrome reel : Object.getOwnPropertyDescriptor(Navigator.prototype,'platform').get.toString()
  //                 -> "function get platform() { [native code] }"
  //   Spectra     -> "() => value"
  // Huit proprietes se denoncaient ainsi. Ce n'est plus une empreinte suspecte,
  // c'est la preuve en clair que l'empreinte est truquee, lisible en une ligne.
  const masques = new WeakMap();
  // Le deguisement de Function.prototype.toString a ete retire le 15 aout
  // 2026. Il touchait un point d'entree global du langage -- la modification
  // la plus voyante du script -- et ne servait qu'a masquer les substitutions
  // d'identite, elles-memes retirees. Le bruit (canvas, WebGL, audio) s'en
  // passe : mesure du 12 aout, il passe sans ce masquage.
  const commeNatif = (fonction, nom) => {
    try { Object.defineProperty(fonction, 'name', { value: nom, configurable: true }); } catch {}
    masques.set(fonction, 'function ' + nom + '() { [native code] }');
    return fonction;
  };

  const define = (target, property, value) => {
    if (value === undefined || value === null) return;
    try {
      const getter = commeNatif(function () { return value; }, 'get ' + property);
      Object.defineProperty(target, property, { configurable: true, get: getter });
    } catch {}
  };

  // ---- substitutions d'identite : retirees le 15 aout 2026 ------------------
  //
  // Plateforme, langues, marques, donnees de haute entropie : ces reecritures
  // existaient pour rattraper Chrome for Testing, qui annoncait "Chromium" et
  // la plateforme de la machine hote. Le navigateur compile pour Spectra
  // annonce deja les bonnes valeurs, nativement.
  //
  // Elles etaient surtout la cause du refus de connexion. Bisection du 12 aout
  // 2026, meme compte verifie dans un Chrome installe juste avant chaque essai :
  //   rien                                        passe
  //   en-tetes seuls                              passe
  //   bruit seul (canvas, WebGL, audio, ecran)    passe
  //   fuseau seul                                 passe
  //   fuseau + ce bloc                            REFUSE
  //   tout                                        REFUSE
  //
  // Eteintes depuis, elles ne se rallumaient plus que par un fichier temoin de
  // diagnostic, lui-meme retire. Le code exact est dans l'historique git, au
  // commit qui precede cette suppression -- a reprendre le jour ou un profil
  // Windows devra tourner sur un hote macOS.

  // ---- l'heure, a part -----------------------------------------------------
  // Chromium does not honour the TZ child-process environment consistently on
  // Windows. Keep Date and Intl aligned with the profile on every host.
  if (fp.timezone && typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
    try {
      const targetTimezone = fp.timezone;
      const NativeDateTimeFormat = Intl.DateTimeFormat;
      // Validate the IANA identifier before installing any overrides.
      new NativeDateTimeFormat('en-US', { timeZone: targetTimezone }).format(new Date());

      const withTimezone = (options) => {
        if (options && Object.prototype.hasOwnProperty.call(options, 'timeZone')) return options;
        return Object.assign({}, options || {}, { timeZone: targetTimezone });
      };
      const DateTimeFormatProxy = new Proxy(NativeDateTimeFormat, {
        apply(target, thisArg, args) {
          return Reflect.apply(target, thisArg, [args[0], withTimezone(args[1])]);
        },
        construct(target, args, newTarget) {
          return Reflect.construct(target, [args[0], withTimezone(args[1])], newTarget);
        },
      });
      Object.defineProperty(Intl, 'DateTimeFormat', {
        configurable: true,
        writable: true,
        value: DateTimeFormatProxy,
      });

      const offsetFormatter = new NativeDateTimeFormat('en-US', {
        timeZone: targetTimezone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hourCycle: 'h23',
      });
      const offsetFor = (date) => {
        if (!(date instanceof Date) || Number.isNaN(date.getTime())) return NaN;
        const parts = Object.create(null);
        for (const part of offsetFormatter.formatToParts(date)) {
          if (part.type !== 'literal') parts[part.type] = Number(part.value);
        }
        const localAsUtc = Date.UTC(
          parts.year, parts.month - 1, parts.day,
          parts.hour === 24 ? 0 : parts.hour, parts.minute, parts.second
        );
        return Math.round((date.getTime() - localAsUtc) / 60000);
      };
      const poser = (nom, fn) => {
        Object.defineProperty(Date.prototype, nom, {
          configurable: true,
          writable: true,
          value: commeNatif(fn, nom),
        });
      };

      poser('getTimezoneOffset', function() { return offsetFor(this); });

      // Seul getTimezoneOffset etait reecrit : getHours, toString et les autres
      // rendaient l'heure reelle de la machine. Mesure du 11 aout 2026 sur un
      // profil annoncant America/New_York depuis un serveur a Paris : la page
      // affichait 9h42 d'un cote et 15h de l'autre. Six heures d'ecart lisibles
      // en une expression, sur la meme page. On derive donc toutes les
      // composantes locales du meme decalage.
      const champs = {
        getFullYear: 'getUTCFullYear', getMonth: 'getUTCMonth', getDate: 'getUTCDate',
        getDay: 'getUTCDay', getHours: 'getUTCHours', getMinutes: 'getUTCMinutes',
        getSeconds: 'getUTCSeconds', getMilliseconds: 'getUTCMilliseconds',
      };
      const decale = (date) => new Date(date.getTime() - offsetFor(date) * 60000);
      for (const [local, utc] of Object.entries(champs)) {
        const natif = Date.prototype[utc];
        poser(local, function() {
          if (Number.isNaN(this.getTime())) return NaN;
          return natif.call(decale(this));
        });
      }

      const JOURS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const MOIS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const zero = (n, l) => String(Math.abs(n)).padStart(l || 2, '0');
      const partieDate = (d) => {
        const v = decale(d);
        return JOURS[v.getUTCDay()] + ' ' + MOIS[v.getUTCMonth()] + ' ' + zero(v.getUTCDate())
          + ' ' + v.getUTCFullYear();
      };
      const partieHeure = (d) => {
        const v = decale(d);
        const o = offsetFor(d);
        const signe = o > 0 ? '-' : '+';
        return zero(v.getUTCHours()) + ':' + zero(v.getUTCMinutes()) + ':' + zero(v.getUTCSeconds())
          + ' GMT' + signe + zero(Math.floor(Math.abs(o) / 60)) + zero(Math.abs(o) % 60);
      };
      poser('toString', function() {
        if (Number.isNaN(this.getTime())) return 'Invalid Date';
        return partieDate(this) + ' ' + partieHeure(this);
      });
      poser('toDateString', function() {
        return Number.isNaN(this.getTime()) ? 'Invalid Date' : partieDate(this);
      });
      poser('toTimeString', function() {
        return Number.isNaN(this.getTime()) ? 'Invalid Date' : partieHeure(this);
      });

      for (const method of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) {
        const nativeMethod = Date.prototype[method];
        poser(method, function(locales, options) {
          return nativeMethod.call(this, locales, withTimezone(options));
        });
      }
    } catch (error) {
      console.warn('[Spectra] Invalid fingerprint timezone ignored:', fp.timezone);
    }
  }

  // La position geographique du proxy n'est plus substituee : cette reecriture
  // faisait partie du bloc d'identite mesure comme responsable du refus de
  // connexion, retire le 15 aout 2026. A reprendre separement si la position
  // devient un besoin -- elle ne joue que si un site demande la geolocalisation
  // et que l'utilisateur l'accorde. Code dans l'historique git.

  // ---- ce qui distingue un profil d'un autre --------------------------------
  const screenValues = {
    width: fp.screenWidth,
    height: fp.screenHeight,
    availWidth: fp.availWidth,
    availHeight: fp.availHeight,
    colorDepth: fp.colorDepth,
    pixelDepth: fp.pixelDepth,
  };
  for (const [key, value] of Object.entries(screenValues)) define(Screen.prototype, key, value);
  define(window, 'devicePixelRatio', fp.devicePixelRatio);

  // Remplace une methode par une version masquee : meme nom, et toString()
  // repond "[native code]". Sans cela la reecriture se lit en clair.
  const remplacer = (cible, nom, fabrique) => {
    if (!cible || typeof cible[nom] !== 'function') return null;
    const natif = cible[nom];
    try {
      Object.defineProperty(cible, nom, {
        configurable: true, writable: true,
        value: commeNatif(fabrique(natif), nom),
      });
    } catch {}
    return natif;
  };

  // WebGL. 37445/37446 sont les valeurs de l'extension de debogage
  // (UNMASKED_VENDOR/RENDERER) ; 7936/7937 sont VENDOR et RENDERER standard.
  // Seules les deux premieres etaient traitees : les deux autres laissaient
  // passer la reponse reelle du moteur, qui trahit SwiftShader sur un serveur.
  // Chrome renvoie toujours "WebKit" et "WebKit WebGL" pour ces deux-la, quelle
  // que soit la carte : on reproduit exactement cela.
  const parametresWebgl = (natif) => function(parameter) {
    if (parameter === 37445 && fp.webglVendor) return fp.webglVendor;
    if (parameter === 37446 && fp.webglRenderer) return fp.webglRenderer;
    if (parameter === 7936) return 'WebKit';
    if (parameter === 7937) return 'WebKit WebGL';
    return natif.call(this, parameter);
  };
  remplacer(WebGLRenderingContext.prototype, 'getParameter', parametresWebgl);
  if (typeof WebGL2RenderingContext !== 'undefined') {
    remplacer(WebGL2RenderingContext.prototype, 'getParameter', parametresWebgl);
  }

  if (fp.canvasNoise && fp.canvasNoiseSeed) {
    const graine = Number(fp.canvasNoiseSeed) || 1;
    const PAS = 1024; // un pixel retouche tous les 1024

    // Deux regles apprises de la mesure du 11 aout 2026 :
    //   - un pixel entierement transparent doit rester (0,0,0,0). L'ancien code
    //     ecrivait rouge=255 sur un canvas vierge, ce qu'aucun Chrome ne produit.
    //   - la valeur doit etre bornee, pas repliee. L'ancien "& 255" faisait
    //     passer un pixel noir de 0 a 255 : un point rouge vif visible a l'oeil.
    const bruiter = (data) => {
      const pixels = data.length >> 2;
      for (let p = 0; p < pixels; p += PAS) {
        const i = p << 2;
        if (data[i + 3] === 0) continue;
        const delta = ((graine + p) % 3) - 1;
        if (delta === 0) continue;
        for (let c = 0; c < 3; c += 1) {
          const v = data[i + c] + delta;
          data[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
      }
      return data;
    };

    const natifGetImageData = CanvasRenderingContext2D.prototype.getImageData;

    // Le meme dessin se lit par plusieurs portes. Ne bruiter que getImageData
    // rendait les lectures incoherentes entre elles, ce qui se repere plus
    // facilement qu'une absence de bruit. Toutes les portes passent desormais
    // par la meme fonction.
    const copieBruitee = (canvas) => {
      const largeur = canvas.width;
      const hauteur = canvas.height;
      if (!largeur || !hauteur) return null;
      const copie = document.createElement('canvas');
      copie.width = largeur;
      copie.height = hauteur;
      const ctx = copie.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(canvas, 0, 0);
      const image = natifGetImageData.call(ctx, 0, 0, largeur, hauteur);
      bruiter(image.data);
      ctx.putImageData(image, 0, 0);
      return copie;
    };

    remplacer(CanvasRenderingContext2D.prototype, 'getImageData', (natif) => function(...args) {
      const image = natif.apply(this, args);
      try { bruiter(image.data); } catch {}
      return image;
    });

    remplacer(HTMLCanvasElement.prototype, 'toDataURL', (natif) => function(...args) {
      try {
        const copie = copieBruitee(this);
        if (copie) return natif.apply(copie, args);
      } catch {}
      return natif.apply(this, args);
    });

    remplacer(HTMLCanvasElement.prototype, 'toBlob', (natif) => function(...args) {
      try {
        const copie = copieBruitee(this);
        if (copie) return natif.apply(copie, args);
      } catch {}
      return natif.apply(this, args);
    });

    if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') {
      remplacer(OffscreenCanvasRenderingContext2D.prototype, 'getImageData', (natif) => function(...args) {
        const image = natif.apply(this, args);
        try { bruiter(image.data); } catch {}
        return image;
      });
    }

    // Lecture directe du tampon WebGL. On ne retouche que le cas courant
    // (RGBA, octets non signes) pour ne rien casser dans les autres formats.
    const lirePixels = (natif) => function(x, y, w, h, format, type, pixels, ...reste) {
      const sortie = natif.call(this, x, y, w, h, format, type, pixels, ...reste);
      try {
        if (format === 6408 && type === 5121
          && (pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray)) {
          bruiter(pixels);
        }
      } catch {}
      return sortie;
    };
    remplacer(WebGLRenderingContext.prototype, 'readPixels', lirePixels);
    if (typeof WebGL2RenderingContext !== 'undefined') {
      remplacer(WebGL2RenderingContext.prototype, 'readPixels', lirePixels);
    }
  }

  if (fp.audioNoise && fp.audioNoiseSeed && typeof AudioBuffer !== 'undefined') {
    const traites = new WeakSet();
    remplacer(AudioBuffer.prototype, 'getChannelData', (natif) => function(channel) {
      const data = natif.call(this, channel);
      if (!traites.has(data)) {
        const seed = Number(fp.audioNoiseSeed) || 1;
        for (let index = 0; index < data.length; index += 500) {
          // Un silence pur doit rester un silence pur.
          if (data[index] === 0) continue;
          data[index] += (((seed + index) % 5) - 2) * 1e-8;
        }
        traites.add(data);
      }
      return data;
    });
  }
})();
`);
        fs.writeFileSync(path.join(platformFixPath, 'x-cookie-consent.js'), `
(() => {
  const rejectPattern =
    /refuse|reject|non[- ]?essential|non n[eé]cessaires|rechazar|recusar|rifiuta|ablehnen/i;
  // Une banniere de consentement propose toujours les deux choix. C'est ce qui
  // permet de la reconnaitre sans dependre d'un conteneur precis -- et de ne
  // pas confondre son bouton avec un « refuser » situe ailleurs dans la page.
  const acceptPattern =
    /accept|accepter|aceptar|aceitar|accetta|akzeptieren|tout autoriser|allow all/i;
  let observer = null;

  const visible = (element) => {
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  const label = (element) => String(element.innerText || element.textContent || '').trim();

  const dismissBlockingConsent = () => {
    // Le repere data-testid="BottomBar" a disparu de la page de X : mesure du
    // 16 aout 2026, l'accueil n'expose plus aucun data-testid et la banniere
    // vit dans un simple role="region". On la cherche donc par ce qu'elle
    // contient, pas par l'endroit ou elle se trouve.
    const controls = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(visible);
    const rejectButton = controls.find((control) => rejectPattern.test(label(control)));
    if (!rejectButton) return false;

    const banniere =
      rejectButton.closest('[data-testid="BottomBar"]') ||
      rejectButton.closest('[role="region"]') ||
      rejectButton.parentElement?.parentElement;
    const accompagne = banniere
      ? Array.from(banniere.querySelectorAll('button, [role="button"]'))
          .filter(visible)
          .some((control) => acceptPattern.test(label(control)))
      : false;
    if (!accompagne) return false;

    rejectButton.click();
    observer?.disconnect();
    return true;
  };

  if (!dismissBlockingConsent()) {
    observer = new MutationObserver(() => dismissBlockingConsent());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.setTimeout(() => observer?.disconnect(), 30000);
  }
})();
`);
        console.log(`[Fingerprint] Runtime applied for ${platform}`);
      }

      autoStartLaunchId = options.autoStartTwitterBot
        ? require('crypto').randomUUID()
        : '';
      if (autoStartLaunchId) {
        this.pendingProfiles.add(options.profileId);
        console.log(`[Spectra AutoStart] Profile ${options.profileId} (${options.profileName})`);
        console.log(`[Spectra AutoStart] Launch ID: ${autoStartLaunchId}`);
      }

      // Create cookie-sync extension (export/import cookies for cloud sync)
      const cookieSyncPath = path.join(profilePath, '__cookie_sync_ext');
      if (fs.existsSync(cookieSyncPath)) {
        fs.rmSync(cookieSyncPath, { recursive: true, force: true });
      }
      fs.mkdirSync(cookieSyncPath, { recursive: true });

      // The generated worker contains launch-specific state (server token,
      // launch ID and OpenPost mode). Change its manifest version on every
      // launch so Chrome cannot reuse a worker created for another mode.
      const extensionVersionTime = new Date();
      const extensionVersionYear = extensionVersionTime.getUTCFullYear();
      const extensionVersionDay = Math.floor(
        (
          Date.UTC(
            extensionVersionYear,
            extensionVersionTime.getUTCMonth(),
            extensionVersionTime.getUTCDate()
          ) - Date.UTC(extensionVersionYear, 0, 0)
        ) / 86400000
      );
      const cookieSyncExtensionVersion = [
        extensionVersionYear,
        extensionVersionDay,
        extensionVersionTime.getUTCHours() * 60 + extensionVersionTime.getUTCMinutes(),
        extensionVersionTime.getUTCSeconds(),
      ].join('.');
      // A valid, fixed DER SubjectPublicKeyInfo keeps the unpacked runtime
      // extension ID stable across profiles and launches. Chrome may reject an
      // arbitrary byte string in manifest.key, which would leave Open Post on
      // X without ever loading the action controller.
      const cookieSyncManifestKey =
        'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAn1QtjQdz50DefJpeLaEMjPiR+NR/bpRV405aDQlabU0Rn7MNQAIb9QLUYFf5l5OF7z6GDlXcwnXjPGA3+EBUeJfvr7ETNsObyEa8t+8U8hC5znQZn/Q9aork0YMhhRI978yB759gT2DObLeu616XVzq/nvu0XOO/n0dUPqnhfMh6FcUy9241MxJGuyH0HiW5aOUTs2ewdiv+HfA8iybEmDn0kBCPB0vuveQxQsfduyteVd67IIet2JiyvoCbmh2Wbz7piYdfVM1cHtPnacGwFHVFwDfchxYiZ5CC35fCeSfMshUj/sNg8zVwjbsaLdnqJScpsZzdftZWkNT1duhXKwIDAQAB';

      fs.writeFileSync(path.join(cookieSyncPath, 'manifest.json'), JSON.stringify({
        manifest_version: 3,
        name: 'Cookie Sync',
        version: cookieSyncExtensionVersion,
        key: cookieSyncManifestKey,
        // Strict necessaire. 'storage' a servi aux journaux de diagnostic du
        // 13 aout 2026 ; ceux-ci retires, plus rien n'ecrit dans le stockage
        // de l'extension.
        permissions: ['cookies', 'tabs', 'scripting', 'alarms'],
        host_permissions: ['<all_urls>'],
        background: { service_worker: 'background.js' },
        ...((sessionImportAttemptId || options.branding || options.massPost) ? {
          content_scripts: [{
            matches: [
              'https://x.com/*',
              'https://www.x.com/*',
              'https://twitter.com/*',
              'https://www.twitter.com/*',
            ],
            js: [
              ...(sessionImportAttemptId ? ['session-import-login.js'] : []),
              ...(options.branding ? ['spectra-branding.js'] : []),
              ...(options.massPost ? ['spectra-mass-post.js'] : []),
            ],
            run_at: 'document_idle',
          }],
        } : {}),
      }));
      if (options.branding) {
        ecrireScriptInjecte(path.join(cookieSyncPath, 'spectra-branding.js'),
`(() => {
  if (window.__spectraBrandingInstalled) return;
  window.__spectraBrandingInstalled = true;

  const BRANDING = ${JSON.stringify(options.branding)};
  const SERVER = 'http://127.0.0.1:${this.localServerConfig?.port || 0}';
  const SERVER_TOKEN = ${JSON.stringify(this.localServerConfig?.token || '')};
  const PROFILE_ID = ${JSON.stringify(options.profileId)};
  const CLE = 'spectraJournalBranding';

  const attendre = (ms) => new Promise((suite) => setTimeout(suite, ms));
  const visible = (element) => element instanceof HTMLElement &&
    !element.closest('#spectra-journal') &&
    element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
  const pret = (champ) => visible(champ) && !champ.disabled && !champ.readOnly;
  const texte = () => String(document.body?.innerText || '');

  const lire = () => {
    try { return JSON.parse(localStorage.getItem(CLE) || '[]'); } catch { return []; }
  };
  // Replie par defaut : deplie, il recouvrait le formulaire des reglages et on
  // ne voyait plus rien de ce que le bot remplissait. Un clic l'ouvre.
  const CLE_OUVERT = 'spectraJournalOuvert';
  const estOuvert = () => sessionStorage.getItem(CLE_OUVERT) === '1';

  function dessiner() {
    let boite = document.getElementById('spectra-journal');
    if (!boite) {
      boite = document.createElement('div');
      boite.id = 'spectra-journal';
      boite.addEventListener('click', () => {
        try { sessionStorage.setItem(CLE_OUVERT, estOuvert() ? '0' : '1'); } catch {}
        dessiner();
      });
      (document.body || document.documentElement).appendChild(boite);
    }
    const couleurs = { info: '#e8e8ef', ok: '#4ade80', attente: '#fbbf24', erreur: '#f87171' };
    const lignes = lire();

    if (!estOuvert()) {
      const derniere = lignes[lignes.length - 1];
      boite.style.cssText = 'position:fixed;bottom:8px;left:8px;right:8px;z-index:2147483647;' +
        'background:rgba(10,10,14,.85);color:#e8e8ef;font:11px/1.4 system-ui,sans-serif;' +
        'padding:4px 9px;border:1px solid #3a3a4a;border-radius:8px;cursor:pointer;' +
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      boite.textContent = 'Spectra — ' + (derniere ? derniere.texte : 'en attente');
      boite.style.color = derniere ? (couleurs[derniere.ton] || couleurs.info) : couleurs.info;
      return;
    }

    boite.style.cssText = 'position:fixed;top:12px;right:12px;width:340px;max-height:70vh;overflow:auto;' +
      'z-index:2147483647;background:rgba(10,10,14,.94);color:#e8e8ef;font:12px/1.45 system-ui,sans-serif;' +
      'padding:10px 12px;border:1px solid #3a3a4a;border-radius:10px;white-space:pre-wrap;user-select:text;' +
      'cursor:pointer';
    boite.innerHTML = '<div style="font-weight:600;margin-bottom:6px">Branding — Spectra ' +
      '<span style="font-weight:400;opacity:.55">(clic pour replier)</span></div>' +
      lignes.map((e) => '<div style="color:' + (couleurs[e.ton] || couleurs.info) + '">' +
        e.heure + '  ' + String(e.texte).replace(/</g, '&lt;') + '</div>').join('');
    boite.scrollTop = boite.scrollHeight;
  }
  function journal(message, ton = 'info') {
    const lignes = lire();
    lignes.push({ heure: new Date().toLocaleTimeString('fr-FR'), texte: message, ton });
    try { localStorage.setItem(CLE, JSON.stringify(lignes.slice(-40))); } catch {}
    try { dessiner(); } catch {}
  }
  function pointRouge(element) {
    try {
      const b = element.getBoundingClientRect();
      const point = document.createElement('div');
      point.style.cssText = 'position:fixed;left:' + (b.left + b.width / 2 - 9) + 'px;top:' +
        (b.top + b.height / 2 - 9) + 'px;width:18px;height:18px;border-radius:50%;background:#ef4444;' +
        'box-shadow:0 0 0 6px rgba(239,68,68,.35);z-index:2147483647;pointer-events:none';
      document.body.appendChild(point);
      setTimeout(() => point.remove(), 1400);
    } catch {}
  }
  async function rapport(statut, message) {
    journal(message, statut === 'success' ? 'ok' : statut === 'failed' ? 'erreur' : 'attente');
    await fetch(SERVER + '/api/branding-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SERVER_TOKEN },
      body: JSON.stringify({ attemptId: BRANDING.attemptId, profileId: PROFILE_ID, status: statut, message }),
    }).catch(() => {});
  }

  const chercher = (selecteurs) => {
    for (const exigeant of [true, false]) {
      for (const selecteur of selecteurs) {
        const trouve = Array.from(document.querySelectorAll(selecteur))
          .find((e) => exigeant ? pret(e) : visible(e));
        if (trouve) return trouve;
      }
    }
    return null;
  };
  const attendreElement = async (selecteurs, limite = 20000) => {
    const fin = Date.now() + limite;
    while (Date.now() < fin) {
      const trouve = chercher(selecteurs);
      if (trouve) return trouve;
      await attendre(200);
    }
    return null;
  };

  function poserValeur(champ, valeur) {
    const prototype = champ.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(prototype.prototype, 'value')?.set?.call(champ, valeur);
    champ.dispatchEvent(new Event('input', { bubbles: true }));
    champ.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Une pause qui n'est jamais la meme : cinq champs remplis a la milliseconde
  // pres, c'est une signature aussi lisible qu'une empreinte.
  const hasardEntre = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
  const pause = (min, max) => attendre(hasardEntre(min, max));

  /**
   * Efface d'abord, ecrit ensuite -- et lettre par lettre.
   *
   * Un compte a souvent deja une bio ou un nom. Ecrire par-dessus sans vider
   * laisse la page dans un etat que X ne prend pas toujours : la valeur d'avant
   * revient, ou les deux se melangent. On vide, on laisse la page enregistrer
   * ce vide, puis on ecrit au rythme d'une saisie.
   */
  async function ecrire(champ, valeur) {
    champ.focus();
    await pause(200, 500);
    try { champ.setSelectionRange(0, String(champ.value || '').length); } catch {}
    poserValeur(champ, '');
    await pause(250, 600);

    let ecrit = '';
    for (const lettre of String(valeur)) {
      ecrit += lettre;
      poserValeur(champ, ecrit);
      // Une frappe humaine n'est pas reguliere, et marque un temps apres un
      // espace ou une ponctuation.
      await attendre(/[ .,!?]/.test(lettre) ? hasardEntre(90, 220) : hasardEntre(35, 110));
    }
  }
  /**
   * Dernier recours : retrouver un champ par ce qu'il annonce plutot que par
   * son nom technique. X renomme ses champs au fil des versions, et un
   * selecteur perime laisse le champ vide sans rien dire.
   */
  function chercherParLibelle(motif) {
    const champs = Array.from(document.querySelectorAll('input, textarea')).filter(visible);
    return champs.find((champ) => {
      const etiquette = champ.labels && champ.labels[0] ? champ.labels[0].textContent : '';
      return motif.test([
        champ.getAttribute('name') || '',
        champ.getAttribute('placeholder') || '',
        champ.getAttribute('aria-label') || '',
        etiquette || '',
      ].join(' '));
    }) || null;
  }

  async function remplir(selecteurs, valeur, nom, motifLibelle) {
    if (!valeur) return true;
    let champ = await attendreElement(selecteurs, 12000);
    if (!champ && motifLibelle) {
      champ = chercherParLibelle(motifLibelle);
      if (champ) journal(nom + ' : trouvé par son libellé', 'attente');
    }
    if (!champ) {
      // Dire ce qu'il y avait dans la page : un selecteur perime se corrige en
      // une ligne quand on sait ce qu'on aurait du viser.
      const presents = Array.from(document.querySelectorAll('input, textarea'))
        .filter(visible)
        .map((c) => (c.tagName.toLowerCase()) +
          (c.getAttribute('name') ? ' name=' + c.getAttribute('name') : '') +
          (c.getAttribute('placeholder') ? ' « ' + c.getAttribute('placeholder') + ' »' : ''))
        .slice(0, 8);
      journal(nom + ' : champ introuvable — présents : ' + (presents.join(' | ') || 'aucun'), 'erreur');
      return false;
    }
    pointRouge(champ);
    const avant = String(champ.value || '');
    if (avant) journal(nom + ' : j’efface « ' + avant.slice(0, 40) + ' »', 'attente');
    for (let essai = 0; essai < 30; essai++) {
      if (pret(champ)) {
        await ecrire(champ, valeur);
        await attendre(150);
        if (champ.value === valeur) { journal(nom + ' posé', 'ok'); return true; }
      }
      await attendre(250);
    }
    journal(nom + ' : le champ refuse la valeur', 'erreur');
    return false;
  }

  /**
   * Apres avoir choisi une image, X ouvre une fenetre de recadrage. Tant que
   * son bouton Appliquer n'est pas clique, l'image n'est pas retenue :
   * l'enregistrement du profil ne la voit meme pas.
   *
   * C'est l'etape qui manquait -- la photo etait bien deposee, puis perdue.
   */
  async function validerRecadrage(nom) {
    const LIBELLES = ['apply', 'appliquer', 'save', 'enregistrer', 'valider', 'done', 'terminé'];
    const fin = Date.now() + 12000;
    while (Date.now() < fin) {
      const dialogues = Array.from(document.querySelectorAll('[role="dialog"]')).filter(visible);
      const dialogue = dialogues[dialogues.length - 1];
      if (dialogue) {
        const bouton = Array.from(dialogue.querySelectorAll('button, [role="button"]'))
          .filter(visible)
          .find((b) => LIBELLES.includes(String(b.textContent || '').trim().toLowerCase()));
        if (bouton) {
          pointRouge(bouton);
          journal(nom + ' : recadrage validé (« ' + String(bouton.textContent || '').trim() + ' »)', 'ok');
          bouton.click();
          await attendre(1500);
          return true;
        }
      }
      await attendre(300);
    }
    // Pas de fenetre de recadrage : certaines versions de X n'en ouvrent pas.
    journal(nom + ' : pas de fenêtre de recadrage', 'info');
    return false;
  }

  // Une image arrive en data URL : on la redonne au champ de fichier comme si
  // l'utilisateur venait de la choisir.
  async function deposerImage(champFichier, dataUrl, nom) {
    try {
      const reponse = await fetch(dataUrl);
      const blob = await reponse.blob();
      const extension = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
      const fichier = new File([blob], nom + '.' + extension, { type: blob.type });
      const transfert = new DataTransfer();
      transfert.items.add(fichier);
      champFichier.files = transfert.files;
      champFichier.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (erreur) {
      journal(nom + ' : dépôt refusé — ' + String(erreur && erreur.message), 'erreur');
      return false;
    }
  }

  async function poser() {
    journal('Page : ' + location.pathname, 'info');

    // X demande parfois une verification humaine. Rien d'automatique n'a a
    // s'en meler : on s'arrete et on le dit, plutot que d'attendre un
    // formulaire qui n'arrivera pas.
    if (
      /just a moment|un instant|attendez/i.test(String(document.title || '')) ||
      /performing security verification|verify you are human/i.test(texte().slice(0, 400)) ||
      document.querySelector('iframe[src*="challenges.cloudflare.com"]')
    ) {
      await rapport('failed', 'X demande une vérification humaine — cette instance est à faire à la main');
      return;
    }

    // Un compte deconnecte ne peut rien modifier : le dire, plutot que de
    // tourner en rond sur la page de connexion.
    const connecte = Boolean(document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]')) ||
      /\\/(home|settings)/.test(location.pathname);
    if (/login|flow|onboarding/i.test(location.pathname + location.hash)) {
      await rapport('failed', 'Le compte est déconnecté — connecte-le d’abord');
      return;
    }

    // La page des reglages du profil est la seule ou tout se remplit.
    if (!/\\/settings\\/profile/.test(location.pathname)) {
      journal('Je vais sur les réglages du profil (depuis ' + location.pathname + ')', 'attente');
      location.assign('https://x.com/settings/profile');
      return;
    }

    // La page est une application : les champs arrivent apres le document.
    const premierChamp = await attendreElement(
      ['input[name="displayName"]', 'input[data-testid="displayNameInput"]', 'input[type="file"]'],
      20000
    );
    if (!premierChamp) {
      journal('Rien à remplir dans cette page — ' + texte().slice(0, 120), 'erreur');
      await rapport('failed', 'Page des réglages non reconnue');
      return;
    }
    journal('Page des réglages prête' + (connecte ? '' : ' (connexion incertaine)'), 'ok');

    const champsFichier = Array.from(document.querySelectorAll('input[type="file"]'));
    journal(champsFichier.length + ' champ(s) d’image dans la page', 'info');

    // X place la banniere avant la photo dans le formulaire.
    if (BRANDING.banniere && champsFichier[0]) {
      await pause(600, 1500);
      if (await deposerImage(champsFichier[0], BRANDING.banniere, 'banniere')) {
        journal('Bannière déposée', 'ok');
        await pause(1200, 2500);
        await validerRecadrage('Bannière');
      }
    }
    if (BRANDING.photo && champsFichier[1]) {
      await pause(800, 2000);
      if (await deposerImage(champsFichier[1], BRANDING.photo, 'photo')) {
        journal('Photo déposée', 'ok');
        await pause(1200, 2500);
        await validerRecadrage('Photo');
      }
    }

    let complet = true;
    // Une pause entre chaque champ : on ne passe pas de l'un a l'autre a la
    // vitesse d'une machine.
    complet = await remplir(['input[name="displayName"]', 'input[data-testid="displayNameInput"]'], BRANDING.nom, 'Nom', /displays*name|nom/i) && complet;
    await pause(700, 1800);
    complet = await remplir(['textarea[name="description"]', 'textarea[data-testid="descriptionInput"]'], BRANDING.bio, 'Bio', /bio|description/i) && complet;
    await pause(700, 1800);
    complet = await remplir(['input[name="location"]', 'input[data-testid="locationInput"]'], BRANDING.lieu, 'Lieu', /location|lieu|ville/i) && complet;
    // Le champ Website : X le nomme url, et selon les versions le repere par
    // son type ou par son libelle.
    await pause(700, 1800);
    complet = await remplir([
      'input[name="url"]',
      'input[data-testid="urlInput"]',
      'input[type="url"]',
      'input[inputmode="url"]',
      'input[name="website"]',
    ], BRANDING.lien, 'Lien', /url|website|site\s*web|lien/i) && complet;

    // Le temps de relire avant d'enregistrer.
    journal('Je relis avant d’enregistrer', 'info');
    await pause(1500, 3500);

    const enregistrer = chercher([
      '[data-testid="Profile_Save_Button"]',
      'button[type="submit"]',
      '[role="button"]',
    ]);
    if (!enregistrer) {
      await rapport('failed', 'Bouton Enregistrer introuvable');
      return;
    }
    pointRouge(enregistrer);
    journal('Clic sur Enregistrer', 'ok');
    enregistrer.click();

    await attendre(2500);
    if (/could not|erreur|error/i.test(texte())) {
      await rapport('failed', 'X a refusé l’enregistrement');
      return;
    }
    await rapport(complet ? 'success' : 'failed', complet ? 'Branding posé' : 'Branding incomplet');
  }

  try { dessiner(); } catch {}
  poser().catch((erreur) => rapport('failed', 'Échec inattendu : ' + String(erreur && erreur.message)));
})();`
        );
      }

      if (options.massPost) {
        ecrireScriptInjecte(path.join(cookieSyncPath, 'spectra-mass-post.js'),
`(() => {
  if (window.__spectraMassPostInstalled) return;
  window.__spectraMassPostInstalled = true;

  const POST = ${JSON.stringify(options.massPost)};
  const SERVER = 'http://127.0.0.1:${this.localServerConfig?.port || 0}';
  const SERVER_TOKEN = ${JSON.stringify(this.localServerConfig?.token || '')};
  const PROFILE_ID = ${JSON.stringify(options.profileId)};
  const CLE = 'spectraJournalPublication';

  const attendre = (ms) => new Promise((suite) => setTimeout(suite, ms));
  const hasardEntre = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
  const pause = (min, max) => attendre(hasardEntre(min, max));
  const visible = (element) => element instanceof HTMLElement &&
    !element.closest('#spectra-journal') &&
    element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
  const texte = () => String(document.body?.innerText || '');

  const lire = () => {
    try { return JSON.parse(localStorage.getItem(CLE) || '[]'); } catch { return []; }
  };

  /**
   * Le journal se tient replie : une ligne dans l'espace vide du haut, entre
   * la fleche de retour et le bouton Poster.
   *
   * Deplie, il recouvrait l'editeur et le media -- on ne voyait plus rien de
   * ce que le bot faisait. Un clic l'ouvre en entier quand il faut lire le
   * detail, et l'etat suit le profil d'une page a l'autre.
   */
  const CLE_OUVERT = 'spectraJournalOuvert';
  const estOuvert = () => sessionStorage.getItem(CLE_OUVERT) === '1';

  function dessiner() {
    let boite = document.getElementById('spectra-journal');
    if (!boite) {
      boite = document.createElement('div');
      boite.id = 'spectra-journal';
      boite.addEventListener('click', () => {
        try { sessionStorage.setItem(CLE_OUVERT, estOuvert() ? '0' : '1'); } catch {}
        dessiner();
      });
      (document.body || document.documentElement).appendChild(boite);
    }
    const couleurs = { info: '#e8e8ef', ok: '#4ade80', attente: '#fbbf24', erreur: '#f87171' };
    const lignes = lire();

    if (!estOuvert()) {
      const derniere = lignes[lignes.length - 1];
      boite.style.cssText = 'position:fixed;top:8px;left:52px;right:120px;z-index:2147483647;' +
        'background:rgba(10,10,14,.85);color:#e8e8ef;font:11px/1.4 system-ui,sans-serif;' +
        'padding:4px 9px;border:1px solid #3a3a4a;border-radius:8px;cursor:pointer;' +
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      boite.textContent = 'Spectra — ' + (derniere ? derniere.texte : 'en attente');
      boite.style.color = derniere ? (couleurs[derniere.ton] || couleurs.info) : couleurs.info;
      return;
    }

    boite.style.cssText = 'position:fixed;top:12px;right:12px;width:340px;max-height:70vh;overflow:auto;' +
      'z-index:2147483647;background:rgba(10,10,14,.94);color:#e8e8ef;font:12px/1.45 system-ui,sans-serif;' +
      'padding:10px 12px;border:1px solid #3a3a4a;border-radius:10px;white-space:pre-wrap;user-select:text;' +
      'cursor:pointer';
    boite.innerHTML = '<div style="font-weight:600;margin-bottom:6px">Publication — Spectra ' +
      '<span style="font-weight:400;opacity:.55">(clic pour replier)</span></div>' +
      lignes.map((e) => '<div style="color:' + (couleurs[e.ton] || couleurs.info) + '">' +
        e.heure + '  ' + String(e.texte).replace(/</g, '&lt;') + '</div>').join('');
    boite.scrollTop = boite.scrollHeight;
  }
  function journal(message, ton = 'info') {
    const lignes = lire();
    lignes.push({ heure: new Date().toLocaleTimeString('fr-FR'), texte: message, ton });
    try { localStorage.setItem(CLE, JSON.stringify(lignes.slice(-40))); } catch {}
    try { dessiner(); } catch {}
  }
  function pointRouge(element) {
    try {
      const b = element.getBoundingClientRect();
      const point = document.createElement('div');
      point.style.cssText = 'position:fixed;left:' + (b.left + b.width / 2 - 9) + 'px;top:' +
        (b.top + b.height / 2 - 9) + 'px;width:18px;height:18px;border-radius:50%;background:#ef4444;' +
        'box-shadow:0 0 0 6px rgba(239,68,68,.35);z-index:2147483647;pointer-events:none';
      document.body.appendChild(point);
      setTimeout(() => point.remove(), 1400);
    } catch {}
  }
  async function rapport(statut, message) {
    journal(message, statut === 'success' ? 'ok' : statut === 'failed' ? 'erreur' : 'attente');
    await fetch(SERVER + '/api/mass-post-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SERVER_TOKEN },
      body: JSON.stringify({ attemptId: POST.attemptId, profileId: PROFILE_ID, status: statut, message }),
    }).catch(() => {});
  }

  const chercher = (selecteurs) => {
    for (const selecteur of selecteurs) {
      const trouve = Array.from(document.querySelectorAll(selecteur)).find(visible);
      if (trouve) return trouve;
    }
    return null;
  };

  /**
   * X demande parfois une verification humaine avant de laisser passer.
   *
   * Rien d'automatique n'a a s'en meler : le bot s'arrete et le dit, pour que
   * la personne s'en occupe. Sans cette detection il attendait un editeur qui
   * n'arriverait jamais, dix minutes durant, sans rien afficher.
   */
  const verificationHumaine = () =>
    /just a moment|un instant|attendez/i.test(String(document.title || '')) ||
    /performing security verification|verify you are human|v[ée]rifi/i.test(texte().slice(0, 400)) ||
    Boolean(document.querySelector('iframe[src*="challenges.cloudflare.com"]'));
  const attendreElement = async (selecteurs, limite = 20000) => {
    const fin = Date.now() + limite;
    while (Date.now() < fin) {
      const trouve = chercher(selecteurs);
      if (trouve) return trouve;
      await attendre(200);
    }
    return null;
  };

  const EDITEUR = [
    '[data-testid="tweetTextarea_0"]',
    '.public-DraftEditor-content',
    '[role="textbox"][contenteditable="true"]',
  ];
  const BOUTON_ENVOI = [
    '[data-testid="tweetButton"]',
    '[data-testid="tweetButtonInline"]',
  ];

  /* On compare ce qui se lit, pas ce qui s'ecrit.
     Le texte porte des caracteres de largeur nulle, glisses avant l'envoi
     pour que deux publications du meme post ne soient pas identiques aux
     yeux de X. Ils sont invisibles a l'ecran mais X les deplace ou les
     retire en collant : sans les ecarter ici, la relecture ne
     correspondrait jamais et le robot conclurait « le coller n'a pas
     pris » alors que le texte est bon. */
  const normaliser = (valeur) => String(valeur || '')
    .replace(/[\\u200B-\\u200D\\uFEFF\\u2060]/g, '')
    .replace(/\\s+/g, ' ')
    .trim();

  /**
   * Relit ce qu'il y a dans l'editeur, ligne par ligne.
   *
   * textContent colle les lignes bout a bout sans rien entre elles : un post
   * en deux paragraphes se relisait « ... 2 HOURS !Guysss onlyyyy », sans
   * l'espace attendu, et la comparaison echouait alors que le texte etait
   * juste. Chaque ligne est un bloc a part dans l'editeur : on les rejoint.
   */
  const texteDuBloc = (bloc) => {
    // Les emoji ne sont pas du texte dans l'editeur : ce sont des images qui
    // portent le caractere en attribut. textContent les perd purement et
    // simplement, et la relecture croyait le texte ampute.
    const copie = bloc.cloneNode(true);
    for (const image of Array.from(copie.querySelectorAll('img'))) {
      image.replaceWith(document.createTextNode(image.getAttribute('alt') || ''));
    }
    return String(copie.textContent || '');
  };

  const lireEditeur = (editeur) => {
    // Une seule etiquette a la fois. Les demander ensemble ramenait le bloc
    // exterieur ET le bloc interieur qu'il contient : chaque ligne etait lue
    // deux fois, la comparaison echouait, et le repli recollait le texte
    // par-dessus -- ce qui le doublait pour de bon.
    let blocs = editeur.querySelectorAll('[data-block="true"]');
    if (blocs.length === 0) blocs = editeur.querySelectorAll('.public-DraftStyleDefault-block');
    if (blocs.length === 0) return texteDuBloc(editeur);
    return Array.from(blocs).map(texteDuBloc).join('\\n');
  };

  // Dernier recours pour comparer : sans aucun espace. Une mise en forme qui
  // differe ne doit pas faire echouer une publication dont le texte est bon.
  const sansEspaces = (valeur) => String(valeur || '').replace(/\\s+/g, '');

  /**
   * Le champ de X n'est pas un champ de texte : c'est un editeur riche qui
   * tient son contenu en memoire et le reaffiche apres chaque changement.
   *
   * Ecrire lettre par lettre avec insertText posait le caractere dans la page,
   * puis l'editeur reaffichait par-dessus son propre etat : les deux
   * s'additionnaient, et le texte doublait a chaque frappe. « if » devenait
   * « ifi », puis « ifi ifi », puis « ifi ifiyifi ifi » -- observe le 17 aout
   * 2026 sur six instances a la fois.
   *
   * Le coller, lui, n'ecrit rien dans la page : l'editeur intercepte
   * l'evenement, met a jour son etat, et se reaffiche une seule fois. C'est
   * aussi ce que fait quelqu'un qui a prepare sa legende ailleurs.
   */
  async function ecrireDansEditeur(editeur, valeur) {
    // Selectionner tout ce qui traine : un coller remplace la selection, ce
    // qui vide le brouillon et pose le texte en une seule operation.
    const selectionner = (tout) => {
      editeur.focus();
      const intervalle = document.createRange();
      intervalle.selectNodeContents(editeur);
      if (!tout) intervalle.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(intervalle);
      return editeur.contains(selection.anchorNode);
    };

    const coller = (contenu) => {
      const transfert = new DataTransfer();
      transfert.setData('text/plain', contenu);
      editeur.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: transfert,
        bubbles: true,
        cancelable: true,
      }));
    };

    if (!selectionner(true)) {
      journal('Impossible de placer le curseur dans l’éditeur', 'erreur');
      return '';
    }
    if (String(editeur.textContent || '').trim()) {
      journal('Je remplace le brouillon en place', 'attente');
    }
    await pause(400, 900);

    const correspond = () => {
      const relu = lireEditeur(editeur);
      if (normaliser(relu) === normaliser(valeur)) return true;
      // Une mise en forme relue autrement ne doit pas faire refuser un post
      // dont le texte est le bon.
      if (sansEspaces(relu) && sansEspaces(relu) === sansEspaces(valeur)) {
        journal('Texte bon, mise en forme relue autrement', 'attente');
        return true;
      }
      return false;
    };

    coller(valeur);
    await attendre(900);
    if (correspond()) return normaliser(valeur);

    // Repli, et seulement si l'editeur est reste vide. Reessayer par-dessus un
    // texte deja pose le doublait : c'est ce qui a produit « mayyy i dm you
    // random picss?? mayyy i dm you random picss?? » le 17 aout 2026.
    if (!String(lireEditeur(editeur)).trim()) {
      journal('Le coller n’a pas pris, j’essaie autrement', 'attente');
      selectionner(true);
      editeur.dispatchEvent(new InputEvent('beforeinput', {
        inputType: 'insertText',
        data: String(valeur),
        bubbles: true,
        cancelable: true,
      }));
      await attendre(900);
      if (correspond()) return normaliser(valeur);
    }

    journal('Attendu : « ' + normaliser(valeur).slice(0, 70) + ' »', 'erreur');
    return normaliser(lireEditeur(editeur));
  }

  /* Reveiller l'editeur, et le refaire tant que le bouton reste eteint.
     Un seul clic juste apres l'apercu ne suffit pas toujours : le fichier
     peut encore etre en cours d'envoi, et c'est la fin de l'envoi qui
     compte. On repete donc pendant l'attente, comme ecarterAnnonce(). */
  const reveillerEditeur = () => {
  try {
    // Ou cliquer, et surtout ou NE PAS cliquer.
    //
    // apercuMedia() peut renvoyer le bouton « Remove » : c'est l'un de ses
    // selecteurs de repli. Cliquer dessus retirerait le media qu'on vient
    // d'envoyer. On ne se sert donc jamais de cet element pour le clic.
    //
    // L'editeur de texte fait aussi bien : Florent l'a dit en montrant
    // l'ecran, « il faut cliquer sur le media ou la page ». Un clic dans
    // l'editeur ne peut rien casser, ne peut rien supprimer, et n'ouvre
    // aucune fenetre de retouche.
    const editeur = document.querySelector('[data-testid="tweetTextarea_0"]');
    const cible = editeur
      || document.querySelector('[data-testid="attachments"]')
      || null;
    if (cible) {
      // Un .click() ne suffisait pas : le 23 aout 2026 le bouton Poster
      // restait eteint sur une publication pourtant complete, texte et
      // media en place. X n'ecoute pas le clic, il ecoute la sequence qui
      // le precede -- survol, pointeur, souris, focus. VenusBot dispatche
      // ces dix evenements depuis toujours et n'a jamais eu ce probleme.
      const boite = cible.getBoundingClientRect();
      const x = boite.left + boite.width / 2;
      const y = boite.top + boite.height / 2;
      const details = {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        screenX: x + window.screenX,
        screenY: y + window.screenY,
        button: 0,
        buttons: 1,
        pointerId: 1,
        pointerType: 'mouse',
        view: window,
      };
      cible.dispatchEvent(new PointerEvent('pointerover', details));
      cible.dispatchEvent(new PointerEvent('pointerenter', details));
      cible.dispatchEvent(new MouseEvent('mouseover', details));
      cible.dispatchEvent(new MouseEvent('mouseenter', details));
      cible.dispatchEvent(new PointerEvent('pointerdown', details));
      cible.dispatchEvent(new MouseEvent('mousedown', details));
      if (cible.focus) cible.focus();
      cible.dispatchEvent(new PointerEvent('pointerup', details));
      cible.dispatchEvent(new MouseEvent('mouseup', details));
      cible.click();
      // Poser le curseur a la fin, comme le ferait un clic humain dans le
      // texte : c'est ce reveil de l'editeur qui rallume le bouton.
      if (editeur) {
        const selection = window.getSelection && window.getSelection();
        if (selection && document.createRange) {
          const plage = document.createRange();
          plage.selectNodeContents(editeur);
          plage.collapse(false);
          selection.removeAllRanges();
          selection.addRange(plage);
        }
      }
      return true;
    }
  } catch (e) {
    // Un clic qui echoue ne doit pas arreter la publication : le bouton
    // Poster reste le juge.
  }
    return false;
  };


  async function deposerMedia() {
    const champ = chercher(['[data-testid="fileInput"]', 'input[type="file"]']) ||
      await attendreElement(['input[type="file"]'], 5000);
    if (!champ) { journal('Aucun champ pour le média', 'erreur'); return false; }
    try {
      const reponse = await fetch(POST.media);
      const blob = await reponse.blob();
      const fichier = new File([blob], POST.nomMedia || 'media', { type: blob.type });
      const transfert = new DataTransfer();
      transfert.items.add(fichier);
      champ.files = transfert.files;
      champ.dispatchEvent(new Event('change', { bubbles: true }));
      journal('Média déposé : ' + (POST.nomMedia || 'média'), 'ok');
    } catch (erreur) {
      journal('Média refusé — ' + String(erreur && erreur.message), 'erreur');
      return false;
    }

    // L'envoi prend du temps, surtout pour une video. Poster avant la fin
    // publierait le texte tout seul.
    //
    // Attention a ce qu'on regarde : le compteur de caracteres de X est lui
    // aussi un [role="progressbar"], et il ne disparait jamais tant qu'il y a
    // du texte. Chercher une barre dans la page entiere bloquait donc pour
    // toujours -- observe le 17 aout 2026. On ne regarde que l'apercu du
    // media, et c'est l'etat du bouton Poster qui tranche ensuite.
    const apercuMedia = () => document.querySelector(
      '[data-testid="attachments"], [data-testid="media"], ' +
      '[aria-label*="Remove" i], [aria-label*="Supprimer" i]'
    );

    const finApercu = Date.now() + 60000;
    let apercu = null;
    while (Date.now() < finApercu) {
      apercu = apercuMedia();
      if (apercu) break;
      await attendre(400);
    }
    if (!apercu) {
      journal('Le média n’apparaît pas dans la publication', 'erreur');
      return false;
    }
    journal('Aperçu du média affiché', 'ok');

    // Un clic sur l'apercu, et un seul.
    //
    // Constate par Florent le 20 aout 2026 : sans ce clic, X laisse le bouton
    // Poster inerte apres un ajout de media. Le fichier est pourtant joint et
    // l'apercu s'affiche -- mais l'editeur ne considere la publication comme
    // complete qu'une fois le media touche. Le bot attendait alors un bouton
    // qui ne s'allumerait jamais, jusqu'au bout des 240 secondes.
    //
    // Precaution : sur une photo, ce clic peut ouvrir la fenetre de retouche
    // de X. On la referme aussitot avec Echap, sinon elle recouvrirait le
    // bouton Poster -- exactement le mal qu'ecarterAnnonce() soigne deja pour
    // les annonces.
    if (reveillerEditeur()) journal('Éditeur réveillé après le média', 'ok');

    // Une barre de progression a l'interieur de l'apercu, celle-la, parle bien
    // de l'envoi du fichier.
    const conteneur = apercu.closest('[data-testid="attachments"]') || apercu;
    const attenteMedia = 240000;
    const finEnvoi = Date.now() + attenteMedia;
    let dernierDit = 0;
    let tours = 0;
    while (Date.now() < finEnvoi) {
      // Le juge final, c'est le bouton Poster : X l'eteint tant qu'il n'a pas
      // fini d'accepter le fichier. Une video met bien plus longtemps qu'une
      // image, et la barre de progression seule ne suffisait pas a le savoir.
      if (envoiPossible(chercher(BOUTON_ENVOI))) {
        journal('Média prêt', 'ok');
        return true;
      }
      ecarterAnnonce();

      // Le bouton est encore eteint : on repose un clic dans l'editeur
      // toutes les trois secondes. Sans lui, X le laisse eteint meme une
      // fois le fichier accepte -- constate le 20 aout 2026, capture a
      // l'appui : media joint, texte en place, bouton Poster grise.
      tours += 1;
      if (tours % 6 === 0) reveillerEditeur();

      // Dire ou on en est, plutot que de laisser un ecran muet pendant cinq
      // minutes.
      const ecoule = Math.round((Date.now() - (finEnvoi - attenteMedia)) / 1000);
      if (ecoule >= dernierDit + 20) {
        dernierDit = ecoule;
        const barre = conteneur.querySelector('[role="progressbar"]');
        journal(
          'Média en cours (' + ecoule + ' s)' + (barre ? ' — envoi en cours' : ' — envoi terminé'),
          'attente'
        );
        const plainte = texte().match(/[^.\\n]*(not supported|too long|too large|failed|couldn.t|non pris en charge|trop)[^.\\n]*/i);
        if (plainte) journal('X dit : « ' + plainte[0].trim().slice(0, 90) + ' »', 'erreur');
      }
      await attendre(500);
    }
    journal('Le média n’a pas fini de se charger', 'erreur');
    return false;
  }

  const envoiPossible = (bouton) => bouton &&
    bouton.getAttribute('aria-disabled') !== 'true' && !bouton.disabled;

  /**
   * Ecarte les annonces que X pose par-dessus la page.
   *
   * « Introducing Downloadable Videos », les nouveautes, les rappels : elles
   * recouvrent la fenetre de redaction et le bouton Poster reste inaccessible.
   * Le bot attendait alors indefiniment un bouton qu'il ne pouvait pas voir.
   *
   * On ne touche jamais a la fenetre de redaction elle-meme -- reconnaissable
   * a l'editeur qu'elle contient -- et on ne clique que sur des libelles qui
   * ne peuvent qu'ecarter : jamais un OK ou un Fermer, trop ambigus.
   */
  const LIBELLES_ECARTER = [
    'got it', 'not now', 'maybe later', 'no thanks', 'skip', 'skip for now',
    'compris', 'plus tard', 'pas maintenant', 'non merci', 'passer',
  ];

  function ecarterAnnonce() {
    const estRedaction = (element) => Boolean(
      element.querySelector('[data-testid="tweetTextarea_0"], .public-DraftEditor-content')
    );
    const zones = Array.from(document.querySelectorAll('[role="dialog"]')).filter(visible)
      .filter((zone) => !estRedaction(zone));
    // Certaines annonces ne s'annoncent pas comme des dialogues : on retombe
    // alors sur la page entiere, ce que les libelles ci-dessus rendent sûr.
    const fouilles = zones.length > 0 ? zones : [document.body];

    for (const zone of fouilles) {
      const bouton = Array.from(zone.querySelectorAll('button, [role="button"]'))
        .filter(visible)
        .filter((b) => !b.closest('[data-testid="toolBar"]'))
        .find((b) => LIBELLES_ECARTER.includes(String(b.textContent || '').trim().toLowerCase()));
      if (bouton) {
        pointRouge(bouton);
        journal('J’écarte une annonce de X : « ' + String(bouton.textContent || '').trim() + ' »', 'attente');
        bouton.click();
        return true;
      }
    }
    return false;
  }

  async function publier() {
    journal('Page : ' + location.pathname, 'info');

    if (verificationHumaine()) {
      await rapport('failed', 'X demande une vérification humaine — cette instance est à faire à la main');
      return;
    }

    if (/login|flow|onboarding/i.test(location.pathname + location.hash)) {
      await rapport('failed', 'Le compte est déconnecté — connecte-le d’abord');
      return;
    }

    /* On reste sur le fil, comme le fait VenusBot.
       Le champ de publication est deja la, en haut de /home. Aller sur
       /compose/post etait notre tout premier geste, et c'est la que ca
       bloquait : la page s'ouvrait, l'editeur n'arrivait jamais, plus rien
       ne bougeait. VenusBot ne quitte jamais le fil et publie tous les
       jours. On fait pareil ; /compose/post ne sert plus que de secours. */
    const surCompose = /\\/compose\\/post/.test(location.pathname);
    if (!surCompose && !/\\/home/.test(location.pathname)) {
      journal('Je vais sur le fil', 'attente');
      location.assign('https://x.com/home');
      return;
    }

    /* Douze secondes sur le fil, pas vingt-cinq : si le champ n'y est pas,
       autant essayer la page dediee tout de suite plutot que d'attendre
       pour rien. */
    const editeur = await attendreElement(EDITEUR, surCompose ? 25000 : 12000);
    if (!editeur && !surCompose) {
      journal('Pas de champ sur le fil, j’ouvre la page de publication', 'attente');
      location.assign('https://x.com/compose/post');
      return;
    }
    if (!editeur) {
      // La verification peut arriver apres coup, pendant qu'on attend.
      if (verificationHumaine()) {
        await rapport('failed', 'X demande une vérification humaine — cette instance est à faire à la main');
        return;
      }
      journal('Éditeur introuvable — ' + texte().slice(0, 120), 'erreur');
      await rapport('failed', 'Éditeur de publication introuvable');
      return;
    }
    journal('Éditeur prêt', 'ok');
    pointRouge(editeur);
    if (ecarterAnnonce()) await attendre(1200);
    await pause(600, 1600);

    if (POST.texte) {
      const ecrit = await ecrireDansEditeur(editeur, POST.texte);
      const attendu = normaliser(POST.texte);
      if (ecrit !== attendu) {
        journal('Le texte posé ne correspond pas : « ' + ecrit.slice(0, 60) + ' »', 'erreur');
        await rapport('failed', 'Le texte n’est pas passé dans l’éditeur');
        return;
      }
      journal('Texte posé (' + attendu.length + ' caractères)', 'ok');
    }

    if (POST.media) {
      await pause(700, 1800);
      if (!await deposerMedia()) {
        await rapport('failed', 'Le média n’a pas pu être joint');
        return;
      }
    }

    journal('Je relis avant de poster', 'info');
    await pause(1500, 3500);

    // Le bouton reste eteint tant que X ne juge pas la publication valide :
    // attendre qu'il s'allume vaut mieux que cliquer dans le vide. C'est aussi
    // le seul juge fiable de la fin d'un envoi -- large, donc, pour une video.
    let bouton = null;
    const finBouton = Date.now() + 180000;
    let dit = false;
    let toursBouton = 0;
    while (Date.now() < finBouton) {
      bouton = chercher(BOUTON_ENVOI);
      if (envoiPossible(bouton)) break;
      if (bouton && !dit) { journal('J’attends que le bouton Poster s’allume', 'attente'); dit = true; }
      // Une annonce peut arriver a n'importe quel moment, y compris pendant
      // l'envoi du media : on regarde a chaque tour.
      if (ecarterAnnonce()) await attendre(1200);

      // Reveiller l'editeur ici aussi, et pas seulement apres un media.
      //
      // Le 20 aout 2026, 6 publications sur 74 ont echoue sur « Le bouton
      // Poster reste éteint », avec des textes qui passaient ailleurs. Le
      // reveil ne vivait alors que dans la pose du media -- or depuis le
      // meme jour, plus d'une publication sur deux part en texte seul et ne
      // passait donc jamais par la.
      toursBouton += 1;
      if (toursBouton % 8 === 0) reveillerEditeur();

      await attendre(400);
    }
    if (!envoiPossible(bouton)) {
      // Dire POURQUOI, pas seulement que ca n'a pas marche.
      //
      // « Le bouton Poster reste éteint » ne se diagnostique pas : on ne sait
      // ni si le texte a tenu, ni si le media est arrive, ni si X se plaint.
      // On releve l'etat avant d'abandonner.
      let etat = '';
      try {
        const editeur = document.querySelector('[data-testid="tweetTextarea_0"]');
        const longueur = editeur ? String(editeur.textContent || '').trim().length : -1;
        const media = document.querySelector('[data-testid="attachments"]');
        const plainte = texte().match(/[^.\\n]*(not supported|too long|too large|failed|couldn.t|non pris en charge|trop)[^.\\n]*/i);
        etat = ' — ' + (longueur < 0 ? 'éditeur absent' : longueur + ' caractères')
          + (media ? ', média joint' : ', sans média')
          + (plainte ? ', X dit : « ' + plainte[0].trim().slice(0, 60) + ' »' : '');
      } catch (e) { /* un diagnostic rate ne doit pas masquer l'echec */ }
      await rapport('failed', (bouton ? 'Le bouton Poster reste éteint' : 'Bouton Poster introuvable') + etat);
      return;
    }

    pointRouge(bouton);
    journal('Clic sur Poster', 'ok');
    bouton.click();

    // C'est parti quand l'editeur se vide ou que la page nous ramene au fil.
    const finEnvoi = Date.now() + 45000;
    while (Date.now() < finEnvoi) {
      const encore = chercher(EDITEUR);
      const vide = !encore || !String(encore.textContent || '').trim();
      /* L'editeur qui se vide est le signe sur : X a pris le texte.
         Le changement de page ne vaut que si l'on etait sur /compose/post --
         sur le fil on n'en bouge pas, et tester l'adresse ici declencherait
         un faux succes des la premiere seconde. */
      if (vide || (surCompose && !/\\/compose\\/post/.test(location.pathname))) {
        await rapport('success', 'Publication envoyée');
        return;
      }
      if (/could not send|something went wrong|erreur/i.test(texte())) {
        await rapport('failed', 'X a refusé la publication');
        return;
      }
      await attendre(700);
    }
    await rapport('failed', 'Pas de confirmation après le clic');
  }

  try { dessiner(); } catch {}
  publier().catch((erreur) => rapport('failed', 'Échec inattendu : ' + String(erreur && erreur.message)));
})();`
        );
      }

      const cookieSyncExtensionId = this.getChromeExtensionId(cookieSyncPath);
      if (!cookieSyncExtensionId) {
        throw new Error('Cookie Sync extension ID could not be derived');
      }
      const openPostBootstrapUrl = `chrome-extension://${cookieSyncExtensionId}/bootstrap.html`;

      if (targetTweetUrl) {
        // Cette page est le seul ecran visible quand la page X ne se charge
        // jamais : elle affiche donc le journal du demarrage, etape par etape.
        // Sans cela, une instance qui echoue reste 52 secondes sur un ecran
        // muet, et rien ne dit laquelle des trois etapes a cale.
        fs.writeFileSync(path.join(cookieSyncPath, 'bootstrap.html'),
          '<!doctype html><meta charset="utf-8"><title>Spectra Open Post</title>' +
          '<body style="margin:0;background:#0b0d12;color:#e5e7eb;' +
          'font:13px/1.5 system-ui,sans-serif;padding:18px">' +
          '<div style="font-size:15px;font-weight:600;margin-bottom:10px">Démarrage — Spectra</div>' +
          '<div id="spectra-etapes" style="white-space:pre-wrap;user-select:text">Je prépare la session…</div>' +
          '<script src="bootstrap.js"></script></body>'
        );
        fs.writeFileSync(path.join(cookieSyncPath, 'bootstrap.js'),
`chrome.runtime.sendMessage({ type: 'spectra:open-post-bootstrap-page' }, () => {
  void chrome.runtime.lastError;
});

(() => {
  const couleurs = { info: '#e8e8ef', ok: '#4ade80', attente: '#fbbf24', erreur: '#f87171' };
  const boite = document.getElementById('spectra-etapes');
  const debut = Date.now();

  function dessiner(lignes) {
    const ecoule = Math.round((Date.now() - debut) / 1000);
    boite.innerHTML =
      lignes.map((l) => '<div style="color:' + (couleurs[l.ton] || couleurs.info) + '">' +
        l.heure + '  ' + String(l.texte).replace(/</g, '&lt;') + '</div>').join('') +
      '<div style="color:#71717a;margin-top:8px">ouvert depuis ' + ecoule + ' s</div>';
  }

  // On interroge le service worker : il tient le journal, la page ne fait que
  // l'afficher. Un intervalle court, car tout se joue en moins d'une minute.
  setInterval(() => {
    try {
      chrome.runtime.sendMessage({ type: 'spectra:journal-demarrage' }, (reponse) => {
        void chrome.runtime.lastError;
        if (reponse && Array.isArray(reponse.lignes)) dessiner(reponse.lignes);
      });
    } catch {}
  }, 500);
})();
`
        );
        const targetStatusId = new URL(targetTweetUrl).pathname.match(/\/status\/(\d+)/)?.[1] || '';
        const closeFallbackUrl =
          `http://127.0.0.1:${this.localServerConfig?.port || 0}/api/close-profile` +
          `?profileId=${encodeURIComponent(options.profileId)}` +
          `&token=${encodeURIComponent(this.localServerConfig?.token || '')}`;
        ecrireScriptInjecte(path.join(cookieSyncPath, 'open-post-actions.js'),
`(() => {
  if (window.__spectraOpenPostActionsStarted) return;
  window.__spectraOpenPostActionsStarted = true;

  const TARGET_STATUS_ID = ${JSON.stringify(targetStatusId)};
  const CLOSE_FALLBACK_URL = ${JSON.stringify(closeFallbackUrl)};
  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  function reportStage(stage, details = {}) {
    try {
      chrome.runtime.sendMessage({
        type: 'spectra:open-post-telemetry',
        stage,
        details,
      }, () => { void chrome.runtime.lastError; });
    } catch {}
  }

  /**
   * Le verdict part aussi en direct vers Spectra, sans passer par l'extension.
   *
   * Le chemin habituel traverse le service worker avant d'atteindre Spectra,
   * et il perd des messages : le 17 aout 2026, le tweet affichait 24 retweets
   * quand le recapitulatif n'en comptait que 7. Le bot travaillait, la mesure
   * mentait -- et toute la journee de diagnostic s'est appuyee dessus.
   *
   * Cette page connait deja le port et le jeton du serveur local : autant lui
   * parler directement.
   */
  function rapportDirect(stage, details = {}) {
    try {
      const base = CLOSE_FALLBACK_URL.split('/api/')[0];
      const jeton = new URL(CLOSE_FALLBACK_URL).searchParams.get('token') || '';
      const profil = new URL(CLOSE_FALLBACK_URL).searchParams.get('profileId') || '';
      return fetch(base + '/api/lifecycle-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jeton },
        body: JSON.stringify({ profileId: profil, event: stage, details }),
      }).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }

  function findTargetArticle() {
    const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    const exactArticle = articles.find((article) =>
      Array.from(article.querySelectorAll('a[href]')).some((link) => {
        try {
          return new URL(link.href).pathname.includes('/status/' + TARGET_STATUS_ID);
        } catch {
          return false;
        }
      })
    );
    if (exactArticle) return exactArticle;
    return location.pathname.includes('/status/' + TARGET_STATUS_ID) ? articles[0] || null : null;
  }

  async function waitForTargetArticle(timeout = 45000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const article = findTargetArticle();
      if (article) return article;
      await wait(100);
    }
    return null;
  }

  async function waitForElement(selector, root = document, timeout = 2000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const element = root.querySelector(selector);
      if (element instanceof HTMLElement) return element;
      await wait(50);
    }
    return null;
  }

  async function showResultOverlay(success, likeConfirmed, repostConfirmed) {
    document.getElementById('spectra-open-post-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'spectra-open-post-overlay';
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');
    Object.assign(overlay.style, {
      position: 'fixed',
      zIndex: '2147483647',
      top: '18px',
      left: '50%',
      width: 'min(340px, calc(100vw - 28px))',
      padding: '16px',
      borderRadius: '18px',
      border: '1px solid rgba(255,255,255,0.14)',
      background: 'linear-gradient(145deg, rgba(17,24,39,0.97), rgba(8,12,20,0.96))',
      boxShadow: '0 18px 55px rgba(0,0,0,0.48), inset 0 1px 0 rgba(255,255,255,0.08)',
      backdropFilter: 'blur(18px)',
      color: '#f8fafc',
      fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      opacity: '0',
      transform: 'translate(-50%, -12px) scale(0.96)',
      transition: 'opacity 220ms ease, transform 220ms cubic-bezier(.2,.8,.2,1)',
      pointerEvents: 'none',
    });

    const header = document.createElement('div');
    Object.assign(header.style, { display: 'flex', alignItems: 'center', gap: '12px' });

    const check = document.createElement('div');
    check.textContent = success ? '✓' : '!';
    Object.assign(check.style, {
      display: 'grid',
      placeItems: 'center',
      width: '38px',
      height: '38px',
      flex: '0 0 38px',
      borderRadius: '12px',
      background: success
        ? 'linear-gradient(135deg, #34d399, #10b981)'
        : 'linear-gradient(135deg, #fbbf24, #f97316)',
      boxShadow: success
        ? '0 8px 24px rgba(16,185,129,0.32)'
        : '0 8px 24px rgba(249,115,22,0.32)',
      color: success ? '#03291d' : '#431407',
      fontSize: '23px',
      fontWeight: '900',
    });

    const titles = document.createElement('div');
    const title = document.createElement('div');
    title.textContent = success ? 'Actions terminées' : 'Instance ignorée';
    Object.assign(title.style, { fontSize: '15px', fontWeight: '800', letterSpacing: '-0.01em' });
    const subtitle = document.createElement('div');
    subtitle.textContent = success
      ? 'Le post a bien été traité'
      : 'Une action n’a pas pu être confirmée';
    Object.assign(subtitle.style, { marginTop: '2px', color: '#94a3b8', fontSize: '12px' });
    titles.append(title, subtitle);
    header.append(check, titles);

    const actions = document.createElement('div');
    Object.assign(actions.style, {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: '8px',
      marginTop: '14px',
    });

    const createAction = (icon, label, color, background) => {
      const item = document.createElement('div');
      Object.assign(item.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '9px 10px',
        borderRadius: '11px',
        background,
        border: '1px solid rgba(255,255,255,0.07)',
        fontSize: '12px',
        fontWeight: '700',
      });
      const glyph = document.createElement('span');
      glyph.textContent = icon;
      Object.assign(glyph.style, { color, fontSize: '16px', lineHeight: '1' });
      const text = document.createElement('span');
      text.textContent = label;
      item.append(glyph, text);
      return item;
    };

    actions.append(
      createAction(
        likeConfirmed ? '♥' : '!',
        likeConfirmed ? 'Like confirmé' : 'Like non confirmé',
        likeConfirmed ? '#fb7185' : '#fbbf24',
        likeConfirmed ? 'rgba(244,63,94,0.10)' : 'rgba(245,158,11,0.10)'
      ),
      createAction(
        repostConfirmed ? '↻' : '!',
        repostConfirmed ? 'Repost confirmé' : 'Repost non confirmé',
        repostConfirmed ? '#34d399' : '#fbbf24',
        repostConfirmed ? 'rgba(16,185,129,0.10)' : 'rgba(245,158,11,0.10)'
      )
    );

    const footer = document.createElement('div');
    Object.assign(footer.style, { marginTop: '13px' });
    const closingText = document.createElement('div');
    closingText.id = 'spectra-open-post-closing-status';
    closingText.textContent = success
      ? 'Fermeture de l’instance…'
      : 'Passage à l’instance suivante…';
    Object.assign(closingText.style, {
      marginBottom: '7px',
      color: '#cbd5e1',
      fontSize: '11px',
      fontWeight: '600',
    });
    const track = document.createElement('div');
    Object.assign(track.style, {
      height: '3px',
      overflow: 'hidden',
      borderRadius: '999px',
      background: 'rgba(148,163,184,0.18)',
    });
    const progress = document.createElement('div');
    Object.assign(progress.style, {
      width: '0%',
      height: '100%',
      borderRadius: '999px',
      background: 'linear-gradient(90deg, #38bdf8, #34d399)',
      boxShadow: '0 0 12px rgba(52,211,153,0.55)',
      transition: 'width 800ms linear',
    });
    track.append(progress);
    footer.append(closingText, track);
    overlay.append(header, actions, footer);
    document.body.append(overlay);

    requestAnimationFrame(() => {
      overlay.style.opacity = '1';
      overlay.style.transform = 'translate(-50%, 0) scale(1)';
      progress.style.width = '100%';
    });
    await wait(800);
  }

  async function finishInstance(success, likeConfirmed, repostConfirmed) {
    await showResultOverlay(success, likeConfirmed, repostConfirmed);
    document.documentElement.dataset.spectraOpenPostComplete = '1';
    for (let attempt = 0; attempt < 5; attempt++) {
      const accepted = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({
            type: 'spectra:open-post-actions-complete',
            success,
          }, (response) => {
            const failed = Boolean(chrome.runtime.lastError);
            resolve(!failed && response?.accepted === true);
          });
        } catch {
          resolve(false);
        }
      });
      if (accepted) {
        const status = document.getElementById('spectra-open-post-closing-status');
        if (status) status.textContent = 'Signal de fermeture reçu…';
        window.setTimeout(() => window.location.replace(CLOSE_FALLBACK_URL), 600);
        return;
      }
      await wait(200);
    }
    const status = document.getElementById('spectra-open-post-closing-status');
    if (status) {
      status.textContent = 'Fermeture forcée…';
      status.style.color = '#fbbf24';
    }
    console.warn('[Spectra OpenPost] Completion signal was not acknowledged');
    window.location.replace(CLOSE_FALLBACK_URL);
  }

  async function run() {
    reportStage('content-loaded', { path: location.pathname });
    reportStage('actions-started');

    const article = await waitForTargetArticle();
    if (!article) {
      // Dire ce qu'il y avait a l'ecran, pas seulement que le tweet manquait.
      // Une page de verification humaine, un mur de connexion et un compte
      // suspendu produisent tous les trois « tweet introuvable » -- et se
      // reparent de trois facons differentes.
      const corps = String(document.body && document.body.innerText || '');
      const connecte = Boolean(document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]'));
      const verification =
        /verify you are human|performing security verification|just a moment/i.test(corps) ||
        Boolean(document.querySelector('iframe[src*="challenges.cloudflare.com"]'));
      const cause = verification ? 'verification-humaine'
        : /log in|sign in|se connecter/i.test(corps) && !connecte ? 'deconnecte'
        : /account suspended|compte suspendu/i.test(corps) ? 'compte-suspendu'
        : /hasn.t sent any posts|this post is unavailable|post indisponible/i.test(corps) ? 'post-indisponible'
        : /something went wrong|une erreur/i.test(corps) ? 'erreur-x'
        : 'inconnu';
      // Un echec se note aussi : le registre doit savoir que cette instance a
      // bien ete traitee, sinon le tour la rouvrira sans fin.
      await rapportDirect('open-post-verdict', {
        tweet: TARGET_STATUS_ID,
        retweet: false,
        like: false,
        panne: cause,
      });
      // Ce que la page contenait vraiment. Le 18 aout 2026, des instances
      // signalaient « tweet introuvable » alors que l'apercu montrait bien
      // « Conversation ... @AnnieKMiteen ... » : la page etait chargee, le
      // compte connecte, et l'article restait introuvable. Sans compter les
      // articles presents, impossible de distinguer une page vide d'un
      // selecteur perime.
      const articlesTweet = document.querySelectorAll('article[data-testid="tweet"]').length;
      const articlesTous = document.querySelectorAll('article').length;
      const marqueurs = Array.from(document.querySelectorAll('[data-testid]'))
        .map((e) => e.getAttribute('data-testid'))
        .filter((v, i, t) => v && t.indexOf(v) === i)
        .slice(0, 14).join(',');

      reportStage('target-not-found', {
        cause: cause,
        articlesTweet: articlesTweet,
        articlesTous: articlesTous,
        marqueurs: marqueurs,
        connecte: connecte,
        titre: String(document.title || '').slice(0, 80),
        chemin: location.pathname,
        apercu: corps.replace(/\\s+/g, ' ').trim().slice(0, 200),
      });
      console.warn('[Spectra OpenPost] Target post was not found:', cause);
      await finishInstance(false, false, false);
      return;
    }
    reportStage('target-found');

    article.scrollIntoView({ block: 'center', inline: 'nearest' });
    await wait(100);

    let likeStatus = 'already-liked';
    if (!article.querySelector('[data-testid="unlike"]')) {
      const likeButton = await waitForElement('[data-testid="like"]', article);
      if (likeButton) {
        const hasPhoto = Boolean(
          article.querySelector('[data-testid="tweetPhoto"], img[src*="/media/"]')
        );
        const likeBounds = likeButton.getBoundingClientRect();
        const actionBarOutsideViewport =
          likeBounds.top < 0 || likeBounds.bottom > window.innerHeight;
        if (hasPhoto || actionBarOutsideViewport) {
          console.log('[Spectra OpenPost] Media post detected; scrolling to actions');
          likeButton.scrollIntoView({ block: 'center', inline: 'nearest' });
          await wait(300);
        }
        likeButton.click();
        likeStatus = await waitForElement('[data-testid="unlike"]', article, 4000)
          ? 'liked'
          : 'unconfirmed';
      } else {
        likeStatus = 'button-not-found';
      }
    }
    console.log('[Spectra OpenPost] like: ' + likeStatus);
    reportStage('like-result', { status: likeStatus });

    await wait(200);

    let repostStatus = 'already-reposted';
    if (!article.querySelector('[data-testid="unretweet"]')) {
      const repostButton = await waitForElement('[data-testid="retweet"]', article);
      if (repostButton) {
        repostButton.click();
        const confirmButton = await waitForElement('[data-testid="retweetConfirm"]');
        if (confirmButton) {
          confirmButton.click();
          repostStatus = await waitForElement('[data-testid="unretweet"]', article, 4000)
            ? 'reposted'
            : 'unconfirmed';
        } else {
          repostStatus = 'confirmation-not-found';
        }
      } else {
        repostStatus = 'button-not-found';
      }
    }
    console.log('[Spectra OpenPost] repost: ' + repostStatus);
    reportStage('repost-result', { status: repostStatus });

    // Le juge, c'est la page elle-meme : le bouton « Annuler le retweet » n'est
    // present que si le retweet existe vraiment. On le relit une derniere fois
    // avant de conclure, plutot que de se fier a ce qui vient de se passer.
    const retweetVisible = Boolean(article.querySelector('[data-testid="unretweet"]'));
    const likeVisible = Boolean(article.querySelector('[data-testid="unlike"]'));
    await rapportDirect('open-post-verdict', {
      // Le tweet vise voyage avec le verdict : sans lui, le registre ne sait
      // pas a quel post rattacher le resultat.
      tweet: TARGET_STATUS_ID,
      retweet: retweetVisible,
      like: likeVisible,
      repostStatus,
      likeStatus,
    });

    const likeConfirmed = likeStatus === 'liked' || likeStatus === 'already-liked';
    const repostConfirmed = repostStatus === 'reposted' || repostStatus === 'already-reposted';
    const success = likeConfirmed && repostConfirmed;
    await finishInstance(success, likeConfirmed, repostConfirmed);
  }

  run().catch(async (error) => {
    console.error('[Spectra OpenPost] Actions failed:', error);
    await finishInstance(false, false, false);
  });
})();`
        );
      }

      if (sessionImportAttemptId) {
        fs.writeFileSync(path.join(cookieSyncPath, 'session-import-login.js'),
`(() => {
  if (window.__spectraSessionImportInstalled) return;
  window.__spectraSessionImportInstalled = true;
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  // Le panneau de journal est cliquable, donc il fait partie de la page. Il ne
  // doit jamais etre pris pour un element de X : le robot cliquerait sur son
  // propre bouton Copier au lieu du bouton de connexion.
  const visible = (element) => element instanceof HTMLElement &&
    !element.closest('#spectra-journal') &&
    element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
  // Un champ peut etre affiche sans etre pret : X le laisse desactive le temps
  // que sa page finisse de s'installer. Ecrire a ce moment-la ne laisse rien --
  // le champ reste vide et la connexion s'arrete sans la moindre erreur.
  const champPret = (input) =>
    visible(input) && !input.disabled && !input.readOnly &&
    input.getAttribute('aria-disabled') !== 'true';
  // X ouvre parfois sa boite de connexion PAR-DESSUS une page qui contient
  // deja un champ identifiant. Les deux sont mesurables a l'ecran : sans cette
  // precision, le script ecrit dans celui du dessous, que personne ne voit, et
  // la connexion s'arrete sans erreur. Mesure du 16 aout 2026 sur
  // x.com/i/jf/onboarding/web.
  const racineActive = () => {
    const dialogues = Array.from(document.querySelectorAll('[role="dialog"]')).filter(visible);
    return dialogues.length ? dialogues[dialogues.length - 1] : document;
  };
  const findVisible = (selectors) => {
    // Un champ actif l'emporte toujours sur un champ simplement affiche : une
    // page de X peut en montrer deux, dont un desactive.
    for (const exigeant of [true, false]) {
      for (const racine of [racineActive(), document]) {
        for (const selector of selectors) {
          const candidats = Array.from(racine.querySelectorAll(selector));
          const match = candidats.find(
            element => exigeant ? champPret(element) : visible(element)
          );
          if (match) return match;
        }
      }
    }
    return null;
  };
  const pageText = () => String(document.body?.innerText || '').toLowerCase();
  const isHome = () => /\\/(home|compose\\/post)(?:[/?#]|$)/.test(location.pathname) ||
    Boolean(document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]'));
  const isManualChallenge = () => {
    const text = pageText();
    return Boolean(
      document.querySelector('iframe[src*="captcha"], [data-testid*="captcha"]') ||
      /captcha|arkose|verify your identity|check your email|email address|phone number|text message|sms|security key|backup code/.test(text)
    );
  };
  async function waitFor(predicate, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = predicate();
      if (result) return result;
      await wait(150);
    }
    return null;
  }
  function setInputValue(input, value) {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  // On ecrit, puis on relit. Tant que la valeur n'est pas la, on recommence.
  // On recoit de quoi RETROUVER le champ, pas le champ lui-meme. X change de
  // page entre deux etapes : garder la reference du premier champ trouve, c'est
  // attendre qu'un element mort redevienne actif -- ce qui n'arrive jamais.
  // Mesure du 16 aout 2026 : le champ mot de passe etait saisi sur la page
  // qu'on venait de quitter, puis abandonne au bout de cinq secondes.
  async function saisirEtVerifier(trouver, value, nom, essais = 60) {
    let signale = false;
    for (let essai = 0; essai < essais; essai++) {
      const input = typeof trouver === 'function' ? trouver() : trouver;
      if (input && document.contains(input) && champPret(input)) {
        if (!signale) pointRouge(input);
        setInputValue(input, value);
        await wait(120);
        if (input.value === value) {
          journal(nom + ' saisi' + (essai ? ' (après ' + essai + ' essais)' : ''), 'ok');
          return true;
        }
        journal(nom + ' : la valeur ne reste pas dans le champ', 'attente');
      } else if (!signale) {
        signale = true;
        journal(
          nom + ' : ' + (input ? 'le champ est là mais pas encore actif' : 'plus de champ dans la page') +
          ', j’attends',
          'attente'
        );
      }
      await wait(250);
    }
    journal(nom + ' : abandon après ' + essais + ' essais', 'erreur');
    return false;
  }
  function clickButton(labels) {
    const wanted = labels.map(label => label.toLowerCase());
    for (const racine of [racineActive(), document]) {
      const button = Array.from(racine.querySelectorAll('button, [role="button"]'))
        .filter(visible)
        .find(candidate => wanted.includes(String(candidate.textContent || '').trim().toLowerCase()));
      if (button) {
        pointRouge(button);
        journal('Clic sur « ' + String(button.textContent || '').trim() + ' »', 'ok');
        button.click();
        return true;
      }
    }
    journal('Aucun bouton trouvé parmi : ' + labels.join(', '), 'attente');
    return false;
  }
  function pressEnter(input) {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  }

  // --- Ce que le robot fait, visible dans la page -----------------------------
  //
  // La connexion enchaine des etapes invisibles : on ne voyait que le resultat,
  // et « rien ne se passe » ne dit pas a quel moment. Le journal vit dans
  // sessionStorage pour survivre aux changements de page de X.
  const CLE_JOURNAL = 'spectraJournalConnexion';
  const lireJournal = () => {
    try {
      return JSON.parse(
        sessionStorage.getItem(CLE_JOURNAL) || localStorage.getItem(CLE_JOURNAL) || '[]'
      );
    } catch { return []; }
  };
  const journalEnTexte = () =>
    lireJournal().map((entree) => entree.heure + '  ' + entree.texte).join('\\n');

  function dessinerPanneau() {
    let boite = document.getElementById('spectra-journal');
    if (!boite) {
      boite = document.createElement('div');
      boite.id = 'spectra-journal';
      boite.style.cssText = [
        'position:fixed', 'top:12px', 'right:12px', 'width:340px', 'max-height:70vh',
        'z-index:2147483647', 'background:rgba(10,10,14,.94)', 'color:#e8e8ef',
        'font:12px/1.45 system-ui,sans-serif', 'padding:10px 12px',
        'border:1px solid #3a3a4a', 'border-radius:10px',
        'box-shadow:0 10px 40px rgba(0,0,0,.5)',
        // Le panneau doit pouvoir etre selectionne et copie a la souris.
        'user-select:text', '-webkit-user-select:text', 'display:flex',
        'flex-direction:column',
      ].join(';');

      const entete = document.createElement('div');
      entete.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px';
      const titre = document.createElement('div');
      titre.textContent = 'Connexion X — Spectra';
      titre.style.cssText = 'font-weight:600';
      const copier = document.createElement('button');
      copier.id = 'spectra-journal-copier';
      copier.textContent = 'Copier';
      copier.style.cssText = [
        'font:11px system-ui,sans-serif', 'padding:3px 9px', 'border-radius:6px',
        'border:1px solid #4a4a5c', 'background:#22222e', 'color:#e8e8ef', 'cursor:pointer',
      ].join(';');
      copier.addEventListener('click', async (evenement) => {
        evenement.stopPropagation();
        const texte = journalEnTexte();
        let reussi = false;
        try {
          await navigator.clipboard.writeText(texte);
          reussi = true;
        } catch {
          // Le presse-papiers moderne exige parfois que la page ait le focus.
          try {
            const zone = document.createElement('textarea');
            zone.value = texte;
            zone.style.cssText = 'position:fixed;top:-1000px';
            document.body.appendChild(zone);
            zone.select();
            reussi = document.execCommand('copy');
            zone.remove();
          } catch {}
        }
        copier.textContent = reussi ? 'Copié' : 'Sélectionne le texte';
        setTimeout(() => { copier.textContent = 'Copier'; }, 2000);
      });
      entete.appendChild(titre);
      entete.appendChild(copier);

      const lignes = document.createElement('div');
      lignes.id = 'spectra-journal-lignes';
      lignes.style.cssText = 'overflow:auto;white-space:pre-wrap';

      boite.appendChild(entete);
      boite.appendChild(lignes);
      (document.body || document.documentElement).appendChild(boite);
    }
    const couleurs = { info: '#e8e8ef', ok: '#4ade80', attente: '#fbbf24', erreur: '#f87171' };
    const lignes = boite.querySelector('#spectra-journal-lignes');
    if (!lignes) return;
    lignes.innerHTML = lireJournal().map((entree) =>
      '<div style="color:' + (couleurs[entree.ton] || couleurs.info) + '">' +
      entree.heure + '  ' + String(entree.texte).replace(/</g, '&lt;') + '</div>'
    ).join('');
    lignes.scrollTop = lignes.scrollHeight;
  }
  function journal(texte, ton = 'info') {
    const lignes = lireJournal();
    lignes.push({ heure: new Date().toLocaleTimeString('fr-FR'), texte, ton });
    const contenu = JSON.stringify(lignes.slice(-40));
    try { sessionStorage.setItem(CLE_JOURNAL, contenu); } catch {}
    // Le meme journal dans localStorage : lui est ecrit sur le disque du
    // profil et se relit apres coup, meme si la fenetre a ete fermee. Sans
    // cela, il faut une capture d'ecran a chaque essai pour savoir ce qui
    // s'est passe.
    try { localStorage.setItem(CLE_JOURNAL, contenu); } catch {}
    try { dessinerPanneau(); } catch {}
  }
  // Un point rouge la ou le robot agit, plus un cadre sur l'element touche.
  function pointRouge(element) {
    try {
      const boite = element.getBoundingClientRect();
      const point = document.createElement('div');
      point.style.cssText = [
        'position:fixed', 'left:' + (boite.left + boite.width / 2 - 9) + 'px',
        'top:' + (boite.top + boite.height / 2 - 9) + 'px', 'width:18px', 'height:18px',
        'border-radius:50%', 'background:#ef4444', 'box-shadow:0 0 0 6px rgba(239,68,68,.35)',
        'z-index:2147483647', 'pointer-events:none', 'transition:opacity .9s ease-out',
      ].join(';');
      const cadre = document.createElement('div');
      cadre.style.cssText = [
        'position:fixed', 'left:' + boite.left + 'px', 'top:' + boite.top + 'px',
        'width:' + boite.width + 'px', 'height:' + boite.height + 'px',
        'border:2px solid #ef4444', 'border-radius:6px', 'z-index:2147483646',
        'pointer-events:none', 'transition:opacity .9s ease-out',
      ].join(';');
      document.body.appendChild(point);
      document.body.appendChild(cadre);
      setTimeout(() => { point.style.opacity = '0'; cadre.style.opacity = '0'; }, 700);
      setTimeout(() => { point.remove(); cadre.remove(); }, 1700);
    } catch {}
  }
  // Une cle 2FA se recopie a la main, se colle depuis un site, s'exporte en
  // lien otpauth:// : elle arrive en minuscules, avec des espaces, des tirets,
  // parfois enveloppee dans une adresse. Le decodeur n'acceptait que des
  // majuscules collees et jetait tout le reste -- l'erreur remontait en
  // « echec inattendu », sans jamais dire que la cle etait en cause.
  function nettoyerSecret(secret) {
    let valeur = String(secret || '').trim();
    if (/^otpauth:\\/\\//i.test(valeur)) {
      try {
        valeur = new URL(valeur).searchParams.get('secret') || valeur;
      } catch {}
    }
    return valeur.replace(/[\\s._-]/g, '').replace(/=+$/g, '').toUpperCase();
  }
  function decodeBase32(secret) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const character of nettoyerSecret(secret)) {
      const value = alphabet.indexOf(character);
      if (value < 0) throw new Error('invalid-totp-secret');
      bits += value.toString(2).padStart(5, '0');
    }
    const bytes = [];
    for (let index = 0; index + 8 <= bits.length; index += 8) {
      bytes.push(parseInt(bits.slice(index, index + 8), 2));
    }
    return new Uint8Array(bytes);
  }
  async function totpCode(secret) {
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setUint32(4, Math.floor(Date.now() / 30000), false);
    const key = await crypto.subtle.importKey(
      'raw', decodeBase32(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
    );
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, buffer));
    const offset = signature[signature.length - 1] & 15;
    const value = (
      ((signature[offset] & 127) << 24) |
      ((signature[offset + 1] & 255) << 16) |
      ((signature[offset + 2] & 255) << 8) |
      (signature[offset + 3] & 255)
    ) % 1000000;
    return String(value).padStart(6, '0');
  }
  async function report(status, message = '') {
    const tons = { success: 'ok', failed: 'erreur', manual: 'attente' };
    journal(message || status, tons[status] || 'info');
    await chrome.runtime.sendMessage({ type: 'spectra:session-import-status', status, message })
      .catch(() => {});
  }
  async function run(credentials) {
    if (window.__spectraSessionImportRunning) return;
    window.__spectraSessionImportRunning = true;
    try {
      if (isHome()) {
        await report('success', 'Session X déjà connectée');
        return;
      }
      await report('entering-username', 'Saisie de l’identifiant X');
      journal('Page : ' + location.pathname, 'info');
      // X ne nomme pas toujours son champ de la meme facon selon l'ecran servi.
      // On part du plus precis et on elargit jusqu'a n'importe quel champ de
      // saisie visible : sur une page de connexion, il n'y en a qu'un.
      const CHAMPS_IDENTIFIANT = [
        'input[autocomplete="username"]',
        'input[name="text"]',
        'input[autocomplete="email"]',
        'input[type="email"]',
        'input[type="text"]',
        'input:not([type]):not([hidden])',
        'input[type="tel"]',
      ];
      let dernierEtat = '';
      const username = await waitFor(() => {
        const champ = findVisible(CHAMPS_IDENTIFIANT);
        if (champ) return champ;
        // Le bandeau peut arriver apres la page : on retente a chaque tour.
        ecarterBandeauCookies();
        // Dire ce qu'on voit pendant l'attente, plutot que de rester muet
        // quarante-cinq secondes puis d'annoncer un echec sans explication.
        const presents = Array.from(document.querySelectorAll('input')).filter(visible);
        const etat = presents.length
          ? presents.length + ' champ(s) visible(s) : ' + presents.map((entree) =>
              (entree.getAttribute('type') || 'text') +
              (entree.getAttribute('name') ? ' name=' + entree.getAttribute('name') : '') +
              (entree.disabled ? ' [désactivé]' : '')
            ).slice(0, 3).join(' | ')
          : 'aucun champ de saisie dans la page pour l’instant';
        if (etat !== dernierEtat) {
          dernierEtat = etat;
          journal(etat, 'attente');
        }
        return null;
      }, 45000);
      if (!username) {
        journal('Aucun champ identifiant après 45 s', 'erreur');
        await report(isManualChallenge() ? 'manual' : 'failed',
          isManualChallenge() ? 'Vérification manuelle requise' : 'Champ identifiant introuvable');
        return;
      }
      journal(
        'Champ identifiant trouvé : ' +
        (username.getAttribute('type') || 'text') +
        (username.getAttribute('name') ? ' name=' + username.getAttribute('name') : '') +
        (username.getAttribute('autocomplete') ? ' autocomplete=' + username.getAttribute('autocomplete') : ''),
        'ok'
      );
      if (!await saisirEtVerifier(() => findVisible(CHAMPS_IDENTIFIANT), credentials.username, 'Pseudo')) {
        await report('failed', 'Le champ identifiant est reste inactif');
        return;
      }
      // Selon l'ecran servi par X, le bouton s'appelle Next, Suivant ou
      // Continue. Ne connaitre que les deux premiers suffisait a bloquer la
      // connexion sur l'ecran d'onboarding.
      if (!clickButton(['next', 'suivant', 'continue', 'continuer'])) pressEnter(username);

      await report('entering-password', 'Attente du champ mot de passe');
      // Meme raison que pour l'identifiant : le nom du champ change selon
      // l'ecran. Le type password, lui, ne change jamais.
      const CHAMPS_MOT_DE_PASSE = [
        'input[name="password"]',
        'input[autocomplete="current-password"]',
        'input[type="password"]',
      ];
      let etatMotDePasse = '';
      const passwordState = await waitFor(() => {
        const password = findVisible(CHAMPS_MOT_DE_PASSE);
        if (password) return { password };
        if (isManualChallenge()) return { manual: true };
        const presents = Array.from(document.querySelectorAll('input')).filter(visible);
        const etat = presents.length
          ? 'J’attends le mot de passe — ' + presents.length + ' champ(s) : ' + presents.map((entree) =>
              (entree.getAttribute('type') || 'text') +
              (entree.getAttribute('name') ? ' name=' + entree.getAttribute('name') : '') +
              (entree.disabled ? ' [désactivé]' : '')
            ).slice(0, 3).join(' | ')
          : 'J’attends le mot de passe — aucun champ dans la page';
        if (etat !== etatMotDePasse) {
          etatMotDePasse = etat;
          journal(etat, 'attente');
        }
        return null;
      }, 30000);
      if (!passwordState || passwordState.manual) {
        await report(passwordState?.manual ? 'manual' : 'failed',
          passwordState?.manual ? 'Vérification manuelle requise' : 'Champ mot de passe introuvable');
        return;
      }
      journal(
        'Champ mot de passe trouvé : ' +
        (passwordState.password.getAttribute('type') || 'text') +
        (passwordState.password.getAttribute('name')
          ? ' name=' + passwordState.password.getAttribute('name')
          : ''),
        'ok'
      );
      if (!await saisirEtVerifier(
        () => findVisible(CHAMPS_MOT_DE_PASSE), credentials.password, 'Mot de passe'
      )) {
        await report('failed', 'Le champ mot de passe est reste inactif');
        return;
      }
      if (!clickButton(['log in', 'sign in', 'se connecter', 'connexion', 'continue', 'continuer'])) {
        pressEnter(passwordState.password);
      }

      await report('waiting', 'Vérification de la connexion');
      // L'ecran du code se reconnait d'abord a son adresse : X y met
      // two_factor_code, quelle que soit la langue et quel que soit le texte
      // affiche. Le 16 aout 2026, exiger les mots « authentication code » a
      // fait manquer cet ecran -- la connexion attendait devant le bon
      // formulaire sans le voir.
      const ecranDuCode = () =>
        /two[_-]?factor|login_verification|ocfEnterText|challenge/i.test(location.href) ||
        /authentication code|verification code|code de v[eé]rification|code generator|authentification|application d.authentification|enter the code|saisis le code|entrez le code/i.test(pageText());
      let etatVerification = '';
      const afterPassword = await waitFor(() => {
        if (isHome()) return { success: true };
        // Le champ du code est protege par la lecture du texte de la page,
        // juste en dessous : on peut donc elargir sans risque de confusion.
        const otp = findVisible([
          'input[data-testid="ocfEnterTextTextInput"]',
          'input[autocomplete="one-time-code"]',
          'input[inputmode="numeric"]',
          'input[name="text"]',
          'input[type="text"]'
        ]);
        if (otp && ecranDuCode()) {
          return { otp };
        }
        if (isManualChallenge()) return { manual: true };
        if (/wrong password|incorrect password|could not log you in|mot de passe incorrect/.test(pageText())) {
          return { failed: true };
        }
        // Rester muet quarante-cinq secondes ne dit pas devant quoi on attend.
        const etat = 'J’attends la suite — ' + location.pathname + location.hash.slice(0, 40) +
          ' — ' + (otp ? 'un champ possible pour le code' : 'aucun champ de code') +
          (ecranDuCode() ? ', écran de code reconnu' : ', écran non reconnu');
        if (etat !== etatVerification) {
          etatVerification = etat;
          journal(etat, 'attente');
        }
        return null;
      }, 45000);
      if (afterPassword?.success) {
        await report('success', 'Connexion X confirmée');
        return;
      }
      if (!afterPassword || afterPassword.manual || afterPassword.failed || !afterPassword.otp) {
        await report(afterPassword?.manual ? 'manual' : 'failed',
          afterPassword?.manual ? 'Vérification manuelle requise' : 'Connexion X non confirmée');
        return;
      }

      await report('entering-totp', 'Génération et saisie du code 2FA');
      // Le code est valable trente secondes : on le calcule au dernier moment,
      // juste avant d'ecrire, et on verifie qu'il est bien entre.
      journal('X demande le code 2FA', 'attente');
      let code2fa;
      try {
        code2fa = await totpCode(credentials.totpSecret);
      } catch {
        // Dire que la cle est en cause, plutot qu'un « echec inattendu ».
        journal('Clé 2FA illisible : ' + nettoyerSecret(credentials.totpSecret).length +
          ' caractères après nettoyage, alphabet inattendu', 'erreur');
        await report('failed', 'Clé 2FA illisible dans VA Manager');
        return;
      }
      // Le code est affiche pour pouvoir etre compare avec un generateur
      // exterieur : il ne vaut que trente secondes. La cle, elle, n'apparait
      // jamais.
      journal('Code calculé : ' + code2fa, 'info');
      const CHAMPS_CODE = [
        'input[data-testid="ocfEnterTextTextInput"]',
        'input[autocomplete="one-time-code"]',
        'input[inputmode="numeric"]',
        'input[name="text"]',
        'input[type="text"]',
      ];
      if (!await saisirEtVerifier(() => findVisible(CHAMPS_CODE), code2fa, 'Code 2FA')) {
        await report('failed', 'Le champ du code 2FA est reste inactif');
        return;
      }
      if (!clickButton(['next', 'suivant', 'verify', 'vérifier', 'continue', 'continuer'])) {
        pressEnter(afterPassword.otp);
      }
      const finalState = await waitFor(() => {
        if (isHome()) return 'success';
        if (isManualChallenge()) return 'manual';
        if (/incorrect|invalid|expired|wrong code|code erroné/.test(pageText())) return 'failed';
        return null;
      }, 45000);
      await report(
        finalState || 'failed',
        finalState === 'success'
          ? 'Connexion X et cookies confirmés'
          : finalState === 'manual'
            ? 'Vérification manuelle requise'
            : 'Code 2FA ou connexion non confirmé'
      );
    } catch {
      await report('failed', 'Échec inattendu de la connexion X');
    } finally {
      credentials.password = '';
      credentials.totpSecret = '';
      window.__spectraSessionImportRunning = false;
    }
  }
  // Le bandeau de consentement masque le formulaire de connexion. Un script
  // separe est cense l'ecarter, mais il vit dans une autre extension : s'il
  // n'est pas la, ou s'il arrive trop tard, la connexion attend dans le vide.
  // On le fait donc ici aussi, dans le script meme qui attend le formulaire.
  // On refuse toujours ce qui n'est pas necessaire.
  const REFUS = /refuse|reject|non[- ]?essential|non n[eé]cessaires|rechazar|recusar|rifiuta|ablehnen/i;
  const ACCEPTE = /accept|accepter|aceptar|aceitar|accetta|akzeptieren|tout autoriser|allow all/i;
  function ecarterBandeauCookies() {
    const boutons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible);
    const refuser = boutons.find((bouton) => REFUS.test(String(bouton.innerText || bouton.textContent || '').trim()));
    if (!refuser) return false;
    const bloc = refuser.closest('[role="region"]') ||
      refuser.closest('[data-testid="BottomBar"]') ||
      refuser.parentElement?.parentElement;
    const oppose = bloc
      ? Array.from(bloc.querySelectorAll('button, [role="button"]')).filter(visible)
          .some((bouton) => ACCEPTE.test(String(bouton.innerText || bouton.textContent || '').trim()))
      : false;
    if (!oppose) return false;
    pointRouge(refuser);
    journal('Bandeau cookies : je refuse les cookies non nécessaires', 'ok');
    refuser.click();
    return true;
  }

  // Le panneau reapparait a chaque page : X en change plusieurs fois pendant
  // une connexion, et le journal doit rester lisible d'un bout a l'autre.
  try { dessinerPanneau(); } catch {}
  journal('Script de connexion en place sur ' + location.pathname, 'info');

  // La derniere etape reussie fait changer de page : le script qui suivait la
  // connexion meurt avec l'ancienne, et personne n'annonce l'arrivee. Spectra
  // attendait alors jusqu'au delai de trois minutes et notait « connexion non
  // confirmee », alors que le compte etait connecte depuis longtemps.
  //
  // C'est le script recharge sur la nouvelle page qui le constate et le dit.
  if (isHome()) {
    journal('Compte connecté — page ' + location.pathname, 'ok');
    report('success', 'Connexion X confirmée').catch(() => {});
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'spectra:session-import-credentials' && message.credentials) {
      journal('Identifiants reçus de Spectra', 'ok');
      run(message.credentials);
    }
  });
})();`
        );
      }

      // Prefer the last positively authenticated X snapshot. A current snapshot
      // without auth may come from a transient logout or another stale PC.
      const syncedCookiesPath = path.join(profilePath, 'synced_cookies.json');
      const authenticatedCookiesPath = path.join(profilePath, 'authenticated_cookies.json');
      let hasStagedCookies = false;
      const syncedIsAuthenticated = fs.existsSync(syncedCookiesPath) &&
        this.fileHasAuthenticatedXSession(syncedCookiesPath);
      const protectedIsAuthenticated = fs.existsSync(authenticatedCookiesPath) &&
        this.fileHasAuthenticatedXSession(authenticatedCookiesPath);
      const syncedIsNewer = syncedIsAuthenticated && protectedIsAuthenticated &&
        fs.statSync(syncedCookiesPath).mtimeMs >= fs.statSync(authenticatedCookiesPath).mtimeMs;
      const cookieImportPath = syncedIsAuthenticated && (!protectedIsAuthenticated || syncedIsNewer)
        ? syncedCookiesPath
        : protectedIsAuthenticated
          ? authenticatedCookiesPath
          : syncedCookiesPath;
      if (fs.existsSync(cookieImportPath)) {
        try {
          const cookies = fs.readFileSync(cookieImportPath, 'utf8');
          const parsedCookies = JSON.parse(cookies);
          hasStagedCookies = Array.isArray(parsedCookies) && parsedCookies.length > 0;
          fs.writeFileSync(path.join(cookieSyncPath, 'cookies.json'), cookies);
          console.log(
            `[CookieSync] Loaded ${cookieImportPath === authenticatedCookiesPath ? 'protected authenticated' : 'current'} cookies for import`
          );
        } catch {}
      } else {
        fs.writeFileSync(path.join(cookieSyncPath, 'cookies.json'), '[]');
      }

      // Le navigateur garde sa propre base de cookies dans Default/Network.
      // Quand elle est plus recente que l'instantane, la session vivante vaut
      // mieux que la sauvegarde : on ne restaure alors que ce qui manque, au
      // lieu de tout remplacer. Sans cette regle, un instantane perime ecrase
      // un auth_token frais et deconnecte le compte -- constate le 12 aout 2026
      // avec une sauvegarde du 10 aout reinjectee sur une session du jour.
      //
      // L'import de session est une demande explicite : il remplace toujours.
      const baseCookiesChrome = path.join(profilePath, 'Default', 'Network', 'Cookies');
      let modeImportCookies: 'remplacer' | 'completer' = 'remplacer';
      try {
        if (
          !sessionImportAttemptId &&
          fs.existsSync(baseCookiesChrome) &&
          fs.existsSync(cookieImportPath) &&
          fs.statSync(baseCookiesChrome).mtimeMs > fs.statSync(cookieImportPath).mtimeMs
        ) {
          modeImportCookies = 'completer';
        }
      } catch {}
      if (modeImportCookies === 'completer') {
        console.log(
          '[CookieSync] Cookies du navigateur plus recents que la sauvegarde: restauration des manquants seulement'
        );
      }

      // Le script genere prend la main immediatement, sans attendre que la
      // version precedente veuille bien s'arreter.
      //
      // Il porte l'adresse du serveur local de Spectra, qui change a chaque
      // demarrage. Quand il est reecrit, le navigateur installe la nouvelle
      // version mais la laisse en attente : l'ancienne reste active tant
      // qu'elle vit. Or l'ancienne reessaie son envoi toutes les secondes, ce
      // qui la maintient eveillee -- elle empeche donc son propre
      // remplacement, indefiniment.
      //
      // Mesure du 15 aout 2026 : quatre instances tournaient encore avec le
      // script d'une session precedente, adressant un port ferme depuis. Leurs
      // cookies n'etaient plus sauvegardes, leur demarrage n'aboutissait pas,
      // et elles ne faisaient plus aucun RT. Le navigateur etait pourtant neuf
      // et le fichier sur disque correct : seule la version en memoire etait
      // perimee.
      fs.writeFileSync(path.join(cookieSyncPath, 'background.js'),
`self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (evenement) => evenement.waitUntil(self.clients.claim()));

const PROFILE_ID = ${JSON.stringify(options.profileId)};
const PROFILE_NAME = ${JSON.stringify(options.profileName)};
const LAUNCH_ID = ${JSON.stringify(autoStartLaunchId)};
const OPEN_POST_MODE = ${JSON.stringify(Boolean(targetTweetUrl))};
const HAS_STAGED_COOKIES = ${JSON.stringify(hasStagedCookies)};
const COOKIE_IMPORT_MODE = ${JSON.stringify(modeImportCookies)};
const SESSION_IMPORT_ATTEMPT_ID = ${JSON.stringify(sessionImportAttemptId)};
const SESSION_IMPORT_MODE = Boolean(SESSION_IMPORT_ATTEMPT_ID);
/* Mass post ou branding : Spectra pilote, l'utilisateur ne touche a rien.
   Sans ce marqueur, l'extension restait en mode manuel et personne ne
   renvoyait le navigateur sur X -- il demeurait sur la page vide ouverte
   pour poser les cookies. */
const PUBLICATION_MODE = ${JSON.stringify(Boolean(options.massPost || options.branding))};
const MANAGED_STARTUP_MODE =
  OPEN_POST_MODE || Boolean(LAUNCH_ID) || SESSION_IMPORT_MODE || PUBLICATION_MODE;
/* Volontairement sans PUBLICATION_MODE : fermer les autres onglets est utile
   pour un Open Post, mais une publication n'a aucune raison de toucher a ce
   que l'utilisateur avait ouvert. */
const ENFORCE_SINGLE_TAB = OPEN_POST_MODE || Boolean(LAUNCH_ID);
const SERVER = 'http://127.0.0.1:${this.localServerConfig?.port || 0}';
const SERVER_TOKEN = ${JSON.stringify(this.localServerConfig?.token || '')};

/* Temoin de vie, pose le 23 aout 2026.
   Un mass post laissait les profils du VPS 128 sur la page vide, sans qu'une
   seule etape soit journalisee. Impossible de savoir si le service worker ne
   demarrait pas, ou s'il demarrait et echouait plus loin : dans les deux cas
   le journal restait muet. Cette ligne repond a la question -- elle part
   avant tout le reste, sans dependre de rien. */
reportLifecycleEvent('worker-demarre', {
  openPost: OPEN_POST_MODE,
  publication: PUBLICATION_MODE,
  cookiesEnReserve: HAS_STAGED_COOKIES,
  pilote: MANAGED_STARTUP_MODE,
}).catch(() => {});

let bootstrapPromise = null;
let bootstrapComplete = false;
let exportInProgress = false;
let exportAgain = false;
let exportTimer = null;
let authenticationRetryTimer = null;
let authenticatedSnapshotConfirmed = false;
let retainedTabId = null;
let cookiesImported = false;
let cookieImportPromise = null;
let venusConfirmationReported = false;
let openPostCompleted = false;
let sessionImportStarted = false;
const BOOTSTRAP_ATTEMPTS = 5;
const RETRY_DELAYS = [1000, 2000, 4000, 8000, 12000];
const WATCHDOG_DEADLINE = Date.now() + (OPEN_POST_MODE ? 120000 : 60000);

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const tabUrl = (tab) => String(tab?.pendingUrl || tab?.url || '');
const isXTab = (tab) => /^https:\\/\\/(?:www\\.)?(?:x|twitter)\\.com\\//i.test(tabUrl(tab));
const isStartupJunkTab = (tab) => {
  const url = tabUrl(tab);
  return url === 'about:blank' ||
    /^chrome-extension:\\/\\/[^/]+\\/html\\/initialSetup\\.html(?:[?#]|$)/i.test(url);
};

async function reportLaunchStatus(status, details = {}) {
  const response = await fetch(SERVER + '/api/launch-status', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + SERVER_TOKEN
    },
    body: JSON.stringify({ profileId: PROFILE_ID, launchId: LAUNCH_ID, status, details }),
  });
  if (!response.ok) throw new Error('Launch status server returned ' + response.status);
}

async function reportLifecycleEvent(event, details = {}) {
  try {
    await fetch(SERVER + '/api/lifecycle-event', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + SERVER_TOKEN
      },
      body: JSON.stringify({
        profileId: PROFILE_ID,
        launchId: LAUNCH_ID,
        event,
        details,
      }),
    });
  } catch {}
}

if (chrome.tabs.onRemoved?.addListener) {
  chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    reportLifecycleEvent('tab-removed', {
      tabId,
      windowId: removeInfo?.windowId,
      isWindowClosing: removeInfo?.isWindowClosing === true,
    });
  });
}

if (chrome.windows?.onRemoved?.addListener) {
  chrome.windows.onRemoved.addListener((windowId) => {
    reportLifecycleEvent('window-removed', { windowId });
  });
}

async function reportSessionImportStatus(status, message = '') {
  const response = await fetch(SERVER + '/api/session-import-status', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + SERVER_TOKEN
    },
    body: JSON.stringify({
      profileId: PROFILE_ID,
      attemptId: SESSION_IMPORT_ATTEMPT_ID,
      status,
      message,
    }),
  });
  if (!response.ok) throw new Error('Session import status server returned ' + response.status);
}

async function startSessionImport(tabId) {
  if (!SESSION_IMPORT_MODE || sessionImportStarted) return;
  sessionImportStarted = true;
  try {
    const response = await fetch(
      SERVER + '/api/session-import-credentials?attemptId=' +
      encodeURIComponent(SESSION_IMPORT_ATTEMPT_ID) +
      '&profileId=' + encodeURIComponent(PROFILE_ID),
      { headers: { 'Authorization': 'Bearer ' + SERVER_TOKEN } }
    );
    if (!response.ok) throw new Error('serveur ' + response.status);
    const credentials = await response.json();
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        // Le script est aussi declare dans le manifeste, mais rien ne dit qu'il
        // soit deja en place dans CET onglet quand le worker lui parle : la
        // page peut encore charger, ou avoir change d'adresse. On l'injecte
        // donc nous-memes avant de parler, comme pour Open Post. Le script se
        // protege lui-meme contre une double installation.
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['session-import-login.js'],
        }).catch(() => {});
        await chrome.tabs.sendMessage(tabId, {
          type: 'spectra:session-import-credentials',
          credentials,
        });
        credentials.password = '';
        credentials.totpSecret = '';
        return;
      } catch {
        await wait(500);
      }
    }
    throw new Error('la page de connexion n a jamais repondu');
  } catch (error) {
    // Dire ce qui a lache : sans cela, une adresse injoignable, un jeton refuse
    // et un onglet muet donnaient le meme message, et on ne savait pas ou
    // chercher.
    await reportSessionImportStatus(
      'failed',
      'Connexion X impossible a demarrer : ' + String(error?.message || error)
    ).catch(() => {});
  }
}

async function requestProfileClose(source) {
  if (!OPEN_POST_MODE) {
    throw new Error('Profile close is only available in OpenPost mode');
  }
  await flushCookiesBeforeClose();
  const response = await fetch(SERVER + '/api/close-profile', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + SERVER_TOKEN
    },
    body: JSON.stringify({ profileId: PROFILE_ID }),
  });
  if (!response.ok) throw new Error('Close-profile server returned ' + response.status);
  openPostCompleted = true;
  chrome.alarms.clear('spectra-startup-watchdog').catch(() => {});
  console.log('[Spectra OpenPost] Main-process close requested via ' + source);
}

// Import cookies from cookies.json at startup
async function importCookies() {
  try {
    const response = await fetch(chrome.runtime.getURL('cookies.json'));
    if (!response.ok) return;
    const cookies = await response.json();
    if (!Array.isArray(cookies) || cookies.length === 0) return;

    // En mode "completer", le navigateur a des donnees plus fraiches que la
    // sauvegarde : on ne touche pas a ce qu'il possede deja, on ne remet que
    // les cookies absents. Ecraser un auth_token vivant par un ancien
    // deconnecte le compte, et melanger deux jeux (auth_token ancien, ct0
    // recent) le deconnecte aussi.
    const dejaPresents = new Set();
    if (COOKIE_IMPORT_MODE === 'completer') {
      try {
        const actuels = await chrome.cookies.getAll({});
        for (const c of actuels) {
          dejaPresents.add(c.name + '|' + c.domain + '|' + (c.path || '/'));
        }
      } catch (e) {}
    }

    let imported = 0;
    let conserves = 0;
    for (const c of cookies) {
      if (dejaPresents.has(c.name + '|' + c.domain + '|' + (c.path || '/'))) {
        conserves++;
        continue;
      }
      try {
        const details = {
          url: 'http' + (c.secure ? 's' : '') + '://' + (c.domain || '').replace(/^\\./, '') + (c.path || '/'),
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          secure: c.secure || false,
          httpOnly: c.httpOnly || false,
          sameSite: c.sameSite === 'None' ? 'no_restriction' : (c.sameSite || 'lax').toLowerCase(),
        };
        if (c.expires && c.expires > 0) details.expirationDate = c.expires;
        else if (c.expirationDate && c.expirationDate > 0) details.expirationDate = c.expirationDate;
        await Promise.race([
          chrome.cookies.set(details),
          wait(1500).then(() => {
            throw new Error('Cookie import timed out: ' + c.name);
          }),
        ]);
        imported++;
      } catch (e) {}
    }
    console.log(
      '[CookieSync] Imported ' + imported + '/' + cookies.length + ' cookies' +
      (conserves ? ' (' + conserves + ' conserves du navigateur, plus recents)' : '')
    );
  } catch (e) {}
}

async function ensureCookiesImported() {
  if (cookiesImported) return;
  if (!cookieImportPromise) {
    cookieImportPromise = importCookies()
      .then(() => {
        cookiesImported = true;
      })
      .finally(() => {
        cookieImportPromise = null;
      });
  }
  await cookieImportPromise;
}

// L'adresse de depart est inscrite directement dans ce script par Spectra,
// juste apres son ecriture. La faire transiter par un second fichier ajoutait
// une lecture, donc un point de rupture : mesure du 15 aout 2026, cinq
// instances echouaient a chaque tour sur "Failed to fetch" en lisant
// start_url.json, alors que la page etait chargee et qu'un seul onglet etait
// ouvert. Le demarrage n'aboutissait jamais, donc le script qui aime et
// republie n'etait jamais injecte.
//
// La lecture du fichier reste en secours, pour un profil lance par une version
// anterieure de Spectra dont le script n'aurait pas la valeur integree.
const DEMARRAGE_INTEGRE = /*SPECTRA_DEMARRAGE*/null;

async function lireDemarrage() {
  if (DEMARRAGE_INTEGRE && typeof DEMARRAGE_INTEGRE.startUrl === 'string') {
    return DEMARRAGE_INTEGRE;
  }
  console.warn('[Spectra AutoStart] Adresse de depart non integree, lecture du fichier');
  const response = await fetch(chrome.runtime.getURL('start_url.json'));
  if (!response.ok) throw new Error('start_url.json returned ' + response.status);
  return response.json();
}

// Une etape du demarrage pouvait attendre indefiniment : ni erreur, ni trace,
// et le profil restait inerte jusqu'a sa fermeture forcee au bout de soixante
// secondes. Mesure du 15 aout 2026 : quatre instances ne faisaient plus aucun
// RT, sans qu'aucun journal ne dise pourquoi, precisement parce qu'un blocage
// silencieux ne laisse rien derriere lui.
//
// Chaque etape porte donc desormais un delai et son nom. Passe ce delai, elle
// echoue -- et un echec, lui, est enregistre.
/**
 * Journal du demarrage, lisible a l'ecran et dans la telemetrie.
 *
 * La chaine qui mene au tweet compte trois etapes -- import des cookies,
 * ouverture de l'adresse, injection du script -- et aucune n'etait tracee.
 * Une instance qui echoue restait 52 secondes sur une page blanche sans qu'on
 * puisse dire laquelle des trois avait cale. C'est exactement le temps cumule
 * des delais d'attente.
 */
const journalDemarrage = [];

function noterEtape(texte, ton = 'info') {
  const ligne = { heure: new Date().toISOString().slice(11, 19), texte, ton };
  journalDemarrage.push(ligne);
  if (journalDemarrage.length > 60) journalDemarrage.shift();
  console.log('[Spectra Demarrage] ' + texte);
  try { reportLifecycleEvent('demarrage-etape', { texte, ton }); } catch {}
}

async function avecDelai(nom, promesse, millisecondes = 12000) {
  let minuteur;
  const debut = Date.now();
  noterEtape(nom + ' : début', 'attente');
  try {
    const valeur = await Promise.race([
      promesse,
      new Promise((_, rejeter) => {
        minuteur = setTimeout(
          () => rejeter(new Error('Etape "' + nom + '" bloquee au-dela de ' + millisecondes + ' ms')),
          millisecondes
        );
      }),
    ]);
    noterEtape(nom + ' : fait en ' + (Date.now() - debut) + ' ms', 'ok');
    return valeur;
  } catch (erreur) {
    noterEtape(
      nom + ' : ÉCHEC après ' + (Date.now() - debut) + ' ms — ' +
      String(erreur?.message || erreur).slice(0, 120),
      'erreur'
    );
    throw erreur;
  } finally {
    clearTimeout(minuteur);
  }
}

async function openStartUrl() {
  try {
    const { startUrl, closeOtherTabs, likeTargetPost } =
      await avecDelai('lecture-adresse', lireDemarrage(), 5000);
    if (!/^https?:\\/\\//i.test(startUrl || '')) throw new Error('Invalid startup URL');

    const initialTabs = await avecDelai('liste-onglets', chrome.tabs.query({}), 8000);
    let target = closeOtherTabs && LAUNCH_ID
      ? initialTabs.find((tab) => tab.id && isXTab(tab))
      : initialTabs.find((tab) => tab.id && tabUrl(tab).startsWith(startUrl));

    if (!target?.id) {
      target = await avecDelai(
        'creation-onglet',
        chrome.tabs.create({ url: startUrl, active: true }),
        15000
      );
      if (!target?.id) throw new Error('Dedicated startup tab was not created');
      console.log('[Spectra AutoStart] X tab created: ' + target.id);
    } else {
      await avecDelai(
        'navigation-onglet',
        chrome.tabs.update(target.id, { url: startUrl, active: true }),
        15000
      );
      console.log('[Spectra AutoStart] Existing X tab retained: ' + target.id);
    }

    retainedTabId = target.id;
    console.log('[Spectra AutoStart] Profile ' + PROFILE_ID + ' (' + PROFILE_NAME + ')');

    const closeOtherProfileTabs = async () => {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (!tab.id || tab.id === retainedTabId) continue;
        try {
          await chrome.tabs.remove(tab.id);
          console.log('[Spectra AutoStart] Extra tab closed: ' + tab.id + ' ' + tabUrl(tab));
        } catch (error) {
          const stillExists = await chrome.tabs.get(tab.id).catch(() => null);
          if (stillExists) throw error;
        }
      }
      const remaining = await chrome.tabs.query({});
      const extras = remaining.filter((tab) => tab.id && tab.id !== retainedTabId);
      if (extras.length > 0) {
        throw new Error('Extra tabs remain after cleanup: ' + extras.map((tab) => tab.id).join(','));
      }
    };

    if (closeOtherTabs) await closeOtherProfileTabs();

    const loadDeadline = Date.now() + 30000;
    let retained = null;
    while (Date.now() < loadDeadline) {
      retained = await chrome.tabs.get(retainedTabId).catch(() => null);
      if (!retained) throw new Error('Retained startup tab disappeared');
      if (retained.status === 'complete' && isXTab(retained)) break;
      await wait(250);
    }
    if (!retained || retained.status !== 'complete' || !isXTab(retained)) {
      throw new Error('Retained X tab did not finish loading');
    }
    console.log('[Spectra AutoStart] X tab loaded: ' + retainedTabId);

    await wait(500);
    if (closeOtherTabs) await closeOtherProfileTabs();

    await chrome.scripting.executeScript({
      target: { tabId: retainedTabId },
      world: 'MAIN',
      func: (launchId, tabId) => {
        sessionStorage.setItem('spectra:startup-tabs-ready:' + launchId, String(tabId));
      },
      args: [LAUNCH_ID, retainedTabId],
    });
    console.log('[Spectra AutoStart] startup-tabs-ready written for tab: ' + retainedTabId);

    const confirmedTab = await chrome.tabs.get(retainedTabId).catch(() => null);
    const finalTabs = await chrome.tabs.query({});
    if (
      !confirmedTab ||
      confirmedTab.status !== 'complete' ||
      !isXTab(confirmedTab) ||
      (closeOtherTabs && finalTabs.some((tab) => tab.id !== retainedTabId))
    ) {
      throw new Error('Startup tab confirmation failed');
    }

    return retainedTabId;
  } catch (error) {
    console.error('[Spectra AutoStart] Bootstrap failed: ' + (error?.message || error));
    throw error;
  }
}

async function resumeManualStartupAfterCookieImport() {
  if (!HAS_STAGED_COOKIES || MANAGED_STARTUP_MODE) return null;

  const { startUrl } = await lireDemarrage();
  if (!/^https?:\\/\\//i.test(startUrl || '')) throw new Error('Invalid startup URL');

  // A manual launch may restore several user tabs. Only reuse Spectra's
  // temporary blank/setup tab and never close or replace an existing user tab.
  const tabs = await chrome.tabs.query({});
  const temporaryTab = tabs.find((tab) => tab.id && isStartupJunkTab(tab));
  if (!temporaryTab?.id) {
    console.log('[Spectra FastStart] Existing manual session retained');
    return null;
  }

  await chrome.tabs.update(temporaryTab.id, { url: startUrl, active: true });
  console.log('[Spectra FastStart] Temporary tab resumed immediately: ' + temporaryTab.id);
  return temporaryTab.id;
}

function bootstrap() {
  if (bootstrapComplete && retainedTabId) return Promise.resolve(retainedTabId);
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      let lastError = null;
      for (let attempt = 1; attempt <= BOOTSTRAP_ATTEMPTS; attempt++) {
        console.log('[Spectra AutoStart] Bootstrap attempt ' + attempt + '/' + BOOTSTRAP_ATTEMPTS);
        try {
          // La restauration des cookies passe par un appel du navigateur par
          // cookie, chacun borne a une seconde et demie. Un profil charge peut
          // donc y passer plusieurs minutes, alors que Spectra ferme l'instance
          // au bout d'une seule. Mieux vaut une session partiellement restauree
          // qu'un profil qui ne fait rien : les cookies vitaux sont ecrits en
          // premier, et la base du navigateur garde souvent la session.
          await avecDelai('import-cookies', ensureCookiesImported(), 20000);
          const tabId = await avecDelai('ouverture-adresse', openStartUrl(), 40000);
          if (!tabId) throw new Error('openStartUrl returned no retainedTabId');
          retainedTabId = tabId;
          if (LAUNCH_ID) await reportLaunchStatus('bootstrap-confirmed', { tabId });
          bootstrapComplete = true;
          noterEtape('Onglet prêt sur le tweet (' + tabId + ')', 'ok');
          console.log('[Spectra AutoStart] Bootstrap confirmed: ' + tabId);
          return tabId;
        } catch (error) {
          bootstrapComplete = false;
          lastError = error;
          console.error('[Spectra AutoStart] Bootstrap failed: ' + (error?.message || error));
          // La raison de l'echec ne partait que dans la console du service
          // worker, que personne ne lit. Or c'est elle qui distingue une page
          // qui ne finit pas de charger d'un onglet en trop -- deux causes
          // opposees pour le meme symptome : la page se recharge en boucle et
          // le script qui aime et republie n'est jamais injecte.
          const etatOnglets = await chrome.tabs.query({}).catch(() => []);
          const trace = {
            heure: new Date().toISOString(),
            tentative: attempt,
            raison: String(error?.message || error).slice(0, 200),
            onglets: etatOnglets.length,
            adresses: etatOnglets.map((tab) => tabUrl(tab).slice(0, 80)).slice(0, 5),
            etats: etatOnglets.map((tab) => tab.status || '?').slice(0, 5),
          };
          reportLifecycleEvent('bootstrap-failed', trace);
          if (attempt < BOOTSTRAP_ATTEMPTS || Date.now() <= WATCHDOG_DEADLINE) {
            const delay = RETRY_DELAYS[attempt - 1] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
            console.log('[Spectra AutoStart] Bootstrap retry scheduled in ' + delay + 'ms');
            await wait(delay);
          }
        }
      }
      throw lastError || new Error('Bootstrap exhausted');
    })().finally(() => {
      bootstrapPromise = null;
    });
  }
  return bootstrapPromise;
}

async function startOpenPostActions(tabId) {
  if (!OPEN_POST_MODE || !tabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['open-post-actions.js'],
    });
    await reportLifecycleEvent('open-post-actions-injected', { tabId });
    noterEtape('Script d’actions injecté — à lui de jouer', 'ok');
    console.log('[Spectra OpenPost] Action script injected explicitly into tab: ' + tabId);
  } catch (error) {
    await reportLifecycleEvent('open-post-actions-injection-failed', {
      tabId,
      raison: String(error?.message || error).slice(0, 240),
    });
    console.error('[Spectra OpenPost] Action script injection failed: ' + (error?.message || error));
    throw error;
  }
}

async function runStartupWatchdog() {
  if (openPostCompleted || Date.now() > WATCHDOG_DEADLINE) {
    chrome.alarms.clear('spectra-startup-watchdog').catch(() => {});
    return;
  }
  try {
    if (ENFORCE_SINGLE_TAB) {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (
          !retainedTabId ||
          !tab.id ||
          tab.id === retainedTabId ||
          (!bootstrapComplete && !isStartupJunkTab(tab))
        ) continue;
        await chrome.tabs.remove(tab.id).catch(() => {});
        console.log('[Spectra AutoStart] Extra tab closed: ' + tab.id + ' ' + tabUrl(tab));
      }
    }

    if (bootstrapComplete) {
      const retained = retainedTabId
        ? await chrome.tabs.get(retainedTabId).catch(() => null)
        : null;
      if (!retained || !isXTab(retained)) {
        bootstrapComplete = false;
        retainedTabId = null;
        console.warn('[Spectra AutoStart] Watchdog found no retained X tab');
      } else if (OPEN_POST_MODE) {
        const results = await chrome.scripting.executeScript({
          target: { tabId: retainedTabId },
          func: () => document.documentElement.dataset.spectraOpenPostComplete === '1',
        }).catch(() => []);
        if (results[0]?.result === true) {
          console.log('[Spectra OpenPost] Completion marker detected');
          await requestProfileClose('watchdog');
          return;
        }
      } else if (LAUNCH_ID && !venusConfirmationReported) {
        const results = await chrome.scripting.executeScript({
          target: { tabId: retainedTabId },
          world: 'MAIN',
          func: (launchId) => ({
            confirmed: sessionStorage.getItem('spectra:autostart-confirmed:' + launchId) === '1',
            manualPause: sessionStorage.getItem('spectra:autostart-manual-pause:' + launchId) === '1',
          }),
          args: [LAUNCH_ID],
        }).catch(() => []);
        const status = results[0]?.result;
        if (status?.confirmed) {
          await reportLaunchStatus('venus-confirmed', { tabId: retainedTabId });
          venusConfirmationReported = true;
          console.log('[Spectra AutoStart] VenusBot confirmation forwarded');
        } else if (status?.manualPause) {
          await reportLaunchStatus('manual-pause-preserved', { tabId: retainedTabId });
          venusConfirmationReported = true;
        }
      }
    }

    if (!openPostCompleted && !bootstrapComplete && !bootstrapPromise) {
      bootstrap().catch((error) => {
        console.error('[Spectra AutoStart] Watchdog bootstrap failed:', error);
      });
    }
  } catch (error) {
    console.warn('[Spectra AutoStart] Watchdog error:', error);
  } finally {
    if (Date.now() <= WATCHDOG_DEADLINE) setTimeout(runStartupWatchdog, 1000);
  }
}

chrome.tabs.onCreated.addListener((tab) => {
  if (
    ENFORCE_SINGLE_TAB &&
    Date.now() <= WATCHDOG_DEADLINE &&
    retainedTabId &&
    tab?.id &&
    tab.id !== retainedTabId
  ) {
    chrome.tabs.remove(tab.id).then(() => {
      console.log('[Spectra AutoStart] Extra tab closed: ' + tab.id + ' ' + tabUrl(tab));
    }).catch(() => {});
  }
});

chrome.runtime.onMessage?.addListener((message, sender, sendResponse) => {
  if (OPEN_POST_MODE && message?.type === 'spectra:open-post-telemetry') {
    const stage = typeof message.stage === 'string'
      ? message.stage.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48)
      : '';
    if (stage) {
      reportLifecycleEvent('open-post-' + stage, {
        tabId: sender.tab?.id,
        ...(message.details && typeof message.details === 'object' ? message.details : {}),
      });
    }
    sendResponse({ accepted: Boolean(stage) });
    return;
  }
  // La page de demarrage vient chercher le journal pour l'afficher : c'est le
  // seul ecran visible quand la page X ne se charge jamais.
  if (message?.type === 'spectra:journal-demarrage') {
    sendResponse({ lignes: journalDemarrage });
    return;
  }

  if (OPEN_POST_MODE && message?.type === 'spectra:open-post-bootstrap-page') {
    reportLifecycleEvent('open-post-bootstrap-page', { tabId: sender.tab?.id });
    noterEtape('Page de démarrage ouverte — je prépare la session', 'info');
    sendResponse({ accepted: true });
    bootstrap()
      .then((tabId) => startOpenPostActions(tabId))
      .catch((error) => {
        reportLifecycleEvent('open-post-bootstrap-page-failed', {
          error: String(error?.message || error).slice(0, 240),
        });
        console.error('[Spectra OpenPost] Explicit bootstrap failed:', error);
      });
    return;
  }
  if (message?.type === 'spectra:session-import-status' && SESSION_IMPORT_MODE) {
    reportSessionImportStatus(message.status, message.message)
      .then(() => sendResponse({ accepted: true }))
      .catch(() => sendResponse({ accepted: false }));
    return true;
  }
  if (
    !OPEN_POST_MODE ||
    message?.type !== 'spectra:open-post-actions-complete' ||
    !sender.tab?.id
  ) return;
  sendResponse({ accepted: true });
  (async () => {
    openPostCompleted = true;
    chrome.alarms.clear('spectra-startup-watchdog').catch(() => {});
    console.log('[Spectra OpenPost] Actions finished; saving session before closing instance');
    try {
      await requestProfileClose('message');
    } catch (error) {
      if (typeof sender.tab.windowId === 'number') {
        await chrome.windows.remove(sender.tab.windowId);
      } else {
        throw error;
      }
    }
  })().catch((error) => {
    console.warn('[Spectra OpenPost] Could not close completed instance:', error);
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (MANAGED_STARTUP_MODE && alarm.name === 'spectra-startup-watchdog') runStartupWatchdog();
  if (alarm.name === 'spectra-cookie-export') exportCookies();
});

// Export all cookies to local server
async function exportCookies() {
  if (exportInProgress) {
    exportAgain = true;
    return;
  }
  exportInProgress = true;
  try {
    const cookies = await chrome.cookies.getAll({});
    const response = await fetch(SERVER + '/api/save-cookies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SERVER_TOKEN },
      body: JSON.stringify({ profileId: PROFILE_ID, cookies }),
    });
    if (!response.ok) throw new Error('Cookie sync server returned ' + response.status);
    const result = typeof response.json === 'function'
      ? await response.json().catch(() => ({}))
      : {};
    if (result.authenticated === true) {
      authenticatedSnapshotConfirmed = true;
      if (authenticationRetryTimer) {
        clearTimeout(authenticationRetryTimer);
        authenticationRetryTimer = null;
      }
      console.log('[CookieSync] Authenticated X snapshot acknowledged by Spectra');
      if (result.notificationRequired === true) {
        await showAuthenticatedSnapshotConfirmation();
      }
    }
    console.log('[CookieSync] Exported ' + cookies.length + ' cookies');
  } catch (e) {
    console.warn('[CookieSync] Export failed', e);
    if (!authenticatedSnapshotConfirmed && !authenticationRetryTimer) {
      authenticationRetryTimer = setTimeout(() => {
        authenticationRetryTimer = null;
        exportCookies();
      }, 500);
    }
  } finally {
    exportInProgress = false;
    if (exportAgain) {
      exportAgain = false;
      scheduleExport(100);
    }
  }
}

async function flushCookiesBeforeClose() {
  if (exportTimer) {
    clearTimeout(exportTimer);
    exportTimer = null;
  }
  const deadline = Date.now() + 2000;
  while (exportInProgress && Date.now() < deadline) {
    await wait(25);
  }
  await exportCookies();
}

function scheduleExport(delay = 150) {
  if (exportTimer) clearTimeout(exportTimer);
  exportTimer = setTimeout(() => {
    exportTimer = null;
    exportCookies();
  }, delay);
}

async function showAuthenticatedSnapshotConfirmation() {
  if (OPEN_POST_MODE) return;
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs.filter((candidate) => candidate.id && isXTab(candidate))) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const existing = document.getElementById('spectra-session-saved-toast');
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.id = 'spectra-session-saved-toast';
        toast.textContent = '✓ Session X enregistrée';
        Object.assign(toast.style, {
          position: 'fixed',
          top: '20px',
          right: '20px',
          zIndex: '2147483647',
          padding: '12px 18px',
          borderRadius: '12px',
          background: 'rgba(15, 23, 42, 0.96)',
          border: '1px solid rgba(74, 222, 128, 0.55)',
          boxShadow: '0 12px 35px rgba(0, 0, 0, 0.35)',
          color: '#86efac',
          font: '600 14px/1.2 system-ui, sans-serif',
        });
        document.documentElement.appendChild(toast);
        window.setTimeout(() => toast.remove(), 4500);
      },
    }).catch(() => {});
  }
}

if (MANAGED_STARTUP_MODE) {
  chrome.alarms.create('spectra-startup-watchdog', {
    delayInMinutes: 0.5,
    periodInMinutes: 0.5,
  });
  bootstrap().then(async (tabId) => {
    await startSessionImport(tabId);
    await startOpenPostActions(tabId);
  }).catch(async (error) => {
    console.error('[Spectra AutoStart] Initial bootstrap exhausted:', error);
    // Ce chemin avale toute la mise en route : demarrage, import de session et
    // injection du script d'action. Le rapport part vers Spectra, qui le garde.
    await reportLifecycleEvent('startup-chain-broken', {
      raison: String(error?.message || error).slice(0, 240),
    });
  });
  runStartupWatchdog();
} else {
  importCookies()
    .then(async () => {
      cookiesImported = true;
      await resumeManualStartupAfterCookieImport();
    })
    .catch((error) => {
      console.warn('[Spectra FastStart] Cookie restore failed:', error);
    });
}
chrome.runtime.onStartup.addListener(() => {
  if (MANAGED_STARTUP_MODE) {
    bootstrap().catch((error) => console.error('[Spectra AutoStart] Startup bootstrap exhausted:', error));
  }
});
chrome.runtime.onInstalled.addListener(() => {
  if (MANAGED_STARTUP_MODE) {
    bootstrap().catch((error) => console.error('[Spectra AutoStart] Install bootstrap exhausted:', error));
  }
});
chrome.cookies.onChanged.addListener((changeInfo) => {
  const authenticationCookieChanged =
    changeInfo?.cookie?.name === 'auth_token' || changeInfo?.cookie?.name === 'ct0';
  if (authenticationCookieChanged) {
    exportCookies();
  } else {
    scheduleExport(150);
  }
});
chrome.windows?.onRemoved?.addListener(() => {
  flushCookiesBeforeClose().catch((error) => {
    console.warn('[CookieSync] Final window-close snapshot failed:', error);
  });
});
chrome.runtime.onSuspend.addListener(() => exportCookies());

// Frequent safety snapshot so every launch mode has a fresh portable session.
//
// Un service worker de manifeste 3 est mis en veille apres une trentaine de
// secondes sans evenement, et setInterval s'eteint avec lui. Mesure du 12 aout
// 2026 sur le VPS : 45 profils ouverts, 10 seulement avaient une sauvegarde
// posterieure a leur derniere ouverture -- les autres s'arretaient environ
// trois minutes apres le lancement, puis plus rien. Une session ouverte apres
// ce moment n'etait jamais enregistree, et la sauvegarde perimee etait
// reinjectee au lancement suivant, ce qui deconnectait le compte.
//
// Deux reveils fiables prennent donc le relais du minuteur : l'evenement
// "un cookie a change", qui tombe exactement quand une sauvegarde est utile,
// et une alarme periodique comme filet. Les deux reveillent le worker endormi.
setInterval(exportCookies, 1000);

chrome.cookies.onChanged.addListener(() => scheduleExport(1000));

chrome.alarms.create('spectra-cookie-export', { periodInMinutes: 0.5 });

// Capture the initial imported/native state immediately after startup settles.
setTimeout(exportCookies, 1000);
`
      );
      console.log(`[CookieSync] Created cookie sync extension`);

      // Use per-profile immutable copies so an update or autostart change cannot
      // alter extension files used by another running profile.
      // Trois cas : cette instance publie le modele de son dossier, elle le
      // recoit, ou elle n'a rien a voir avec. On ne recopie que si le modele a
      // change depuis la derniere fois -- sinon un reglage ajuste sur place
      // serait ecrase a chaque ouverture.
      const empreinteDuDossier = options.folderId
        ? this.empreinteModeleBot(options.folderId)
        : null;
      const roleModeleBot: 'modele' | 'copie' | null =
        options.botTemplate === true
          ? 'modele'
          : (options.folderId && empreinteDuDossier &&
             empreinteDuDossier !== options.botTemplateApplied)
            ? 'copie'
            : null;
      if (roleModeleBot) {
        console.log(
          `[Spectra Modele] ${options.profileName} : ${roleModeleBot}` +
          (roleModeleBot === 'copie' ? ` (modele ${empreinteDuDossier})` : '')
        );
      }

      const runtimeExtensionsRoot = path.join(profilePath, '__runtime_extensions');
      fs.rmSync(runtimeExtensionsRoot, { recursive: true, force: true });
      fs.mkdirSync(runtimeExtensionsRoot, { recursive: true });

      // Collect extensions
      const extPaths: string[] = [cookieSyncPath];
      let shouldAutoStartTwitterBot = false;
      let shadowbanSetupUrl: string | null = null;
      if (platformFixPath) extPaths.push(platformFixPath);
      if (options.extensionPaths && options.extensionPaths.length > 0) {
        const validPaths = options.extensionPaths.flatMap((p, index) => {
          const manifestPath = path.join(p, 'manifest.json');
          const exists = fs.existsSync(manifestPath);
          console.log(`[Extensions] ${p} — manifest exists: ${exists}`);
          if (!exists) return [];
          let extensionName = '';
          try {
            const extensionManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            extensionName = String(extensionManifest.name || '').toLowerCase();
          } catch (error) {
            console.warn(`[Extensions] Could not inspect extension: ${p}`, error);
          }
          if (!shouldLoadExtensionForLaunch({
            extensionName,
            hasTargetTweet: Boolean(targetTweetUrl),
            autoStartTwitterBot: options.autoStartTwitterBot === true,
          })) {
            console.log('[Extensions] VenusBot skipped for standard manual launch');
            return [];
          }
          if (
            (targetTweetUrl || options.autoStartTwitterBot === true) &&
            extensionName.includes('shadowban scanner')
          ) {
            console.log(
              targetTweetUrl
                ? '[Extensions] Shadowban Scanner skipped for Open post'
                : '[Extensions] Shadowban Scanner skipped for Open Selected'
            );
            return [];
          }
          const runtimePath = this.createRuntimeExtensionCopy(runtimeExtensionsRoot, p, index);
          if (extensionName.includes('shadowban scanner')) {
            const extensionId = this.getChromeExtensionId(runtimePath);
            if (extensionId) {
              shadowbanSetupUrl =
                `chrome-extension://${extensionId}/html/initialSetup.html`;
            }
          }
          if (this.configureTwitterAutoReplyAutostart(
            runtimePath,
            options.autoStartTwitterBot === true,
            {
              launchId: autoStartLaunchId,
              profileId: options.profileId,
              profileName: options.profileName,
              profilePath,
              roleModeleBot,
              dossierModeleBot: options.folderId || '',
            }
          )) {
            shouldAutoStartTwitterBot = options.autoStartTwitterBot === true;
          }
          return [runtimePath];
        });
        extPaths.push(...validPaths);
      }
      if (options.autoStartTwitterBot && !shouldAutoStartTwitterBot) {
        const twitterAutoReplyPath = this.findTwitterAutoReplyExtensionPath();
        if (twitterAutoReplyPath) {
          const runtimePath = this.createRuntimeExtensionCopy(runtimeExtensionsRoot, twitterAutoReplyPath, extPaths.length);
          const configured = this.configureTwitterAutoReplyAutostart(runtimePath, true, {
            launchId: autoStartLaunchId,
            profileId: options.profileId,
            profileName: options.profileName,
            profilePath,
            roleModeleBot,
            dossierModeleBot: options.folderId || '',
          });
          if (configured) {
            shouldAutoStartTwitterBot = true;
            extPaths.push(runtimePath);
            console.log(`[Extensions] Auto-start extension added: ${runtimePath}`);
          }
        }
      }
      if (options.autoStartTwitterBot && !shouldAutoStartTwitterBot) {
        throw new Error(
          'VenusBot is unavailable or incompatible; Open Selected cannot start this profile'
        );
      }
      // Determine start URL
      const isValidUrl = (url: string) => url && (url.startsWith('https://') || url.startsWith('http://'));
      const isLegacyGoogleStartUrl = (url: string) =>
        /^https?:\/\/(?:www\.)?google\.[^/]+\/?$/i.test(url.trim());
      const configuredLastUrl = options.lastUrl || '';
      // Pour une connexion, on part de l'accueil de X. `\/i\/flow\/login`
      // redirigeait le 16 aout 2026 vers `\/i\/jf\/onboarding\/web`, un ecran
      // qui pose sa boite de dialogue par-dessus la page et n'offre plus le
      // champ identifiant au meme endroit. L'accueil, lui, presente le
      // formulaire directement.
      let startUrl = sessionImportAttemptId
        ? 'https://x.com/'
        : options.massPost
        ? 'https://x.com/compose/post'
        : targetTweetUrl ||
          (
            isValidUrl(configuredLastUrl) && !isLegacyGoogleStartUrl(configuredLastUrl)
              ? configuredLastUrl
              : 'https://x.com/home'
          );
      const lastUrlPath = path.join(profilePath, 'last_url.txt');
      // L'adresse memorisee reprend la main sur une ouverture ordinaire -- c'est
      // ce qui rouvre le profil la ou on l'avait laisse. Mais un branding ou
      // une publication demandent une page precise : la memoire les renvoyait
      // sur l'accueil, et le script devait naviguer lui-meme, ce qu'il ne
      // faisait qu'une fois.
      if (
        !options.autoStartTwitterBot && !targetTweetUrl && !sessionImportAttemptId &&
        !options.branding && !options.massPost && fs.existsSync(lastUrlPath)
      ) {
        try {
          const savedUrl = fs.readFileSync(lastUrlPath, 'utf8').trim();
          if (isValidUrl(savedUrl) && !isLegacyGoogleStartUrl(savedUrl)) {
            startUrl = savedUrl;
          }
        } catch {}
      }
      if (shouldAutoStartTwitterBot) {
        startUrl = 'https://x.com/i/chat/requests';
      }
      const donneesDemarrage = {
        startUrl,
        closeOtherTabs: options.autoStartTwitterBot === true || Boolean(targetTweetUrl),
        likeTargetPost: Boolean(targetTweetUrl),
        launchId: autoStartLaunchId,
      };
      fs.writeFileSync(
        path.join(cookieSyncPath, 'start_url.json'),
        JSON.stringify(donneesDemarrage)
      );

      // L'adresse de depart est calculee ici, apres la generation du script.
      // On l'y inscrit donc maintenant, a la place du reperage laisse pour
      // elle. Le script n'a plus alors aucun fichier a relire pour demarrer.
      const cheminScript = path.join(cookieSyncPath, 'background.js');
      const script = fs.readFileSync(cheminScript, 'utf8');
      const repere = '/*SPECTRA_DEMARRAGE*/null';
      if (!script.includes(repere)) {
        throw new Error('Repere SPECTRA_DEMARRAGE introuvable dans le script genere');
      }
      fs.writeFileSync(
        cheminScript,
        script.replace(repere, JSON.stringify(donneesDemarrage))
      );

      if (extPaths.length > 0) {
        const uniqueExtPaths = Array.from(new Set(extPaths));
        args.push(`--load-extension=${uniqueExtPaths.join(',')}`);
        args.push(`--disable-extensions-except=${uniqueExtPaths.join(',')}`);
        console.log(`[Extensions] Loading ${uniqueExtPaths.length} extension(s)`);
      }

      // Native Chrome cookies are encrypted for their source Windows account.
      // On another PC, import the portable JSON cookies before navigating to X.
      // Un Open Post demarrait sur la page interne de l'extension. Chrome la
      // refuse : elle n'est pas declaree accessible publiquement, donc une
      // navigation lancee en ligne de commande tombe sur ERR_BLOCKED_BY_CLIENT.
      // Le profil s'ouvrait ainsi sur un ecran d'erreur, et seul le rattrapage
      // de l'extension le remettait sur le tweet -- constate le 15 aout 2026
      // sur happitrans, reste bloque sur cet ecran.
      //
      // On demarre donc sur une page vide, que l'extension remplace ensuite par
      // le tweet, exactement comme elle le fait deja. Declarer la page comme
      // publique aurait suffi a la debloquer, mais l'aurait rendue lisible par
      // n'importe quel site : de quoi reconnaitre l'extension, et donc le
      // navigateur. Inacceptable ici.
      /* La page vide n'est pas un detour : elle laisse a l'extension le temps
         de poser les cookies avant d'atteindre X. Le 23 aout 2026 j'ai voulu
         la sauter pour une publication, en croyant que la session vivait de
         toute facon dans le profil. Elle n'y etait pas : les instances sont
         arrivees sur X deconnectees. On la garde. */
      const regularLaunchUrl = options.autoStartTwitterBot
        ? startUrl
        : targetTweetUrl
          ? 'about:blank'
          : (hasStagedCookies ? 'about:blank' : startUrl);
      const launchUrl = sessionImportAttemptId ? startUrl : regularLaunchUrl;
      if (shouldAppendLaunchUrl(launchMode, hasRestorableSession)) {
        args.push(launchUrl);
      } else {
        console.log('[Chrome] Manual launch: restoring the existing Chrome session');
      }
      if (
        shadowbanSetupUrl &&
        !options.autoStartTwitterBot &&
        !targetTweetUrl &&
        !sessionImportAttemptId &&
        shouldOpenSetupTab(launchMode, hasRestorableSession)
      ) {
        args.push(shadowbanSetupUrl);
        console.log('[Extensions] Opening the standard Shadowban setup tab');
      }
      const launchConfirmationPromise = autoStartLaunchId
        ? this.waitForLaunchConfirmation(options.profileId, autoStartLaunchId)
        : null;

      console.log(`Launching Chrome: ${chromePath}`);
      console.log(`Start URL: ${startUrl}${hasStagedCookies ? ' (after cookie import)' : ''}`);
      console.log(`Mode: ZERO CDP (no debug port, no WebSocket, fully clean)`);

      // Clean environment
      const cleanEnv: Record<string, string | undefined> = {};
      for (const [key, val] of Object.entries(process.env)) {
        if (!key.startsWith('ELECTRON') && key !== 'NODE_OPTIONS') {
          cleanEnv[key] = val;
        }
      }
      // Set timezone to match fingerprint/proxy location
      if (effectiveFingerprint.timezone) {
        cleanEnv['TZ'] = effectiveFingerprint.timezone;
        console.log(`[Timezone] Set to ${effectiveFingerprint.timezone}`);
      }

      // === SPAWN Chrome — no Puppeteer, no CDP, no debug port ===
      // Verify that the process survives startup. Some VPS/RDP machines reject
      // normal GPU initialization and previously looked like a successful launch.
      this.pendingLaunchModes.set(options.profileId, launchMode);
      let chromeProcess: ChildProcess;
      try {
        chromeProcess = await this.spawnChromeAndVerify(chromePath, args, cleanEnv, profilePath);
      } catch (firstError: any) {
        if (process.platform !== 'win32') throw firstError;
        console.warn(`[Chrome] Standard startup failed, retrying in VPS compatibility mode: ${firstError.message}`);
        chromeProcess = await this.spawnChromeAndVerify(chromePath, [...args, '--disable-gpu'], cleanEnv, profilePath);
      }
      if (this.cancelledProfiles.has(options.profileId)) {
        await this.terminateProfileProcesses(profilePath);
        throw new Error('Launch cancelled');
      }
      if (managedLaunch) {
        this.enforceWindowPlacement(chromeProcess.pid, placement);
      } else if (manualPlacementCorrection) {
        this.enforceWindowPlacement(chromeProcess.pid, {
          ...manualPlacementCorrection,
          width: manualPlacementCorrection.right - manualPlacementCorrection.left,
          height: manualPlacementCorrection.bottom - manualPlacementCorrection.top,
          workArea: placement.workArea,
        });
      }

      console.log(`[Chrome] Process spawned (PID: ${chromeProcess.pid})`);
      this.appendLifecycleEvent(options.profileId, 'process-spawned', {
        launchMode,
        pid: chromeProcess.pid || null,
        launchId: autoStartLaunchId,
      });

      const profileInstance = {
        chromeProcess,
        profilePath,
        profileId: options.profileId,
        localProxyServer,
        launchMode,
        processMonitorTimer: null as NodeJS.Timeout | null,
        requiresPortableAuth: options.platform === 'twitter' ||
          Boolean(targetTweetUrl) ||
          options.autoStartTwitterBot === true ||
          sessionImportAttemptId.length > 0 ||
          /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(options.lastUrl || ''),
        syncEligible: false,
        closeNotified: false,
        closeIntent: null as null | { source: string; timestamp: string },
      };

      let processCleanedUp = false;
      const cleanupChromeProcess = (
        source: string,
        details: Record<string, unknown> = {}
      ) => {
        if (processCleanedUp) return;
        processCleanedUp = true;
        this.appendLifecycleEvent(options.profileId, 'profile-processes-gone', {
          source,
          launchMode,
          launchId: autoStartLaunchId,
          closeIntent: profileInstance.closeIntent,
          ...details,
        });
        if (profileInstance.processMonitorTimer) {
          clearTimeout(profileInstance.processMonitorTimer);
          profileInstance.processMonitorTimer = null;
        }

        if (localProxyServer) {
          localProxyServer.close();
          console.log(`[Proxy] Local relay closed for profile: ${options.profileId}`);
        }

        this.pendingProfiles.delete(options.profileId);
        if (autoStartLaunchId) {
          this.cancelLaunchConfirmation(options.profileId, autoStartLaunchId);
        }
        this.activeProfiles.delete(options.profileId);
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('profiles:activeUpdate', Array.from(this.activeProfiles.keys()));
          if (profileInstance.syncEligible && !profileInstance.closeNotified) {
            profileInstance.closeNotified = true;
            const emitClosedProfile = () => {
              if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
              const portableAuthReady = !profileInstance.requiresPortableAuth ||
                this.ensureAuthenticatedXSnapshot(profileInstance.profilePath);
              this.mainWindow.webContents.send('profile:closed', options.profileId, {
                syncEligible: portableAuthReady,
                launchMode: profileInstance.launchMode,
                requiresPortableAuth: profileInstance.requiresPortableAuth,
                reason: portableAuthReady ? 'chrome-exit' : 'missing-authenticated-x-snapshot',
              });
            };

            const portableAuthAlreadyReady = !profileInstance.requiresPortableAuth ||
              this.ensureAuthenticatedXSnapshot(profileInstance.profilePath);
            if (portableAuthAlreadyReady) {
              emitClosedProfile();
            } else {
              // The extension's final localhost POST can finish just after the
              // Chrome process exits. Give that atomic write a short grace period.
              setTimeout(emitClosedProfile, 1500);
            }
          }
        }
      };

      const monitorHandedOffBrowser = () => {
        if (processCleanedUp || process.platform !== 'win32') return;
        profileInstance.processMonitorTimer = setTimeout(async () => {
          profileInstance.processMonitorTimer = null;
          try {
            const remainingProcessIds = await this.getProfileProcessIds(profilePath);
            if (remainingProcessIds.length === 0) {
              cleanupChromeProcess('handoff-monitor', {
                rootPid: chromeProcess.pid || null,
                rootExitCode: chromeProcess.exitCode,
                rootSignalCode: chromeProcess.signalCode,
              });
              return;
            }
            monitorHandedOffBrowser();
          } catch (error) {
            console.warn(
              `[Chrome] Could not monitor handed-off browser for ${options.profileId}:`,
              error
            );
            monitorHandedOffBrowser();
          }
        }, 1000);
      };

      chromeProcess.on('error', (error) => {
        console.error(`[Chrome] Process error for profile ${options.profileId}:`, error);
        this.appendLifecycleEvent(options.profileId, 'root-process-error', {
          pid: chromeProcess.pid || null,
          name: error.name,
          message: error.message,
        });
        cleanupChromeProcess('root-process-error', {
          pid: chromeProcess.pid || null,
          message: error.message,
        });
      });

      // Monitor Chrome process exit
      chromeProcess.on('exit', async (code, signal) => {
        console.log(`[Chrome] Process exited (code: ${code}) for profile: ${options.profileId}`);
        this.appendLifecycleEvent(options.profileId, 'root-process-exit', {
          pid: chromeProcess.pid || null,
          code,
          signal,
          launchMode,
          closeIntent: profileInstance.closeIntent,
        });

        // On Windows/VPS, chrome.exe may hand the visible browser window to
        // another process and let the process spawned by Spectra exit. Treat
        // the profile as closed only when no Chrome process still owns this
        // user-data-dir.
        if (process.platform === 'win32') {
          await new Promise(resolve => setTimeout(resolve, 400));
          try {
            const remainingProcessIds = await this.getProfileProcessIds(profilePath);
            if (remainingProcessIds.length > 0) {
              this.appendLifecycleEvent(options.profileId, 'browser-handoff-detected', {
                rootPid: chromeProcess.pid || null,
                rootExitCode: code,
                rootSignal: signal,
                survivingPids: remainingProcessIds,
              });
              console.log(
                `[Chrome] Browser handoff detected for ${options.profileId}; ` +
                `surviving PIDs: ${remainingProcessIds.join(',')}`
              );
              monitorHandedOffBrowser();
              return;
            }
          } catch (error) {
            console.warn(`[Chrome] Browser handoff check failed for ${options.profileId}:`, error);
          }
        }

        // Save last URL from open_tabs.json (updated by extension or Chrome itself)
        // Note: Without CDP we can't export cookies on exit, but Chrome saves them
        // to its native Cookies DB which is included in profile sync
        cleanupChromeProcess('root-process-exit', {
          pid: chromeProcess.pid || null,
          code,
          signal,
        });
      });

      const profileProcessIds = process.platform === 'win32'
        ? await this.getProfileProcessIds(profilePath)
        : [];
      if (
        processCleanedUp ||
        (
          process.platform === 'win32'
            ? profileProcessIds.length === 0
            : chromeProcess.exitCode !== null || chromeProcess.signalCode !== null
        )
      ) {
        throw new Error('Chrome exited before the launch could be marked Running');
      }

      this.pendingProfiles.delete(options.profileId);
      this.pendingLaunchModes.delete(options.profileId);
      this.activeProfiles.set(options.profileId, profileInstance);
      profileInstance.syncEligible = true;
      console.log(`Chrome launched successfully for profile: ${options.profileId}`);

      // Open Selected must not block the entire batch while VenusBot confirms.
      // The visible browser window is the launch confirmation; VenusBot keeps
      // reporting its own status in the background. Closing an instance
      // manually before that report is therefore a normal close, not a failed
      // browser launch.
      if (launchConfirmationPromise) {
        void launchConfirmationPromise
          .then(launchStatus => {
            if (launchStatus === 'venus-confirmed') {
              console.log(
                `[Spectra AutoStart] VenusBot confirmed for ${options.profileId}`
              );
            } else if (launchStatus === 'manual-pause-preserved') {
              console.warn(
                `[Spectra AutoStart] VenusBot manual pause preserved for ${options.profileId}`
              );
            } else if (launchStatus === 'timeout') {
              console.warn(
                `[Spectra AutoStart] VenusBot confirmation timed out for ${options.profileId}`
              );
            } else if (launchStatus === 'process-exited') {
              console.log(
                `[Spectra AutoStart] ${options.profileId} closed before VenusBot confirmation`
              );
            }
          })
          .catch(error => {
            console.warn(
              `[Spectra AutoStart] VenusBot background confirmation failed for ${options.profileId}:`,
              error
            );
          });
      }

      return { success: true };

    } catch (error: any) {
      this.pendingProfiles.delete(options.profileId);
      this.pendingLaunchModes.delete(options.profileId);
      if (autoStartLaunchId) {
        this.cancelLaunchConfirmation(options.profileId, autoStartLaunchId);
      }
      console.error('Error launching browser:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Find system-installed Chrome (sends proper "Google Chrome" in Sec-Ch-Ua)
   */
  private static findSystemChrome(): string | null {
    const candidates: string[] = [];
    if (process.platform === 'win32') {
      const programFiles = process.env['PROGRAMFILES'] || 'C:\\Program Files';
      const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
      const localAppData = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');
      candidates.push(
        path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      );
    } else if (process.platform === 'darwin') {
      candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    } else {
      candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable');
    }
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        console.log(`[Browser] Found system Chrome: ${c}`);
        return c;
      }
    }
    console.log('[Browser] System Chrome not found, will use Chrome for Testing');
    return null;
  }

  /**
   * Download Chrome for Testing (fallback)
   */
  /**
   * Navigateur compile pour Spectra, s'il est present sur la machine.
   *
   * Chrome for Testing est refuse par X : mesure du 11 aout 2026, meme compte,
   * meme IP, meme minute, profil neuf et sans aucune substitution -- le Chrome
   * installe passe, Chrome for Testing non. Deux differences le trahissaient et
   * aucune n'etait corrigeable de l'exterieur : sa signature TLS, et le fait
   * qu'il annonce "Chromium" alors que son user-agent dit "Chrome".
   *
   * Le navigateur compile ici corrige les deux a la source. Mesures du 12 aout
   * 2026, face au Chrome installe sur la meme machine :
   *   signature TLS      t13d1516h2_8daaf6152771_806a8c22fdea   identique
   *   empreinte HTTP/2   52d84b11737d980aef856699f885ca86       identique
   *   marques annoncees  Not=A?Brand 99 | Google Chrome 151 | Chromium 151
   *   Widevine, codecs H.264 et AAC, lecteur PDF                 presents
   * Et il accepte --load-extension, ce que le Chrome de Google refuse.
   *
   * S'il n'est pas la, on retombe sur Chrome for Testing : le profil demarre,
   * simplement avec le defaut connu.
   */
  private static findSpectraBrowser(): string | null {
    try {
      const racine = path.join(os.homedir(), '.antidetect-browser', 'browser', 'spectra');

      // Sur macOS, une compilation de Chromium produit un paquet `.app` et non
      // un fichier nu : l'executable vit dans `<paquet>/Contents/MacOS/<nom>`.
      // Chercher un `chrome` a la racine ne trouvait donc jamais rien, et le
      // Mac retombait sur Chrome for Testing -- celui-la meme que X refuse.
      // On accepte les deux noms de paquet, selon la marque choisie a la
      // compilation, et on garde le fichier nu en dernier recours.
      const candidats = process.platform === 'win32'
        ? ['chrome.exe']
        : process.platform === 'darwin'
          ? [
              path.join('Chromium.app', 'Contents', 'MacOS', 'Chromium'),
              path.join('Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
              path.join('Spectra.app', 'Contents', 'MacOS', 'Spectra'),
              'chrome',
            ]
          : ['chrome'];

      for (const candidat of candidats) {
        const chemin = path.join(racine, candidat);
        if (fs.existsSync(chemin)) return chemin;
      }
      return null;
    } catch {
      return null;
    }
  }

  private static async downloadChromeForTesting(): Promise<string> {
    const propre = this.findSpectraBrowser();
    if (propre) {
      console.log(`[Browser] Navigateur Spectra: ${propre}`);
      return propre;
    }

    const cacheDir = path.join(os.homedir(), '.antidetect-browser', 'browser');
    const platform = detectBrowserPlatform();

    if (!platform) {
      throw new Error('Cannot detect browser platform');
    }

    const markerPath = path.join(cacheDir, '.installed');
    if (fs.existsSync(markerPath)) {
      const savedPath = fs.readFileSync(markerPath, 'utf8').trim();
      const cachedVersion = await this.getBrowserVersion(savedPath);
      if (fs.existsSync(savedPath) && cachedVersion === MANAGED_CHROME_VERSION) {
        console.log(`[Browser] Using cached Chrome: ${savedPath}`);
        return savedPath;
      }
      console.warn(
        `[Browser] Cached Chrome is stale (${cachedVersion || 'unknown'}); ` +
        `installing ${MANAGED_CHROME_VERSION}`
      );
    }

    console.log('[Browser] Downloading Chrome for Testing...');
    this.sendProgress(0, 'Téléchargement Chrome for Testing...');
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    const buildId = MANAGED_CHROME_VERSION;
    console.log(`[Browser] Using Chrome version: ${buildId}`);

    let lastPercent = 0;
    const result = await install({
      browser: Browser.CHROME,
      buildId: buildId,
      cacheDir: cacheDir,
      platform: platform,
      downloadProgressCallback: (downloadedBytes: number, totalBytes: number) => {
        const percent = Math.round((downloadedBytes / totalBytes) * 100);
        if (percent !== lastPercent) {
          lastPercent = percent;
          const dlMB = (downloadedBytes / 1024 / 1024).toFixed(1);
          const totalMB = (totalBytes / 1024 / 1024).toFixed(1);
          this.sendProgress(percent, `Chrome for Testing... ${dlMB} / ${totalMB} Mo`);
        }
      },
    });

    this.sendProgress(100, 'Navigateur prêt !');
    console.log(`[Browser] Chrome downloaded: ${result.executablePath}`);
    fs.writeFileSync(markerPath, result.executablePath);
    return result.executablePath;
  }

  /**
   * Create a local HTTP proxy that relays to a remote proxy with authentication.
   * Chrome connects to localhost (no auth needed), local proxy adds Proxy-Authorization.
   */
  private static createLocalProxy(proxy: any): Promise<{ server: http.Server; port: number }> {
    return new Promise((resolve, reject) => {
      const authHeader = 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
      const remoteHost = proxy.host;
      const remotePort = Number(proxy.port);

      const server = http.createServer((req, res) => {
        // HTTP requests — forward with auth header
        const options: http.RequestOptions = {
          host: remoteHost,
          port: remotePort,
          method: req.method,
          path: req.url,
          headers: { ...req.headers, 'Proxy-Authorization': authHeader },
        };
        const proxyReq = http.request(options, (proxyRes) => {
          res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
          proxyRes.pipe(res);
        });
        proxyReq.on('error', (e) => {
          console.error('[Proxy] HTTP relay error:', e.message);
          res.writeHead(502);
          res.end('Proxy error');
        });
        req.pipe(proxyReq);
      });

      // HTTPS CONNECT tunneling
      server.on('connect', (req, clientSocket, head) => {
        const connectReq = `CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\nProxy-Authorization: ${authHeader}\r\n\r\n`;
        const remoteSocket = net.connect(remotePort, remoteHost, () => {
          remoteSocket.write(connectReq);
        });

        let responded = false;
        remoteSocket.once('data', (chunk) => {
          const response = chunk.toString();
          if (response.includes('200')) {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length > 0) remoteSocket.write(head);
            remoteSocket.pipe(clientSocket);
            clientSocket.pipe(remoteSocket);
            responded = true;
          } else {
            clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
            clientSocket.end();
            remoteSocket.end();
          }
        });

        remoteSocket.on('error', (e) => {
          console.error('[Proxy] CONNECT relay error:', e.message);
          if (!responded) {
            clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
            clientSocket.end();
          }
        });

        clientSocket.on('error', () => remoteSocket.destroy());
        remoteSocket.on('close', () => clientSocket.destroy());
        clientSocket.on('close', () => remoteSocket.destroy());
      });

      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        console.log(`[Proxy] Local relay started on 127.0.0.1:${addr.port}`);
        resolve({ server, port: addr.port });
      });

      server.on('error', reject);
    });
  }

  static async closeProfile(profileId: string, source = 'ui-graceful-close') {
    this.assertSafeId(profileId, 'profile ID');
    this.cancelledProfiles.add(profileId);
    const instance = this.activeProfiles.get(profileId);
    const closeIntent = { source, timestamp: new Date().toISOString() };
    if (instance) instance.closeIntent = closeIntent;
    this.appendLifecycleEvent(profileId, 'close-requested', {
      source,
      method: 'graceful',
      launchMode: instance?.launchMode || this.pendingLaunchModes.get(profileId) || null,
    });
    if (!instance) {
      const profilesRoot = process.platform === 'win32'
        ? path.join(os.homedir(), 'AppData', 'Local', 'AntidetectBrowser', 'Profiles')
        : path.join(os.homedir(), '.antidetect-browser', 'profiles');
      await this.terminateProfileProcesses(path.join(profilesRoot, profileId));
      return;
    }

    try {
      // Give the cookie-sync extension one interval to persist its final state.
      await new Promise(resolve => setTimeout(resolve, 1100));
      if (process.platform === 'win32') {
        const escapedPath = instance.profilePath.replace(/'/g, "''");
        await this.runPowerShell(`
          $profilePath = '${escapedPath}'
          $deadline = (Get-Date).AddSeconds(10)
          $browserProcesses = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" |
            Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profilePath) }
          $windowProcess = $browserProcesses |
            ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } |
            Where-Object { $_ -and $_.MainWindowHandle -ne 0 } |
            Select-Object -First 1
          if ($windowProcess) {
            [void]$windowProcess.CloseMainWindow()
          }
          do {
            Start-Sleep -Milliseconds 250
            $remaining = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" |
              Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profilePath) }
          } while ($remaining -and (Get-Date) -lt $deadline)
          if ($remaining) {
            $remaining | ForEach-Object {
              Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            }
          }
        `);
      } else if (instance.chromeProcess && instance.chromeProcess.exitCode === null) {
        instance.chromeProcess.kill('SIGTERM');
      }
    } catch (error) {
      console.warn(`[Chrome] Graceful close failed for ${profileId}, forcing shutdown:`, error);
      try {
        if (instance.chromeProcess && instance.chromeProcess.exitCode === null) {
          instance.chromeProcess.kill();
        }
      } catch {}
    }
  }

  static async forceCloseProfile(profileId: string, source = 'ui-force-close') {
    this.assertSafeId(profileId, 'profile ID');
    this.cancelledProfiles.add(profileId);
    const instance = this.activeProfiles.get(profileId);
    const closeIntent = { source, timestamp: new Date().toISOString() };
    if (instance) instance.closeIntent = closeIntent;
    this.appendLifecycleEvent(profileId, 'close-requested', {
      source,
      method: 'forced',
      launchMode: instance?.launchMode || this.pendingLaunchModes.get(profileId) || null,
    });
    const profilesRoot = process.platform === 'win32'
      ? path.join(os.homedir(), 'AppData', 'Local', 'AntidetectBrowser', 'Profiles')
      : path.join(os.homedir(), '.antidetect-browser', 'profiles');
    const profilePath = instance?.profilePath || path.join(profilesRoot, profileId);
    if (instance?.processMonitorTimer) {
      clearTimeout(instance.processMonitorTimer);
      instance.processMonitorTimer = null;
    }

    const beforeProcessIds = await this.getProfileProcessIds(profilePath);
    console.log(
      `[Spectra OpenPost] Force close ${profileId}; Chrome PIDs before: ${beforeProcessIds.join(',') || 'none'}`
    );
    if (beforeProcessIds.length > 0) {
      // OpenPost normally flushes explicitly; this also protects emergency/UI closes.
      await new Promise(resolve => setTimeout(resolve, 1100));
    }
    await this.terminateProfileProcesses(profilePath);
    const afterProcessIds = await this.getProfileProcessIds(profilePath);
    this.appendLifecycleEvent(profileId, 'forced-close-completed', {
      source,
      beforeProcessIds,
      afterProcessIds,
    });
    console.log(
      `[Spectra OpenPost] Force close ${profileId}; Chrome PIDs after: ${afterProcessIds.join(',') || 'none'}`
    );
    this.pendingProfiles.delete(profileId);
    this.pendingLaunchModes.delete(profileId);
    this.activeProfiles.delete(profileId);
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(
        'profiles:activeUpdate',
        Array.from(this.activeProfiles.keys())
      );
      if (instance?.syncEligible && !instance.closeNotified) {
        instance.closeNotified = true;
        const portableAuthReady = !instance.requiresPortableAuth ||
          this.ensureAuthenticatedXSnapshot(instance.profilePath);
        this.mainWindow.webContents.send('profile:closed', profileId, {
          syncEligible: portableAuthReady,
          launchMode: instance.launchMode,
          requiresPortableAuth: instance.requiresPortableAuth,
          reason: portableAuthReady ? 'forced-close' : 'missing-authenticated-x-snapshot',
        });
      }
    }
  }

  static getActiveProfiles(): string[] {
    for (const [profileId, instance] of this.activeProfiles) {
      if (process.platform === 'win32') {
        if (!instance?.profilePath) this.activeProfiles.delete(profileId);
        continue;
      }
      const processExited = !instance?.chromeProcess ||
        instance.chromeProcess.exitCode !== null ||
        instance.chromeProcess.signalCode !== null;
      if (processExited) this.activeProfiles.delete(profileId);
    }
    return Array.from(this.activeProfiles.keys());
  }

  static canAcceptOpenPostClose(profileId: string): boolean {
    return this.pendingLaunchModes.get(profileId) === 'open-post' ||
      this.activeProfiles.get(profileId)?.launchMode === 'open-post';
  }

  static async getRunningProfiles(profileIds: string[]): Promise<string[]> {
    const safeIds = Array.from(new Set(profileIds)).filter(id => {
      try {
        this.assertSafeId(id, 'profile ID');
        return true;
      } catch {
        return false;
      }
    });
    const running = new Set(this.getActiveProfiles());
    if (safeIds.length === 0) return [];

    if (process.platform !== 'win32') {
      // Meme besoin que sur Windows : apres un redemarrage de Spectra, des
      // profils peuvent tourner encore sans qu'il s'en souvienne. S'en tenir a
      // sa memoire interne les afficherait fermes, et un second navigateur
      // partirait sur le meme dossier. On lit donc la table des processus --
      // une seule fois pour toute la liste.
      const racine = path.join(os.homedir(), '.antidetect-browser', 'profiles');
      const table = await this.lireTableProcessus();
      const lignes = table.split('\n').filter(ligne => /chrome|chromium/i.test(ligne));
      return safeIds.filter(id => {
        if (this.pendingProfiles.has(id)) return false;
        if (running.has(id)) return true;
        const chemin = path.join(racine, id);
        return lignes.some(ligne => ligne.includes(chemin));
      });
    }

    const profilesRoot = path.join(os.homedir(), 'AppData', 'Local', 'AntidetectBrowser', 'Profiles');
    const escapedRoot = profilesRoot.replace(/'/g, "''");
    const powershellIds = safeIds.map(id => `'${id}'`).join(',');
    try {
      const output = await this.runPowerShell(`
        $profilesRoot = '${escapedRoot}'
        $ids = @(${powershellIds})
        $processes = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" |
          Where-Object { $_.CommandLine }
        foreach ($id in $ids) {
          $profilePath = Join-Path $profilesRoot $id
          if ($processes | Where-Object { $_.CommandLine.Contains($profilePath) } | Select-Object -First 1) {
            Write-Output $id
          }
        }
      `);
      output.split(/\r?\n/).map(value => value.trim()).filter(Boolean).forEach(id => running.add(id));
    } catch (error) {
      console.warn('[Chrome] Could not discover running profiles:', error);
      throw new Error('Unable to inspect running Chrome profiles');
    }
    return safeIds.filter(id => running.has(id) && !this.pendingProfiles.has(id));
  }

  static async getCookies(profileId: string): Promise<any[]> {
    // Without CDP, we read cookies from the synced_cookies.json file
    const instance = this.activeProfiles.get(profileId);
    if (!instance) return [];

    try {
      const syncedPath = path.join(instance.profilePath, 'synced_cookies.json');
      if (fs.existsSync(syncedPath)) {
        return JSON.parse(fs.readFileSync(syncedPath, 'utf8'));
      }
    } catch {}
    return [];
  }
}
