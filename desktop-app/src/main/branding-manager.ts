import * as fs from 'fs';
import * as path from 'path';

/**
 * Branding des comptes : chaque instance recoit une photo, une banniere, un nom,
 * une bio et un lieu tires d'un lot depose par l'utilisateur.
 *
 * Le principe qui commande tout : **deux comptes du meme dossier ne doivent
 * jamais porter la meme chose**. Deux profils avec la meme photo, c'est le lien
 * le plus facile a faire pour X -- plus facile encore qu'une empreinte.
 *
 * Le tirage est donc sans remise tant qu'il reste du neuf, et il est **stable** :
 * une instance deja servie garde ce qu'elle a recu. Sans cette memoire, chaque
 * ouverture rebattrait les cartes et les comptes changeraient d'identite
 * visuelle sans raison.
 */

export type LotBranding = {
  photos: string[];
  bannieres: string[];
  bios: string[];
  noms: string[];
  liens: string[];
  lieux: { pays: string | null; valeur: string }[];
};

export type AttributionBranding = {
  photo: string | null;
  banniere: string | null;
  bio: string | null;
  nom: string | null;
  lien: string | null;
  lieu: string | null;
};

const EXTENSIONS_IMAGE = ['.jpg', '.jpeg', '.png', '.webp'];

/** Les trois reserves de fichiers, rangees cote a cote dans le meme lot. */
export type SorteFichiers = 'photos' | 'bannieres' | 'medias';

export function cheminLotBranding(racineDonnees: string, folderId: string): string {
  return path.join(racineDonnees, 'Branding', folderId);
}

function lireLignes(fichier: string): string[] {
  if (!fs.existsSync(fichier)) return [];
  try {
    return fs.readFileSync(fichier, 'utf8')
      .split(/\r?\n/)
      .map(ligne => ligne.trim())
      .filter(ligne => ligne.length > 0 && !ligne.startsWith('#'));
  } catch {
    return [];
  }
}

function lireImages(dossier: string): string[] {
  if (!fs.existsSync(dossier)) return [];
  try {
    return fs.readdirSync(dossier)
      .filter(nom => EXTENSIONS_IMAGE.includes(path.extname(nom).toLowerCase()))
      .sort()
      .map(nom => path.join(dossier, nom));
  } catch {
    return [];
  }
}

/**
 * Un lieu peut porter son pays devant : `US | Miami, FL`.
 *
 * Sans cette precision, un compte pourrait afficher Miami en sortant par un
 * proxy allemand. Ce n'est pas le hasard qui se repere, c'est la contradiction.
 */
export function analyserLieu(ligne: string): { pays: string | null; valeur: string } {
  const separateur = ligne.indexOf('|');
  if (separateur < 0) return { pays: null, valeur: ligne.trim() };
  const pays = ligne.slice(0, separateur).trim().toUpperCase();
  const valeur = ligne.slice(separateur + 1).trim();
  if (!/^[A-Z]{2}$/.test(pays) || !valeur) return { pays: null, valeur: ligne.trim() };
  return { pays, valeur };
}

export function lireLotBranding(racineDonnees: string, folderId: string): LotBranding {
  const base = cheminLotBranding(racineDonnees, folderId);
  return {
    photos: lireImages(path.join(base, 'photos')),
    bannieres: lireImages(path.join(base, 'bannieres')),
    bios: lireLignes(path.join(base, 'bios.txt')),
    noms: lireLignes(path.join(base, 'noms.txt')),
    liens: lireLignes(path.join(base, 'liens.txt')),
    lieux: lireLignes(path.join(base, 'lieux.txt')).map(analyserLieu),
  };
}

type EtatAttributions = Record<string, AttributionBranding>;

function cheminAttributions(racineDonnees: string, folderId: string): string {
  return path.join(cheminLotBranding(racineDonnees, folderId), 'attributions.json');
}

export function lireAttributions(racineDonnees: string, folderId: string): EtatAttributions {
  const chemin = cheminAttributions(racineDonnees, folderId);
  if (!fs.existsSync(chemin)) return {};
  try {
    const contenu = JSON.parse(fs.readFileSync(chemin, 'utf8'));
    return contenu && typeof contenu === 'object' ? contenu : {};
  } catch {
    return {};
  }
}

