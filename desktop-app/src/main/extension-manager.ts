import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import AdmZip from 'adm-zip';

const EXTENSIONS_DIR = path.join(os.homedir(), '.antidetect-browser', 'extensions');

export interface InstalledExtension {
  id: string;
  name: string;
  version: string;
  description: string;
  localPath: string;
  updatedAt?: string;
}

function ensureExtensionsDir(): void {
  if (!fs.existsSync(EXTENSIONS_DIR)) {
    fs.mkdirSync(EXTENSIONS_DIR, { recursive: true });
  }
}

function readManifest(extDir: string): { name: string; version: string; description: string } | null {
  const manifestPath = path.join(extDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return {
      name: manifest.name || 'Unknown Extension',
      version: manifest.version || '0.0.0',
      description: manifest.description || '',
    };
  } catch {
    return null;
  }
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

export function installExtension(filePath: string): InstalledExtension {
  ensureExtensionsDir();

  const extId = Date.now().toString();
  const extDir = path.join(EXTENSIONS_DIR, extId);
  fs.mkdirSync(extDir, { recursive: true });

  try {
    // Check if filePath is a directory (unpacked extension)
    if (fs.statSync(filePath).isDirectory()) {
      copyDirRecursive(filePath, extDir);

      const manifest = readManifest(extDir);
      if (!manifest) {
        fs.rmSync(extDir, { recursive: true, force: true });
        throw new Error('Invalid extension: no manifest.json found in folder');
      }

      return {
        id: extId,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        localPath: extDir,
      };
    }

    // File-based install (.crx or .zip)
    const fileBuffer = fs.readFileSync(filePath);
    let zipBuffer = fileBuffer;

    // .crx files have a header before the zip data
    // CRX3 format: "Cr24" magic + version(4) + header_length(4) + header + zip
    // CRX2 format: "Cr24" magic + version(4) + pk_length(4) + sig_length(4) + pk + sig + zip
    const magic = fileBuffer.toString('ascii', 0, 4);
    if (magic === 'Cr24') {
      const version = fileBuffer.readUInt32LE(4);
      if (version === 3) {
        // CRX3: header length at offset 8
        const headerLength = fileBuffer.readUInt32LE(8);
        zipBuffer = fileBuffer.subarray(12 + headerLength);
      } else if (version === 2) {
        // CRX2: public key length at offset 8, signature length at offset 12
        const pkLength = fileBuffer.readUInt32LE(8);
        const sigLength = fileBuffer.readUInt32LE(12);
        zipBuffer = fileBuffer.subarray(16 + pkLength + sigLength);
      }
    }

    const zip = new AdmZip(zipBuffer as Buffer);
    zip.extractAllTo(extDir, true);

    // Check if contents are inside a subfolder (some zips have a root folder)
    const entries = fs.readdirSync(extDir);
    if (entries.length === 1) {
      const subDir = path.join(extDir, entries[0]);
      if (fs.statSync(subDir).isDirectory() && fs.existsSync(path.join(subDir, 'manifest.json'))) {
        // Move contents up
        const subEntries = fs.readdirSync(subDir);
        for (const entry of subEntries) {
          fs.renameSync(path.join(subDir, entry), path.join(extDir, entry));
        }
        fs.rmdirSync(subDir);
      }
    }

    const manifest = readManifest(extDir);
    if (!manifest) {
      fs.rmSync(extDir, { recursive: true, force: true });
      throw new Error('Invalid extension: no manifest.json found');
    }

    return {
      id: extId,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      localPath: extDir,
    };
  } catch (error: any) {
    // Cleanup on failure
    if (fs.existsSync(extDir)) {
      fs.rmSync(extDir, { recursive: true, force: true });
    }
    throw error;
  }
}

/**
 * Update an existing extension in-place (keeps same ID → preserves chrome.storage data).
 * Replaces all files but keeps the directory.
 */
export function updateExtension(extensionId: string, filePath: string): InstalledExtension {
  const extDir = path.join(EXTENSIONS_DIR, extensionId);
  if (!fs.existsSync(extDir)) {
    throw new Error(`Extension ${extensionId} not found`);
  }

  // Backup current version
  const backupDir = extDir + '.backup';
  if (fs.existsSync(backupDir)) {
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
  fs.cpSync(extDir, backupDir, { recursive: true });

  try {
    // Clear existing files (but keep the directory itself)
    const existing = fs.readdirSync(extDir);
    for (const entry of existing) {
      fs.rmSync(path.join(extDir, entry), { recursive: true, force: true });
    }

    if (fs.statSync(filePath).isDirectory()) {
      copyDirRecursive(filePath, extDir);
    } else {
      // File-based (.crx or .zip)
      const fileBuffer = fs.readFileSync(filePath);
      let zipBuffer = fileBuffer;

      const magic = fileBuffer.toString('ascii', 0, 4);
      if (magic === 'Cr24') {
        const version = fileBuffer.readUInt32LE(4);
        if (version === 3) {
          const headerLength = fileBuffer.readUInt32LE(8);
          zipBuffer = fileBuffer.subarray(12 + headerLength);
        } else if (version === 2) {
          const pkLength = fileBuffer.readUInt32LE(8);
          const sigLength = fileBuffer.readUInt32LE(12);
          zipBuffer = fileBuffer.subarray(16 + pkLength + sigLength);
        }
      }

      const zip = new AdmZip(zipBuffer as Buffer);
      zip.extractAllTo(extDir, true);

      // Check for subfolder pattern
      const entries = fs.readdirSync(extDir);
      if (entries.length === 1) {
        const subDir = path.join(extDir, entries[0]);
        if (fs.statSync(subDir).isDirectory() && fs.existsSync(path.join(subDir, 'manifest.json'))) {
          const subEntries = fs.readdirSync(subDir);
          for (const entry of subEntries) {
            fs.renameSync(path.join(subDir, entry), path.join(extDir, entry));
          }
          fs.rmdirSync(subDir);
        }
      }
    }

    const manifest = readManifest(extDir);
    if (!manifest) {
      throw new Error('Invalid extension: no manifest.json found');
    }

    // Remove backup on success
    if (fs.existsSync(backupDir)) {
      fs.rmSync(backupDir, { recursive: true, force: true });
    }

    // Save updatedAt for sync
    const updatedAt = new Date().toISOString();
    fs.writeFileSync(path.join(extDir, '.sync_meta'), updatedAt);

    return {
      id: extensionId,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      localPath: extDir,
      updatedAt,
    };
  } catch (error: any) {
    // Restore backup on failure
    if (fs.existsSync(backupDir)) {
      const existing = fs.readdirSync(extDir);
      for (const entry of existing) {
        fs.rmSync(path.join(extDir, entry), { recursive: true, force: true });
      }
      const backupEntries = fs.readdirSync(backupDir);
      for (const entry of backupEntries) {
        fs.renameSync(path.join(backupDir, entry), path.join(extDir, entry));
      }
      fs.rmSync(backupDir, { recursive: true, force: true });
    }
    throw error;
  }
}

export function getInstalledExtensions(): InstalledExtension[] {
  ensureExtensionsDir();

  const extensions: InstalledExtension[] = [];
  const entries = fs.readdirSync(EXTENSIONS_DIR);

  for (const entry of entries) {
    const extDir = path.join(EXTENSIONS_DIR, entry);
    if (!fs.statSync(extDir).isDirectory()) continue;

    const manifest = readManifest(extDir);
    if (manifest) {
      let updatedAt: string | undefined;
      const metaPath = path.join(extDir, '.sync_meta');
      if (fs.existsSync(metaPath)) {
        try { updatedAt = fs.readFileSync(metaPath, 'utf8').trim(); } catch {}
      }
      extensions.push({
        id: entry,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        localPath: extDir,
        updatedAt,
      });
    }
  }

  return extensions;
}

export function removeExtension(extensionId: string): boolean {
  const extDir = path.join(EXTENSIONS_DIR, extensionId);
  if (fs.existsSync(extDir)) {
    fs.rmSync(extDir, { recursive: true, force: true });
    return true;
  }
  return false;
}

export function getExtensionPaths(extensionIds: string[]): string[] {
  return extensionIds
    .map(id => path.join(EXTENSIONS_DIR, id))
    .filter(p => fs.existsSync(p) && fs.existsSync(path.join(p, 'manifest.json')));
}

export function zipExtension(extensionId: string): string {
  const extDir = path.join(EXTENSIONS_DIR, extensionId);
  if (!fs.existsSync(extDir)) throw new Error(`Extension ${extensionId} not found locally`);

  const zipPath = path.join(EXTENSIONS_DIR, `${extensionId}.zip`);
  const zip = new AdmZip();
  zip.addLocalFolder(extDir);
  zip.writeZip(zipPath);
  return zipPath;
}

export function readZipFile(zipPath: string): Buffer {
  return fs.readFileSync(zipPath);
}

export function downloadAndInstallExtension(extensionId: string, url: string, updatedAt?: string): Promise<void> {
  ensureExtensionsDir();
  const extDir = path.join(EXTENSIONS_DIR, extensionId);

  // Already installed
  if (fs.existsSync(extDir) && fs.existsSync(path.join(extDir, 'manifest.json'))) {
    // Save sync metadata if provided
    if (updatedAt) {
      fs.writeFileSync(path.join(extDir, '.sync_meta'), updatedAt);
    }
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const https = require('https');
    const http = require('http');
    const client = url.startsWith('https') ? https : http;

    const doRequest = (requestUrl: string) => {
      client.get(requestUrl, (res: any) => {
        // Follow redirects
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
          doRequest(res.headers.location);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }

        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const zipBuffer = Buffer.concat(chunks);
            fs.mkdirSync(extDir, { recursive: true });

            const zip = new AdmZip(zipBuffer);
            zip.extractAllTo(extDir, true);

            // Check for subfolder pattern
            const entries = fs.readdirSync(extDir);
            if (entries.length === 1) {
              const subDir = path.join(extDir, entries[0]);
              if (fs.statSync(subDir).isDirectory() && fs.existsSync(path.join(subDir, 'manifest.json'))) {
                const subEntries = fs.readdirSync(subDir);
                for (const entry of subEntries) {
                  fs.renameSync(path.join(subDir, entry), path.join(extDir, entry));
                }
                fs.rmdirSync(subDir);
              }
            }

            if (!fs.existsSync(path.join(extDir, 'manifest.json'))) {
              fs.rmSync(extDir, { recursive: true, force: true });
              reject(new Error('Downloaded extension has no manifest.json'));
              return;
            }

            // Save sync metadata
            if (updatedAt) {
              fs.writeFileSync(path.join(extDir, '.sync_meta'), updatedAt);
            }

            resolve();
          } catch (e) {
            if (fs.existsSync(extDir)) fs.rmSync(extDir, { recursive: true, force: true });
            reject(e);
          }
        });
        res.on('error', reject);
      }).on('error', reject);
    };

    doRequest(url);
  });
}
