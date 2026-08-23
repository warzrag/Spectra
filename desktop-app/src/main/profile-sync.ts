import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import AdmZip from 'adm-zip';

// === INCLUDE-ONLY SYNC STRATEGY ===
// Instead of excluding bad dirs (still zips too much), we ONLY include essential files.
// This follows how GoLogin handles sync: cookies + local storage + session data only.
// Typical sync size: 1-5 MB instead of 50-200 MB.

// Files in Default/ to sync (these maintain sessions, cookies, identity)
const ESSENTIAL_FILES = new Set([
  'Cookies',
  'Cookies-journal',
  'Login Data',
  'Login Data-journal',
  'Web Data',
  'Web Data-journal',
  'Preferences',
  'Secure Preferences',
  'Bookmarks',
  'Bookmarks.bak',
  'Favicons',
  'Favicons-journal',
  'History',
  'History-journal',
  'Extension Cookies',
  'Extension Cookies-journal',
]);

// Directories in Default/ to sync entirely (contain session/identity data)
// Note: Extensions are synced separately via Firebase (ExtensionsPage), not here
const ESSENTIAL_DIRS = new Set([
  'Network',
  'Local Storage',
  'Session Storage',
  'IndexedDB',
  'Local Extension Settings',
  'Sync Extension Settings',
]);

// Root-level files to sync (Chrome profile config + CDP cookie/tab data)
const ROOT_FILES = new Set([
  'Local State',
  'First Run',
  '.sync_version',
  'synced_cookies.json',
  'authenticated_cookies.json',
  'fingerprint_override.json',
  'open_tabs.json',
  'last_url.txt',
]);

function getProfilesBaseDir(): string {
  return process.platform === 'win32'
    ? path.join(os.homedir(), 'AppData', 'Local', 'AntidetectBrowser', 'Profiles')
    : path.join(os.homedir(), '.antidetect-browser', 'profiles');
}

function getProfilePath(profileId: string): string {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(profileId)) {
    throw new Error('Invalid profile ID');
  }
  return path.join(getProfilesBaseDir(), profileId);
}

function addFile(zip: AdmZip, sourcePath: string, zipPath: string): void {
  try {
    zip.addFile(zipPath, fs.readFileSync(sourcePath));
  } catch (error: any) {
    // Journal files can disappear between existsSync and readFileSync.
    if (error?.code === 'ENOENT') return;
    throw new Error(`Unable to read profile data "${zipPath}": ${error?.message || error}`);
  }
}