function ecrireAttributions(
  racineDonnees: string,
  folderId: string,
  etat: EtatAttributions
): void {
  const chemin = cheminAttributions(racineDonnees, folderId);
  fs.mkdirSync(path.dirname(chemin), { recursive: true });
  const temporaire = `${chemin}.${process.pid}.tmp`;
  fs.writeFileSync(temporaire, JSON.stringify(etat, null, 2), 'utf8');
  fs.renameSync(temporaire, chemin);
}

/**
 * Tire une valeur en preferant celles que personne n'a encore.
 *
 * Quand le lot est epuise, on reprend parmi les moins utilisees plutot que de
 * refuser : mieux vaut un doublon annonce qu'un compte laisse sans photo.
 */
function tirer<T>(
  disponibles: T[],
  dejaPris: T[],
  hasard: () => number
): { valeur: T | null; doublon: boolean } {
  if (disponibles.length === 0) return { valeur: null, doublon: false };

  const compte = new Map<T, number>();
  for (const valeur of disponibles) compte.set(valeur, 0);
  for (const valeur of dejaPris) {
    if (compte.has(valeur)) compte.set(valeur, (compte.get(valeur) || 0) + 1);
  }

  const minimum = Math.min(...Array.from(compte.values()));
  const candidats = disponibles.filter(valeur => (compte.get(valeur) || 0) === minimum);
  const choisi = candidats[Math.floor(hasard() * candidats.length)] ?? candidats[0];
  return { valeur: choisi, doublon: minimum > 0 };
}

/**
 * Attribue son branding a une instance, ou rend celui qu'elle a deja.
 *
 * `paysProxy` sert aux lieux : on prefere ceux du meme pays que la sortie du
 * proxy. Si aucun ne correspond, on prend dans le reste.
 */
