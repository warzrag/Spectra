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

function addDirRecursive(zip: AdmZip, dirPath: string, zipPrefix: string): void {
  if (!fs.existsSync(dirPath)) return;

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const zipPath = zipPrefix ? `${zipPrefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      addDirRecursive(zip, fullPath, zipPath);
    } else if (entry.isFile()) {
      try {
        const content = fs.readFileSync(fullPath);
        zip.addFile(zipPath, content);
      } catch {
        // Skip locked files
      }
    }
  }
}

/**
 * Compress only essential Chrome profile data into a zip buffer.
 * Syncs: cookies, local storage, sessions, login data, preferences, extensions.
 * Skips: caches, service workers, GPU data, blob storage, etc.
 */
export async function zipProfileDir(profileId: string): Promise<{ buffer: Buffer; size: number }> {
  const profilePath = getProfilePath(profileId);

  if (!fs.existsSync(profilePath)) {
    throw new Error(`Profile directory not found: ${profilePath}`);
  }

  console.log(`[ProfileSync] Zipping profile (essential-only): ${profileId}`);
  const zip = new AdmZip();
  const defaultPath = path.join(profilePath, 'Default');

  // 1. Add root-level files
  for (const file of ROOT_FILES) {
    const fullPath = path.join(profilePath, file);
    if (fs.existsSync(fullPath)) {
      try {
        zip.addFile(file, fs.readFileSync(fullPath));
      } catch {}
    }
  }

  // 2. Add essential files from Default/
  if (fs.existsSync(defaultPath)) {
    for (const file of ESSENTIAL_FILES) {
      const fullPath = path.join(defaultPath, file);
      if (fs.existsSync(fullPath)) {
        try {
          zip.addFile(`Default/${file}`, fs.readFileSync(fullPath));
        } catch {}
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

  // Create profile dir if it doesn't exist
  fs.mkdirSync(profilePath, { recursive: true });

  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();
  const profileRoot = path.resolve(profilePath);

  // LevelDB-backed directories cannot be merged file by file. Stale MANIFEST,
  // LOG or table files can win over the downloaded state and lose extension
  // keys. Replace every managed directory represented by this snapshot.
  for (const dir of ESSENTIAL_DIRS) {
    const zipPrefix = `Default/${dir}/`;
    const isIncluded = entries.some(entry =>
      entry.entryName.replace(/\\/g, '/').startsWith(zipPrefix)
    );
    if (!isIncluded) continue;

    const targetDir = path.resolve(profilePath, 'Default', dir);
    if (targetDir.startsWith(`${profileRoot}${path.sep}`) && fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  }

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    const targetPath = path.resolve(profilePath, entry.entryName);
    if (!targetPath.startsWith(`${profileRoot}${path.sep}`)) {
      console.warn(`[ProfileSync] Skipped unsafe archive path: ${entry.entryName}`);
      continue;
    }
    const targetDir = path.dirname(targetPath);

    try {
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(targetPath, entry.getData());
    } catch (err) {
      console.warn(`[ProfileSync] Failed to extract: ${entry.entryName}`, err);
    }
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