function addDirRecursive(zip: AdmZip, dirPath: string, zipPrefix: string): void {
  if (!fs.existsSync(dirPath)) return;

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const zipPath = zipPrefix ? `${zipPrefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      addDirRecursive(zip, fullPath, zipPath);
    } else if (entry.isFile()) {
      addFile(zip, fullPath, zipPath);
    }
  }
}

function isAllowedArchivePath(entryName: string): boolean {
  const normalized = entryName.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized || normalized.startsWith('/') || normalized.includes('../')) return false;
  if (ROOT_FILES.has(normalized)) return true;
  if (!normalized.startsWith('Default/')) return false;

  const relative = normalized.slice('Default/'.length);
  if (ESSENTIAL_FILES.has(relative)) return true;
  return Array.from(ESSENTIAL_DIRS).some(dir => relative === dir || relative.startsWith(`${dir}/`));
}

/**
 * Compress only essential Chrome profile data into a zip buffer.
 * Syncs: cookies, local storage, sessions, login data, preferences, extensions.
 * Skips: caches, service workers, GPU data, blob storage, etc.
 */
// Ce que la restauration exige, l'envoi doit le verifier. Sans cette symetrie
// Spectra fabrique une archive qu'il refusera lui-meme d'ouvrir : constate le
// 13 aout 2026 sur trois profils, dont annlindabuckin2, ouvert quatre secondes
// par l'Auto Post puis ferme de force avant que Chrome ait ecrit ses
// preferences. L'archive incomplete avait ecrase la bonne version, et le profil
// etait devenu impossible a retelecharger sur toutes les machines.
export const CHEMIN_REQUIS_DANS_ARCHIVE = 'Default/Preferences';

export const CODE_ARCHIVE_INCOMPLETE = 'profile-sync/incomplete-local';

// Le passage entre les deux processus ne transporte que le message : la
// propriete `code` d'une erreur est perdue en route, comme le montre le
// libelle affiche a l'ecran ("Error invoking remote method ..."). Le code est
// donc inscrit dans le message lui-meme, pour rester reconnaissable de l'autre
// cote.
export class ArchiveLocaleIncomplete extends Error {
  code = CODE_ARCHIVE_INCOMPLETE;
  constructor(profileId: string) {
    super(
      `[${CODE_ARCHIVE_INCOMPLETE}] Le profil ${profileId} est incomplet en local ` +
      `(${CHEMIN_REQUIS_DANS_ARCHIVE} absent). Envoi annule : la version du cloud est conservee.`
    );
    this.name = 'ArchiveLocaleIncomplete';
  }
}

export async function zipProfileDir(profileId: string): Promise<{ buffer: Buffer; size: number }> {
  const profilePath = getProfilePath(profileId);

  if (!fs.existsSync(profilePath)) {
    throw new Error(`Profile directory not found: ${profilePath}`);
  }

  // Chrome n'ecrit ses preferences qu'a la fermeture propre. Un profil tue
  // avant cette ecriture ne doit pas partir : mieux vaut un envoi refuse
  // qu'une sauvegarde detruite.
  if (!fs.existsSync(path.join(profilePath, ...CHEMIN_REQUIS_DANS_ARCHIVE.split('/')))) {
    throw new ArchiveLocaleIncomplete(profileId);
  }

  console.log(`[ProfileSync] Zipping profile (essential-only): ${profileId}`);
  const zip = new AdmZip();
  const defaultPath = path.join(profilePath, 'Default');

  // 1. Add root-level files
  for (const file of ROOT_FILES) {
    const fullPath = path.join(profilePath, file);
    if (fs.existsSync(fullPath)) {
      addFile(zip, fullPath, file);
    }
  }

  // 2. Add essential files from Default/
  if (fs.existsSync(defaultPath)) {
    for (const file of ESSENTIAL_FILES) {
      const fullPath = path.join(defaultPath, file);
      if (fs.existsSync(fullPath)) {
        addFile(zip, fullPath, `Default/${file}`);
      }
    }

    // 3. Add essential directories from Default/ (recursively)
    for (const dir of ESSENTIAL_DIRS) {
      const fullPath = path.join(defaultPath, dir);
      if (fs.existsSync(fullPath)) {
        addDirRecursive(zip, fullPath, `Default/${dir}`);
      }
    }
  }

  const buffer = zip.toBuffer();
  console.log(`[ProfileSync] Zip size: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);

  return { buffer, size: buffer.length };
}

/**
 * Extract a zip buffer into a Chrome profile directory.
 * Replaces managed data directories and preserves unrelated local profile data.
 */