export function attribuerBranding(
  racineDonnees: string,
  folderId: string,
  profileId: string,
  paysProxy: string | null,
  hasard: () => number = Math.random
): { attribution: AttributionBranding; doublons: string[]; deja: boolean } {
  const etat = lireAttributions(racineDonnees, folderId);
  const lot = lireLotBranding(racineDonnees, folderId);

  const dejaServi = etat[profileId];
  if (dejaServi) {
    // Une attribution existante est conservee -- un compte ne doit pas changer
    // de visage a chaque passage. Mais elle peut etre incomplete : le lot s'est
    // enrichi depuis, ou un element n'existait pas encore. Le 17 aout 2026, le
    // lien a ete ajoute apres coup et toutes les fiches deja ecrites sont
    // restees sans lui -- le champ Website n'etait jamais rempli, sans erreur.
    const manquants = (['photo', 'banniere', 'bio', 'nom', 'lien', 'lieu'] as const)
      .filter((cle) => !dejaServi[cle]);
    if (manquants.length === 0) {
      return { attribution: dejaServi, doublons: [], deja: true };
    }
    const autresFiches = Object.entries(etat)
      .filter(([identifiant]) => identifiant !== profileId)
      .map(([, valeur]) => valeur);
    const disponibles: Record<string, string[]> = {
      photo: lot.photos,
      banniere: lot.bannieres,
      bio: lot.bios,
      nom: lot.noms,
      lien: lot.liens,
      lieu: lot.lieux.map((entree) => entree.valeur),
    };
    const complete: AttributionBranding = { ...dejaServi };
    const ajoutes: string[] = [];
    for (const cle of manquants) {
      const choix = tirer(
        disponibles[cle] || [],
        autresFiches.map((fiche) => fiche[cle]).filter(Boolean) as string[],
        hasard
      );
      if (!choix.valeur) continue;
      complete[cle] = choix.valeur;
      ajoutes.push(cle);
    }
    if (ajoutes.length === 0) {
      return { attribution: dejaServi, doublons: [], deja: true };
    }
    etat[profileId] = complete;
    ecrireAttributions(racineDonnees, folderId, etat);
    return { attribution: complete, doublons: [], deja: true };
  }
  const autres = Object.entries(etat)
    .filter(([identifiant]) => identifiant !== profileId)
    .map(([, valeur]) => valeur);
  const doublons: string[] = [];

  const photo = tirer(lot.photos, autres.map(a => a.photo).filter(Boolean) as string[], hasard);
  if (photo.doublon) doublons.push('photo');
  const banniere = tirer(lot.bannieres, autres.map(a => a.banniere).filter(Boolean) as string[], hasard);
  if (banniere.doublon) doublons.push('bannière');
  const bio = tirer(lot.bios, autres.map(a => a.bio).filter(Boolean) as string[], hasard);
  if (bio.doublon) doublons.push('bio');
  const nom = tirer(lot.noms, autres.map(a => a.nom).filter(Boolean) as string[], hasard);
  if (nom.doublon) doublons.push('nom');
  // Le lien peut tres bien etre le meme partout : un doublon de lien n'est pas
  // un defaut, contrairement a une photo. On le signale sans en faire un cas.
  const lien = tirer(lot.liens, autres.map(a => a.lien).filter(Boolean) as string[], hasard);

  // Les lieux du bon pays d'abord ; sinon tout le lot, plutot que rien.
  const pays = (paysProxy || '').trim().toUpperCase();
  const memePays = pays ? lot.lieux.filter(entree => entree.pays === pays) : [];
  const lieuxUtilisables = memePays.length > 0
    ? memePays
    : lot.lieux.filter(entree => !pays || entree.pays === null || memePays.length === 0);
  const lieu = tirer(
    lieuxUtilisables.map(entree => entree.valeur),
    autres.map(a => a.lieu).filter(Boolean) as string[],
    hasard
  );
  if (lieu.doublon) doublons.push('lieu');

  const attribution: AttributionBranding = {
    photo: photo.valeur,
    banniere: banniere.valeur,
    bio: bio.valeur,
    nom: nom.valeur,
    lien: lien.valeur,
    lieu: lieu.valeur,
  };
  etat[profileId] = attribution;
  ecrireAttributions(racineDonnees, folderId, etat);
  return { attribution, doublons, deja: false };
}

/**
 * Ce que le panneau de branding affiche : les textes tels quels, et le nombre
 * d'images de chaque sorte. Les images ne remontent pas -- une vingtaine de
 * photos en base64 traversant le pont a chaque ouverture n'apporterait rien.
 */
export function lireEtatBranding(racineDonnees: string, folderId: string): {
  photos: number;
  bannieres: number;
  bios: string;
  noms: string;
  lieux: string;
  liens: string;
  posts: string;
  medias: number;
} {
  const base = cheminLotBranding(racineDonnees, folderId);
  const texte = (fichier: string) => {
    const chemin = path.join(base, fichier);
    if (!fs.existsSync(chemin)) return '';
    try {
      return fs.readFileSync(chemin, 'utf8')
        .split(/\r?\n/)
        .filter(ligne => !ligne.trim().startsWith('#'))
        .join('\n')
        .trim();
    } catch {
      return '';
    }
  };
  return {
    photos: lireImages(path.join(base, 'photos')).length,
    bannieres: lireImages(path.join(base, 'bannieres')).length,
    bios: texte('bios.txt'),
    noms: texte('noms.txt'),
    lieux: texte('lieux.txt'),
    liens: texte('liens.txt'),
    posts: texte('posts.txt'),
    medias: lireLotPublication(racineDonnees, folderId).medias.length,
  };
}

export function ecrireTextesBranding(
  racineDonnees: string,
  folderId: string,
  textes: { bios?: string; noms?: string; lieux?: string; liens?: string; posts?: string }
): void {
  const base = cheminLotBranding(racineDonnees, folderId);
  fs.mkdirSync(base, { recursive: true });
  for (const [cle, fichier] of [
    ['bios', 'bios.txt'],
    ['noms', 'noms.txt'],
    ['lieux', 'lieux.txt'],
    ['liens', 'liens.txt'],
    ['posts', 'posts.txt'],
  ] as const) {
    const valeur = textes[cle];
    if (typeof valeur !== 'string') continue;
    fs.writeFileSync(path.join(base, fichier), valeur.trim() + '\n', 'utf8');
  }
}

