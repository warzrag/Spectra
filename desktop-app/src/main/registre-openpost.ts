import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Le registre : qui a retweete quoi, et quand.
 *
 * Rien n'etait ecrit a un seul endroit. Le bot savait qu'il avait retweete
 * mais son message se perdait en route ; Spectra ne savait pas quelles
 * instances avaient deja traite un tweet ; le relais ignorait si un post etait
 * fini. Au redemarrage, tout etait oublie -- et le meme post repartait pour un
 * tour complet.
 *
 * Le 18 aout 2026 : un tweet rouvert 25 fois en 90 minutes par des instances
 * qui l'avaient deja retweete, pendant qu'un post plus recent attendait.
 *
 * Une ligne par instance et par tweet, ecrite au moment ou ca se passe, gardee
 * sur le disque. C'est la seule source de verite.
 */

export type LigneRegistre = {
  tweet: string;
  profileId: string;
  nom?: string;
  retweet: boolean;
  like: boolean;
  quand: string;
  panne?: string;
};

function racine(): string {
  return process.platform === 'win32'
    ? path.join(os.homedir(), 'AppData', 'Local', 'AntidetectBrowser')
    : path.join(os.homedir(), '.antidetect-browser');
}

function fichier(): string {
  return path.join(racine(), 'registre-openpost.ndjson');
}

/**
 * Ajoute une ligne. Un fichier par ligne plutot qu'un JSON global : deux
 * instances qui finissent en meme temps ne peuvent pas s'ecraser l'une
 * l'autre, et une ecriture coupee ne perd que sa propre ligne.
 */
export function noterResultat(ligne: LigneRegistre): void {
  try {
    const f = fichier();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify(ligne) + '\n', 'utf8');
  } catch {
    // Le registre ne doit jamais empecher un tour de tourner.
  }
}

/** Toutes les lignes, les plus recentes d'abord. Bornees pour rester rapide. */
export function lireRegistre(limite = 4000): LigneRegistre[] {
  try {
    const f = fichier();
    if (!fs.existsSync(f)) return [];
    const taille = fs.statSync(f).size;
    // Seule la fin nous interesse, et le fichier grossit sans limite.
    const debut = Math.max(0, taille - 3 * 1024 * 1024);
    const descripteur = fs.openSync(f, 'r');
    const tampon = Buffer.alloc(taille - debut);
    fs.readSync(descripteur, tampon, 0, tampon.length, debut);
    fs.closeSync(descripteur);
    const lignes = tampon.toString('utf8').split(/\r?\n/).filter(Boolean);
    const sortie: LigneRegistre[] = [];
    for (let i = lignes.length - 1; i >= 0 && sortie.length < limite; i--) {
      try { sortie.push(JSON.parse(lignes[i])); } catch {}
    }
    return sortie;
  } catch {
    return [];
  }
}

/**
 * Les instances qui ont deja retweete ce tweet.
 *
 * C'est ce qui evite de rouvrir 25 fois la meme page : avant de lancer un
 * tour, on retire celles qui ont deja fait le travail.
 */
export function dejaRetweete(tweet: string): Set<string> {
  const faits = new Set<string>();
  if (!tweet) return faits;
  for (const l of lireRegistre()) {
    if (l.tweet === tweet && l.retweet) faits.add(l.profileId);
  }
  return faits;
}

/** Le detail d'un tweet, une entree par instance (la plus recente gagne). */
export function resultatsDuTweet(tweet: string): Record<string, LigneRegistre> {
  const parProfil: Record<string, LigneRegistre> = {};
  if (!tweet) return parProfil;
  // Le registre est rendu du plus recent au plus ancien : la premiere vue
  // pour un profil est donc la bonne.
  for (const l of lireRegistre()) {
    if (l.tweet !== tweet) continue;
    if (!parProfil[l.profileId]) parProfil[l.profileId] = l;
  }
  return parProfil;
}

/** Le bilan par tweet, pour la console et le recapitulatif. */
export function bilanParTweet(combien = 12): Array<{
  tweet: string; instances: number; retweets: number; premier: string; dernier: string;
}> {
  const par: Record<string, { instances: Set<string>; rt: Set<string>; t0: string; t1: string }> = {};
  for (const l of lireRegistre()) {
    if (!l.tweet) continue;
    const e = par[l.tweet] || (par[l.tweet] = {
      instances: new Set(), rt: new Set(), t0: l.quand, t1: l.quand,
    });
    e.instances.add(l.profileId);
    if (l.retweet) e.rt.add(l.profileId);
    if (l.quand < e.t0) e.t0 = l.quand;
    if (l.quand > e.t1) e.t1 = l.quand;
  }
  return Object.entries(par)
    .map(([tweet, e]) => ({
      tweet,
      instances: e.instances.size,
      retweets: e.rt.size,
      premier: e.t0,
      dernier: e.t1,
    }))
    .sort((a, b) => (a.dernier < b.dernier ? 1 : -1))
    .slice(0, combien);
}