export async function unzipProfileDir(profileId: string, zipBuffer: Buffer): Promise<void> {
  const profilePath = getProfilePath(profileId);

  console.log(`[ProfileSync] Unzipping profile: ${profileId}`);

  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries().filter(entry => !entry.isDirectory);
  if (entries.length === 0) {
    throw new Error('Cloud profile archive is empty');
  }
  // Refuser une archive sans preferences condamnait le profil : impossible de
  // l'ouvrir, donc impossible de le refermer proprement, donc impossible de
  // reparer l'archive. Trois instances etaient bloquees ainsi depuis le 9 aout.
  //
  // Or ce fichier n'est pas vital a la restauration : Chrome le recree au
  // demarrage. Ce qui compte vraiment, c'est la session. On exige donc de quoi
  // la retablir, et l'absence des preferences n'est plus qu'un avertissement.
  //
  // L'envoi, lui, refuse desormais de produire une telle archive : voir
  // ArchiveLocaleIncomplete plus haut. Les deux regles se completent -- on ne
  // fabrique plus d'archive incomplete, et celles qui existent restent ouvrables.
  const chemins = new Set(entries.map(entry => entry.entryName.replace(/\\/g, '/')));
  const porteUneSession = [
    'Default/Network/Cookies',
    'Default/Cookies',
    'Local State',
    'authenticated_cookies.json',
    'synced_cookies.json',
  ].some(chemin => chemins.has(chemin));
  if (!porteUneSession) {
    throw new Error(
      "Cloud profile archive is unusable (no session data: cookies or Local State missing)"
    );
  }
  if (!chemins.has(CHEMIN_REQUIS_DANS_ARCHIVE)) {
    console.warn(
      `[ProfileSync] ${profileId}: archive sans ${CHEMIN_REQUIS_DANS_ARCHIVE}, ` +
      'restauration poursuivie (Chrome recreera ce fichier au demarrage)'
    );
  }
  for (const entry of entries) {
    if (!isAllowedArchivePath(entry.entryName)) {
      throw new Error(`Cloud profile archive contains an invalid path: ${entry.entryName}`);
    }
  }

  const transactionId = `${process.pid}-${Date.now()}`;
  const stagingPath = `${profilePath}.restore-${transactionId}`;
  const backupPath = `${profilePath}.backup-${transactionId}`;
  fs.mkdirSync(stagingPath, { recursive: true });

  const stagedRoot = path.resolve(stagingPath);
  const representedPaths = new Set<string>();

  try {
    for (const entry of entries) {
      const normalized = entry.entryName.replace(/\\/g, '/');
      const targetPath = path.resolve(stagingPath, ...normalized.split('/'));
      if (!targetPath.startsWith(`${stagedRoot}${path.sep}`)) {
        throw new Error(`Cloud profile archive path escapes staging: ${entry.entryName}`);
      }

      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, entry.getData());

      if (ROOT_FILES.has(normalized)) {
        representedPaths.add(normalized);
      } else {
        const relative = normalized.slice('Default/'.length);
        const managedDir = Array.from(ESSENTIAL_DIRS).find(dir =>
          relative === dir || relative.startsWith(`${dir}/`)
        );
        representedPaths.add(managedDir ? `Default/${managedDir}` : normalized);
      }
    }

    fs.mkdirSync(profilePath, { recursive: true });
    fs.mkdirSync(backupPath, { recursive: true });

    const installedPaths: string[] = [];
    const backedUpPaths: string[] = [];
    try {
      for (const relativePath of representedPaths) {
        const currentPath = path.join(profilePath, ...relativePath.split('/'));
        const stagedPath = path.join(stagingPath, ...relativePath.split('/'));
        const savedPath = path.join(backupPath, ...relativePath.split('/'));

        if (fs.existsSync(currentPath)) {
          fs.mkdirSync(path.dirname(savedPath), { recursive: true });
          fs.renameSync(currentPath, savedPath);
          backedUpPaths.push(relativePath);
        }

        fs.mkdirSync(path.dirname(currentPath), { recursive: true });
        fs.renameSync(stagedPath, currentPath);
        installedPaths.push(relativePath);
      }
    } catch (error) {
      for (const relativePath of installedPaths.reverse()) {
        fs.rmSync(path.join(profilePath, ...relativePath.split('/')), { recursive: true, force: true });
      }
      for (const relativePath of backedUpPaths.reverse()) {
        const savedPath = path.join(backupPath, ...relativePath.split('/'));
        const currentPath = path.join(profilePath, ...relativePath.split('/'));
        if (fs.existsSync(savedPath)) {
          fs.mkdirSync(path.dirname(currentPath), { recursive: true });
          fs.renameSync(savedPath, currentPath);
        }
      }
      throw error;
    }
  } finally {
    fs.rmSync(stagingPath, { recursive: true, force: true });
    fs.rmSync(backupPath, { recursive: true, force: true });
  }

  console.log(`[ProfileSync] Profile extracted successfully (${entries.length} files)`);
}

/**
 * Check if a local Chrome profile directory exists with actual data.
 */
export function profileDirExists(profileId: string): boolean {
  const profilePath = getProfilePath(profileId);
  if (!fs.existsSync(profilePath)) return false;

  // Check for Default/Preferences as indicator of a real profile
  const prefsPath = path.join(profilePath, 'Default', 'Preferences');
  return fs.existsSync(prefsPath);
}

/**
 * Get the local sync version for a profile.
 * Returns 0 if no sync version file exists.
 */
export function getLocalSyncVersion(profileId: string): number {
  const versionPath = path.join(getProfilePath(profileId), '.sync_version');
  try {
    if (fs.existsSync(versionPath)) {
      return parseInt(fs.readFileSync(versionPath, 'utf8').trim(), 10) || 0;
    }
  } catch {}
  return 0;
}

/**
 * Set the local sync version for a profile.
 */
export function setLocalSyncVersion(profileId: string, version: number): void {
  const profilePath = getProfilePath(profileId);
  if (!fs.existsSync(profilePath)) {
    fs.mkdirSync(profilePath, { recursive: true });
  }
  fs.writeFileSync(path.join(profilePath, '.sync_version'), String(version));
}

export function getLocalSyncRevision(profileId: string): string | null {
  const revisionPath = path.join(getProfilePath(profileId), '.sync_revision');
  try {
    if (fs.existsSync(revisionPath)) {
      return fs.readFileSync(revisionPath, 'utf8').trim() || null;
    }
  } catch {}
  return null;
}

export function setLocalSyncRevision(profileId: string, revision: string): void {
  const profilePath = getProfilePath(profileId);
  if (!fs.existsSync(profilePath)) {
    fs.mkdirSync(profilePath, { recursive: true });
  }
  fs.writeFileSync(path.join(profilePath, '.sync_revision'), revision);
}