/**
 * Ajoute des images au lot, sans jamais ecraser une existante.
 *
 * Deux fichiers du meme nom deposes a des moments differents sont deux images
 * differentes : les confondre reduirait le lot en silence, et deux comptes
 * finiraient avec la meme photo.
 */
export function ajouterImagesBranding(
  racineDonnees: string,
  folderId: string,
  sorte: SorteFichiers,
  fichiers: string[]
): number {
  const cible = path.join(cheminLotBranding(racineDonnees, folderId), sorte);
  const acceptees = sorte === 'medias' ? EXTENSIONS_MEDIA : EXTENSIONS_IMAGE;
  fs.mkdirSync(cible, { recursive: true });
  let ajoutees = 0;
  for (const source of fichiers) {
    const extension = path.extname(source).toLowerCase();
    if (!acceptees.includes(extension)) continue;
    let nom = path.basename(source);
    let index = 1;
    while (fs.existsSync(path.join(cible, nom))) {
      nom = `${path.basename(source, extension)}-${index}${extension}`;
      index++;
    }
    fs.copyFileSync(source, path.join(cible, nom));
    ajoutees++;
  }
  return ajoutees;
}

export function supprimerImagesBranding(
  racineDonnees: string,
  folderId: string,
  sorte: SorteFichiers
): number {
  const cible = path.join(cheminLotBranding(racineDonnees, folderId), sorte);
  const fichiers = sorte === 'medias'
    ? lireLotPublication(racineDonnees, folderId).medias
    : lireImages(cible);
  for (const fichier of fichiers) fs.rmSync(fichier, { force: true });
  return fichiers.length;
}

// --- Publication en masse ----------------------------------------------------
//
// Meme reserve, meme panneau, mais une regle opposee : un branding est stable
// -- un compte garde son visage -- alors qu'une publication doit etre neuve a
// chaque fois. On retient donc ce qui a deja ete publie, pour ne pas le
// repeter, plutot que pour le reconduire.

const EXTENSIONS_MEDIA = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp4', '.mov'];

export type LotPublication = { posts: string[]; medias: string[] };

export function lireLotPublication(racineDonnees: string, folderId: string): LotPublication {
  const base = cheminLotBranding(racineDonnees, folderId);
  const dossierMedias = path.join(base, 'medias');
  let medias: string[] = [];
  if (fs.existsSync(dossierMedias)) {
    try {
      medias = fs.readdirSync(dossierMedias)
        .filter(nom => EXTENSIONS_MEDIA.includes(path.extname(nom).toLowerCase()))
        .sort()
        .map(nom => path.join(dossierMedias, nom));
    } catch {}
  }
  return { posts: lirePosts(path.join(base, 'posts.txt')), medias };
}

/**
 * Decoupe la reserve de posts.
 *
 * Un post par ligne suffisait pour les bios, pas ici : un post porte souvent
 * ses propres retours a la ligne, et une ligne vide au milieu fait partie du
 * texte. Une ligne ne contenant que --- separe donc deux posts.
 *
 * Sans separateur dans le fichier, on retombe sur une ligne par post : c'est
 * ce qu'attend quelqu'un qui colle une liste simple.
 */
function lirePosts(fichier: string): string[] {
  if (!fs.existsSync(fichier)) return [];
  let contenu: string;
  try {
    contenu = fs.readFileSync(fichier, 'utf8');
  } catch {
    return [];
  }
  const sansCommentaires = contenu
    .split(/\r?\n/)
    .filter(ligne => !ligne.trim().startsWith('#'))
    .join('\n');

  if (/^\s*---\s*$/m.test(sansCommentaires)) {
    return sansCommentaires
      .split(/^\s*---\s*$/m)
      .map(bloc => bloc.replace(/^\n+|\n+$/g, '').trim())
      .filter(bloc => bloc.length > 0);
  }
  return sansCommentaires
    .split('\n')
    .map(ligne => ligne.trim())
    .filter(ligne => ligne.length > 0);
}

