import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';

/**
 * La sante des proxys, dans la duree.
 *
 * Un proxy tombe rarement pour toujours : il devient injoignable, puis revient
 * une heure plus tard. Le remplacer au premier echec ferait changer l'adresse
 * de sortie d'un compte pour rien -- et pour X, un compte qui demenage sans
 * raison est un compte qui se remarque.
 *
 * On garde donc une fiche par proxy : depuis quand il est en panne, combien de
 * tests ont echoue, quand il est revenu. Les instances concernees sont sautees
 * tant que la panne dure, au lieu de perdre 65 secondes chacune a chaque tour.
 * Le remplacement n'arrive qu'apres une panne longue et confirmee.
 */

export type FicheProxy = {
  cle: string;
  enPanne: boolean;
  depuis: string | null;
  echecs: number;
  dernierTest: string;
  dernierSucces: string | null;
};

/** Une panne doit durer et se confirmer avant qu'on envisage un remplacement. */
export const HEURES_AVANT_REMPLACEMENT = 6;
export const ECHECS_AVANT_REMPLACEMENT = 6;

function fichier(): string {
  const racine = process.platform === 'win32'
    ? path.join(os.homedir(), 'AppData', 'Local', 'AntidetectBrowser')
    : path.join(os.homedir(), '.antidetect-browser');
  return path.join(racine, 'sante-proxys.json');
}

export function lireSante(): Record<string, FicheProxy> {
  try {
    const f = fichier();
    if (!fs.existsSync(f)) return {};
    const c = JSON.parse(fs.readFileSync(f, 'utf8'));
    return c && typeof c === 'object' ? c : {};
  } catch {
    return {};
  }
}

function ecrireSante(tout: Record<string, FicheProxy>): void {
  try {
    const f = fichier();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const temporaire = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(temporaire, JSON.stringify(tout, null, 2), 'utf8');
    fs.renameSync(temporaire, f);
  } catch {
    // La sante des proxys ne doit jamais empecher un tour de tourner.
  }
}

export function cleProxy(proxy: any): string {
  const hote = String(proxy?.host || '').trim();
  const port = String(proxy?.port || '').trim();
  return hote && port ? `${hote}:${port}` : '';
}

/**
 * Un vrai test : on demande une page a travers le proxy.
 *
 * Court -- huit secondes -- parce qu'il tourne avant chaque instance et qu'il
 * ne doit pas ralentir un tour.
 */
export function testerProxy(proxy: any, limite = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    const hote = String(proxy?.host || '');
    const port = Number(proxy?.port || 0);
    if (!hote || !port) return resolve(false);

    const entetes: Record<string, string> = { Host: 'x.com' };
    const identifiant = String(proxy?.username || '');
    if (identifiant) {
      const secret = Buffer.from(`${identifiant}:${String(proxy?.password || '')}`).toString('base64');
      entetes['Proxy-Authorization'] = `Basic ${secret}`;
    }

    let fini = false;
    const terminer = (ok: boolean) => { if (!fini) { fini = true; resolve(ok); } };

    // La methode CONNECT est ce que fait le navigateur pour une page en https :
    // un test au plus pres de l'usage reel.
    const requete = http.request({
      host: hote, port, method: 'CONNECT', path: 'x.com:443', headers: entetes, timeout: limite,
    });
    requete.on('connect', (reponse, prise) => {
      prise.destroy();
      terminer(reponse.statusCode === 200);
    });
    requete.on('timeout', () => { requete.destroy(); terminer(false); });
    requete.on('error', () => terminer(false));
    requete.end();
  });
}

/** Note le resultat d'un test et rend la fiche a jour. */
export function noterTest(cle: string, ok: boolean): FicheProxy {
  if (!cle) {
    return { cle, enPanne: false, depuis: null, echecs: 0, dernierTest: '', dernierSucces: null };
  }
  const tout = lireSante();
  const maintenant = new Date().toISOString();
  const fiche = tout[cle] || {
    cle, enPanne: false, depuis: null, echecs: 0, dernierTest: '', dernierSucces: null,
  };

  if (ok) {
    // Un proxy qui revient efface son ardoise : c'est le cas le plus frequent.
    fiche.enPanne = false;
    fiche.depuis = null;
    fiche.echecs = 0;
    fiche.dernierSucces = maintenant;
  } else {
    fiche.echecs += 1;
    if (!fiche.enPanne) {
      fiche.enPanne = true;
      fiche.depuis = maintenant;
    }
  }
  fiche.dernierTest = maintenant;
  tout[cle] = fiche;
  ecrireSante(tout);
  return fiche;
}

/** Faut-il sauter les instances de ce proxy pour l'instant ? */
export function enPanne(cle: string): boolean {
  if (!cle) return false;
  const fiche = lireSante()[cle];
  return Boolean(fiche?.enPanne);
}

/**
 * La panne dure-t-elle assez pour justifier un changement d'adresse ?
 *
 * C'est le seul cas ou l'on touche a l'identite de sortie d'un compte.
 */
export function remplacementJustifie(cle: string): boolean {
  const fiche = lireSante()[cle];
  if (!fiche?.enPanne || !fiche.depuis) return false;
  const heures = (Date.now() - Date.parse(fiche.depuis)) / 3600000;
  return heures >= HEURES_AVANT_REMPLACEMENT && fiche.echecs >= ECHECS_AVANT_REMPLACEMENT;
}