type HistoriquePublication = Record<string, { posts: string[]; medias: string[] }>;

function cheminHistorique(racineDonnees: string, folderId: string): string {
  return path.join(cheminLotBranding(racineDonnees, folderId), 'publications.json');
}

export function lireHistoriquePublication(
  racineDonnees: string,
  folderId: string
): HistoriquePublication {
  const chemin = cheminHistorique(racineDonnees, folderId);
  if (!fs.existsSync(chemin)) return {};
  try {
    const contenu = JSON.parse(fs.readFileSync(chemin, 'utf8'));
    return contenu && typeof contenu === 'object' ? contenu : {};
  } catch {
    return {};
  }
}

/**
 * Choisit quoi publier pour une instance.
 *
 * Deux exigences opposees se rejoignent ici : deux comptes ne doivent jamais
 * publier le meme texte le meme jour -- vingt comptes disant la meme phrase a
 * la meme minute, c'est la trace la plus lisible qui soit -- et un compte ne
 * doit pas se repeter d'une fois sur l'autre.
 *
 * On tire donc parmi ce que ce compte n'a jamais publie, en preferant ce que
 * personne n'a encore pris.
 */
/**
 * Part des publications qui portent un media.
 *
 * Une timeline ou chaque post porte une photo se reconnait de loin : personne
 * n'ecrit comme ca. Le bot VENUS tire deja au sort de son cote -- 55 % de
 * texte seul, 35 % de photo, 10 % de video -- et le mass post collait un
 * media a chaque fois. On aligne les deux : un peu moins d'une publication
 * sur deux porte une image ou une video.
 */
export const PART_AVEC_MEDIA = 0.45;

/** Quatre caracteres de largeur nulle : invisibles a l'ecran, comptes par X. */
const CARACTERES_INVISIBLES = ['​', '‌', '‍', '﻿'];

/** Retire les caracteres de largeur nulle, pour comparer ce qui se lit. */
export function sansInvisibles(texte: string): string {
  return String(texte || '').replace(/[​-‍﻿⁠]/g, '');
}

/**
 * Rend une publication unique sans en changer une lettre.
 *
 * Un compte finit toujours par republier ses propres textes : avec quatorze
 * posts et une tournee toutes les six heures, il a fait le tour en trois
 * jours et demi. Il repart alors sur les memes, mot pour mot -- et c'est
 * precisement ce que X sait reperer.
 *
 * On glisse donc deux a quatre caracteres de largeur nulle a des positions
 * tirees au hasard. Le lecteur ne voit rien ; deux envois du meme post ne
 * sont plus identiques. C'est la mecanique que VenusBot applique depuis le
 * debut (makePostUnique), et qui lui permet de publier tous les jours.
 *
 * Ce que cela ne fait PAS : deux comptes qui envoient la meme phrase
 * l'envoient toujours. Seuls des textes en plus le corrigent.
 */
export function rendreUnique(texte: string, hasard: () => number = Math.random): string {
  if (!texte) return texte;
  let sortie = texte;
  const combien = 2 + Math.floor(3 * hasard());
  for (let i = 0; i < combien; i++) {
    const caractere = CARACTERES_INVISIBLES[Math.floor(hasard() * CARACTERES_INVISIBLES.length)];
    const position = Math.floor(hasard() * sortie.length);
    sortie = sortie.slice(0, position) + caractere + sortie.slice(position);
  }
  return sortie;
}

export function tirerPublication(
  racineDonnees: string,
  folderId: string,
  profileId: string,
  hasard: () => number = Math.random,
  partMedia: number = PART_AVEC_MEDIA
): { post: string | null; media: string | null; epuise: boolean } {
  const lot = lireLotPublication(racineDonnees, folderId);
  const historique = lireHistoriquePublication(racineDonnees, folderId);
  const sien = historique[profileId] || { posts: [], medias: [] };

  const choisir = (disponibles: string[], dejaSiens: string[]) => {
    if (disponibles.length === 0) return { valeur: null as string | null, epuise: false };
    const jamaisPris = disponibles.filter(valeur => !dejaSiens.includes(valeur));
    // Ce compte a tout publie : on repart sur l'ensemble plutot que de ne rien
    // envoyer, et on le signale.
    const source = jamaisPris.length > 0 ? jamaisPris : disponibles;
    const pris = Object.entries(historique)
      .filter(([identifiant]) => identifiant !== profileId)
      .flatMap(([, valeur]) => [...(valeur.posts || []), ...(valeur.medias || [])]);
    const choix = tirer(source, pris, hasard);
    return { valeur: choix.valeur, epuise: jamaisPris.length === 0 };
  };

  const post = choisir(lot.posts, sien.posts);

  /* Le media, une fois sur deux environ. Le tirage a lieu AVANT de piocher :
     un post sans media ne doit pas consommer une image de la reserve, sinon
     elle se viderait deux fois plus vite pour rien. */
  const avecMedia = lot.medias.length > 0
    && (!post.valeur || hasard() < partMedia);
  const media = avecMedia
    ? choisir(lot.medias, sien.medias)
    : { valeur: null as string | null, epuise: false };

  if (post.valeur || media.valeur) {
    historique[profileId] = {
      posts: [...sien.posts, ...(post.valeur ? [post.valeur] : [])].slice(-200),
      medias: [...sien.medias, ...(media.valeur ? [media.valeur] : [])].slice(-200),
    };
    const chemin = cheminHistorique(racineDonnees, folderId);
    fs.mkdirSync(path.dirname(chemin), { recursive: true });
    const temporaire = `${chemin}.${process.pid}.tmp`;
    fs.writeFileSync(temporaire, JSON.stringify(historique, null, 2), 'utf8');
    fs.renameSync(temporaire, chemin);
  }

  /* L'historique vient d'etre ecrit avec le texte d'origine : c'est lui qui
     dit ce qu'un compte a deja envoye, et il doit rester comparable a la
     reserve. Seule la copie qui part sur X est rendue unique. */
  return {
    post: post.valeur ? rendreUnique(post.valeur, hasard) : null,
    media: media.valeur,
    epuise: post.epuise,
  };
}

// --- Ce qui a reellement abouti -----------------------------------------------
//
// Les attributions et l'historique disent ce qui a ete *tire*, pas ce qui est
// *parti*. Le tirage a lieu avant l'ouverture du navigateur : un compte peut
// avoir sa photo attribuee et n'avoir jamais rien recu.

export type ResultatAction = {
  statut: 'reussi' | 'echoue';
  quand: string;
  message: string;
  apercu?: string | null;
};

export type ResultatsProfil = {
  branding?: ResultatAction;
  post?: ResultatAction;
  /** Mise de cote : le branding et la publication la sautent. */
  ecartee?: { quand: string; raison: string } | null;
};

function cheminResultats(racineDonnees: string, folderId: string): string {
  return path.join(cheminLotBranding(racineDonnees, folderId), 'resultats.json');
}

export function lireResultats(
  racineDonnees: string,
  folderId: string
): Record<string, ResultatsProfil> {
  const chemin = cheminResultats(racineDonnees, folderId);
  if (!fs.existsSync(chemin)) return {};
  try {
    const contenu = JSON.parse(fs.readFileSync(chemin, 'utf8'));
    return contenu && typeof contenu === 'object' ? contenu : {};
  } catch {
    return {};
  }
}

export function ecrireResultat(
  racineDonnees: string,
  folderId: string,
  profileId: string,
  sorte: 'branding' | 'post',
  resultat: ResultatAction
): void {
  const tous = lireResultats(racineDonnees, folderId);
  tous[profileId] = { ...(tous[profileId] || {}), [sorte]: resultat };
  const chemin = cheminResultats(racineDonnees, folderId);
  fs.mkdirSync(path.dirname(chemin), { recursive: true });
  const temporaire = `${chemin}.${process.pid}.tmp`;
  fs.writeFileSync(temporaire, JSON.stringify(tous, null, 2), 'utf8');
  fs.renameSync(temporaire, chemin);
}

/**
 * Met une instance de cote, ou la remet en service.
 *
 * Une instance que X refuse de laisser passer revient en echec a chaque tour :
 * elle occupe une place, consomme du temps et noie les vrais echecs dans le
 * bilan. La mettre de cote la sort des lots sans la supprimer.
 */
export function marquerEcartee(
  racineDonnees: string,
  folderId: string,
  profileId: string,
  ecartee: boolean,
  raison = ''
): void {
  const tous = lireResultats(racineDonnees, folderId);
  tous[profileId] = {
    ...(tous[profileId] || {}),
    ecartee: ecartee ? { quand: new Date().toISOString(), raison } : null,
  };
  const chemin = cheminResultats(racineDonnees, folderId);
  fs.mkdirSync(path.dirname(chemin), { recursive: true });
  const temporaire = `${chemin}.${process.pid}.tmp`;
  fs.writeFileSync(temporaire, JSON.stringify(tous, null, 2), 'utf8');
  fs.renameSync(temporaire, chemin);
}

/**
 * Rend son post a la reserve quand la publication a echoue.
 *
 * Le tirage est enregistre a l'ouverture, avant qu'on sache si ca aboutira.
 * Sans cela, une serie d'echecs viderait la reserve sans qu'une seule
 * publication soit partie.
 */
export function rendrePublication(
  racineDonnees: string,
  folderId: string,
  profileId: string,
  post: string | null,
  media: string | null
): void {
  const historique = lireHistoriquePublication(racineDonnees, folderId);
  const sien = historique[profileId];
  if (!sien) return;
  /* On compare ce qui se lit, pas ce qui s'ecrit.
     L'historique garde le texte d'origine, mais celui qu'on nous rend a
     traverse rendreUnique() et porte des caracteres de largeur nulle. Les
     comparer tels quels ne trouvait jamais rien : le post ne revenait pas
     dans la reserve, et le compte le perdait pour toujours. */
  const retirerDernier = (liste: string[], valeur: string | null) => {
    if (!valeur) return liste;
    const cherche = sansInvisibles(valeur);
    for (let i = liste.length - 1; i >= 0; i--) {
      if (sansInvisibles(liste[i]) === cherche) {
        return [...liste.slice(0, i), ...liste.slice(i + 1)];
      }
    }
    return liste;
  };
  historique[profileId] = {
    posts: retirerDernier(sien.posts || [], post),
    medias: retirerDernier(sien.medias || [], media),
  };
  const chemin = cheminHistorique(racineDonnees, folderId);
  const temporaire = `${chemin}.${process.pid}.tmp`;
  fs.writeFileSync(temporaire, JSON.stringify(historique, null, 2), 'utf8');
  fs.renameSync(temporaire, chemin);
}

/** Prepare les sous-dossiers pour que l'utilisateur sache ou deposer ses fichiers. */
export function preparerDossierBranding(racineDonnees: string, folderId: string): string {
  const base = cheminLotBranding(racineDonnees, folderId);
  fs.mkdirSync(path.join(base, 'photos'), { recursive: true });
  fs.mkdirSync(path.join(base, 'bannieres'), { recursive: true });
  fs.mkdirSync(path.join(base, 'medias'), { recursive: true });
  for (const [fichier, exemple] of [
    ['bios.txt', '# Une bio par ligne. Les lignes vides et les # sont ignorees.\n'],
    ['noms.txt', '# Un nom affiche par ligne.\n'],
    ['lieux.txt', '# Un lieu par ligne. Le pays devant est facultatif :\n# US | Miami, FL\n'],
    ['posts.txt',
      '# Un post par ligne. Chaque compte en recoit un different.\n' +
      '# Pour un post sur plusieurs lignes, separe tes posts par une ligne ---\n'],
  ] as const) {
    const chemin = path.join(base, fichier);
    if (!fs.existsSync(chemin)) fs.writeFileSync(chemin, exemple, 'utf8');
  }
  return base;
}
