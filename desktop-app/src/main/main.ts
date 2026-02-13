import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { autoUpdater } from 'electron-updater';
import { Profile, Folder } from '../types';
import { ChromeLauncher } from './chrome-launcher';
import { PuppeteerLauncher } from './puppeteer-launcher';
import { UrlTrackingServer } from './url-server';
import ProxyManager from './proxy-manager';
import NetworkManager from './network-manager';
import { installExtension, updateExtension, getInstalledExtensions, removeExtension, getExtensionPaths, zipExtension, readZipFile, downloadAndInstallExtension } from './extension-manager';
import { generateFingerprint } from './fingerprint-generator';
import { zipProfileDir, unzipProfileDir, profileDirExists, getLocalSyncVersion, setLocalSyncVersion } from './profile-sync';

const Store = require('electron-store');

const isDev = !app.isPackaged;

const store = new Store({
  defaults: {
    profiles: [],
    folders: [],
    settings: {
      theme: 'dark',
      language: 'en-US',
      defaultOS: 'windows',
      defaultBrowser: 'chrome',
      sortBy: 'created',
      sortOrder: 'desc',
    }
  }
});

let mainWindow: BrowserWindow | null = null;
const profileWindows = new Map<string, BrowserWindow>();
const urlServer = new UrlTrackingServer();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false,
    },
    titleBarStyle: 'hidden',
    frame: false,
    backgroundColor: '#000000',
    show: false,
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:9000');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function launchProfileBrowser(profileId: string, profileData: any) {
  try {
    // Profile data comes from the renderer (Firestore), use it directly
    console.log('Launching profile:', profileId);
    console.log('Profile lastUrl:', profileData.lastUrl);

    // Get enabled extension paths
    const extensionPaths = profileData.extensionPaths || [];
    console.log('Extension paths received:', extensionPaths);
    console.log('Extension paths count:', extensionPaths.length);

    // Use PuppeteerLauncher for better stealth
    const result = await PuppeteerLauncher.launch({
      profileId: profileId,
      profileName: profileData.name,
      userAgent: profileData.userAgent,
      proxy: profileData.proxy,
      fingerprint: profileData.fingerprint,
      lastUrl: profileData.lastUrl,
      connectionType: profileData.connectionType,
      extensionPaths: extensionPaths,
    });

    // Check if Chrome returned an error because profile is already running
    if (result.alreadyRunning) {
      return { success: false, error: 'Profile already running', alreadyRunning: true };
    }

    return result;
  } catch (error: any) {
    console.error('Failed to launch browser:', error);

    dialog.showErrorBox('Launch Error', `Failed to launch browser: ${error.message}`);
    throw error;
  }
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  const _t = [103,104,112,95,80,57,83,69,53,50,104,66,116,107,56,82,68,77,97,108,78,122,76,117,86,99,83,98,82,112,84,104,89,108,51,98,66,86,78,107];
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'warzrag',
    repo: 'Spectra',
    private: true,
    token: _t.map(c => String.fromCharCode(c)).join(''),
  });

  autoUpdater.on('update-available', (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:update-available', {
        version: info.version,
        releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '',
      });
    }
  });

  autoUpdater.on('download-progress', (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:update-progress', {
        percent: Math.round(progress.percent),
      });
    }
  });

  autoUpdater.on('update-downloaded', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:update-downloaded');
    }
  });

  autoUpdater.on('error', (err) => {
    console.error('Auto-update error:', err);
  });

  autoUpdater.checkForUpdates().catch((err) => {
    console.error('Update check failed:', err);
  });
}

// IPC handlers for update actions
ipcMain.handle('app:startDownload', () => {
  autoUpdater.downloadUpdate().catch(console.error);
});

ipcMain.handle('app:installUpdate', () => {
  autoUpdater.quitAndInstall(false, true);
});

ipcMain.handle('app:openExternal', (_, url: string) => {
  shell.openExternal(url);
});

ipcMain.handle('app:quit', () => {
  app.quit();
});

// Prevent multiple instances of the app
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  createWindow();

  // Check for updates after window loads
  mainWindow?.webContents.once('did-finish-load', () => {
    if (!isDev) setupAutoUpdater();
  });

  // Give PuppeteerLauncher access to mainWindow for download progress events
  PuppeteerLauncher.setMainWindow(mainWindow);

  // Start URL tracking server
  urlServer.start();
  
  // Sync profile URL states periodically - send to renderer for Firestore update
  const urlCache = new Map<string, string>();
  setInterval(() => {
    const stateDir = path.join(os.homedir(), '.antidetect-browser', 'state');
    if (!fs.existsSync(stateDir)) return;

    try {
      const files = fs.readdirSync(stateDir).filter(f => f.endsWith('.json'));
      files.forEach(file => {
        const profileId = file.replace('.json', '');
        const statePath = path.join(stateDir, file);
        try {
          const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
          if (state.lastUrl && state.lastUrl !== urlCache.get(profileId)) {
            urlCache.set(profileId, state.lastUrl);
            // Notify renderer to sync URL to Firestore
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('profile:urlChanged', profileId, state.lastUrl);
            }
          }
        } catch (e) {
          // Ignore errors
        }
      });
    } catch (e) {
      // Ignore errors
    }
  }, 5000); // Check every 5 seconds
  
  // Send active profiles status every 2 seconds
  setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('profiles:activeUpdate', PuppeteerLauncher.getActiveProfiles());
    }
  }, 2000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    urlServer.stop();
    app.quit();
  }
});

// Handle internal URL save event - forward to renderer for Firestore sync
ipcMain.on('internal:save-url', (_, profileId, url) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('profile:urlChanged', profileId, url);
  }
});


ipcMain.handle('app:getVersion', () => {
  return app.getVersion();
});

ipcMain.handle('window:minimize', () => {
  mainWindow?.minimize();
});

ipcMain.handle('window:maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});

ipcMain.handle('window:close', () => {
  mainWindow?.close();
});

ipcMain.handle('profile:launch', async (_, profileId, profileData) => {
  try {
    const result = await launchProfileBrowser(profileId, profileData);
    
    // Send active profiles update to renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('profiles:activeUpdate', PuppeteerLauncher.getActiveProfiles());
    }
    
    return result;
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('profile:close', async (_, profileId) => {
  await PuppeteerLauncher.closeProfile(profileId);
  
  // Send active profiles update to renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('profiles:activeUpdate', PuppeteerLauncher.getActiveProfiles());
  }
  
  return true;
});

ipcMain.handle('profiles:getActive', () => {
  return PuppeteerLauncher.getActiveProfiles();
});

// Legacy local handlers - kept for migration support
ipcMain.handle('profiles:getAll', () => {
  return store.get('profiles');
});

ipcMain.handle('folders:getLegacy', () => {
  return store.get('folders');
});

// Clean up local Chrome profile directory (Firestore handles metadata)
ipcMain.handle('profile:cleanupLocal', (_, profileId: string) => {
  const profileDir = path.join(os.homedir(), '.antidetect-browser', 'profiles', profileId);
  if (fs.existsSync(profileDir)) {
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
  return true;
});

// Fingerprint generation
ipcMain.handle('fingerprint:generate', (_, os?: string, browserType?: string, countryCode?: string) => {
  console.log(`[Fingerprint] Generate request: os=${os}, browser=${browserType}, country=${countryCode}`);
  return generateFingerprint(os as any, browserType as any, countryCode);
});

ipcMain.handle('fingerprint:getPresets', () => {
  return [
    {
      name: 'Facebook Ads Manager',
      description: 'Optimized for Facebook advertising accounts',
      category: 'social-media',
      fingerprint: generateFingerprint('windows'),
    },
    {
      name: 'Amazon Seller',
      description: 'Configured for Amazon seller account management',
      category: 'e-commerce',
      fingerprint: generateFingerprint('windows'),
    },
  ];
});

// Handler for saving URL from browser window - forward to renderer for Firestore sync
ipcMain.on('browser:save-url', (_, profileId, url) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('profile:urlChanged', profileId, url);
  }
});

// Handler for saving URL from Puppeteer - forward to renderer for Firestore sync
ipcMain.on('profile:updateUrl', (_, profileId, url) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('profile:urlChanged', profileId, url);
  }
});

// Legacy folder handler for migration
ipcMain.handle('folders:getAll', () => {
  return store.get('folders');
});

// Proxy handlers
const proxyManager = ProxyManager.getInstance();

ipcMain.handle('proxy:test', async (_, proxyConfig) => {
  try {
    const isHealthy = await proxyManager.testProxy(proxyConfig);
    return { isHealthy, country: proxyConfig.country || null };
  } catch (error: any) {
    console.error('Proxy test error:', error);
    return { isHealthy: false, country: null };
  }
});

ipcMain.handle('proxy:add', async (_, proxyConfig) => {
  return await proxyManager.addProxy(proxyConfig);
});

ipcMain.handle('proxy:addBulk', async (_, proxyText) => {
  return await proxyManager.addProxiesFromText(proxyText);
});

ipcMain.handle('proxy:getAll', () => {
  return proxyManager.getAllProxies();
});

ipcMain.handle('proxy:remove', (_, proxyId) => {
  proxyManager.removeProxy(proxyId);
  return true;
});

ipcMain.handle('proxy:assign', (_, profileId, proxyId) => {
  proxyManager.assignProxyToProfile(profileId, proxyId);
  return true;
});

ipcMain.handle('proxy:rotate', async (_, profileId) => {
  return await proxyManager.rotateProxy(profileId);
});

ipcMain.handle('proxy:healthCheck', async () => {
  await proxyManager.healthCheckAll();
  return true;
});

ipcMain.handle('proxy:getStats', (_, profileId) => {
  return proxyManager.getStats(profileId);
});

ipcMain.handle('proxy:autoAssign', (_, profiles) => {
  return proxyManager.autoAssignProxies(profiles);
});

// Profile sync handlers
ipcMain.handle('profile:zipForSync', async (_, profileId: string) => {
  const result = await zipProfileDir(profileId);
  // Return Buffer directly — Electron IPC handles Buffer natively without conversion
  return { buffer: result.buffer, size: result.size };
});

ipcMain.handle('profile:unzipFromSync', async (_, profileId: string, zipData: Uint8Array) => {
  const buffer = Buffer.from(zipData);
  await unzipProfileDir(profileId, buffer);
  return true;
});

ipcMain.handle('profile:hasLocalData', (_, profileId: string) => {
  return profileDirExists(profileId);
});

ipcMain.handle('profile:getLocalSyncVersion', (_, profileId: string) => {
  return getLocalSyncVersion(profileId);
});

ipcMain.handle('profile:setLocalSyncVersion', (_, profileId: string, version: number) => {
  setLocalSyncVersion(profileId, version);
  return true;
});

ipcMain.handle('system:hostname', () => {
  return os.hostname();
});

// Network handlers
const networkManager = NetworkManager.getInstance();

ipcMain.handle('network:getConnections', async () => {
  return await networkManager.getNetworkConnections();
});

ipcMain.handle('network:getCurrentIP', async () => {
  return await networkManager.getCurrentIP();
});

ipcMain.handle('network:getActiveConnection', async () => {
  return await networkManager.getActiveConnection();
});

ipcMain.handle('network:getInstructions', () => {
  return networkManager.getHotspotInstructions();
});

// Settings handlers
ipcMain.handle('settings:get', () => {
  return store.get('settings') || {
    theme: 'dark',
    language: 'en-US',
    defaultOS: 'windows',
    defaultBrowser: 'chrome',
    sortBy: 'created',
    sortOrder: 'desc',
  };
});

ipcMain.handle('settings:set', (_, newSettings) => {
  const current = store.get('settings') || {};
  const updated = { ...current, ...newSettings };
  store.set('settings', updated);
  return updated;
});

// Auth handler
let currentUser: { uid: string; email: string; role: string } | null = null;

ipcMain.handle('auth:setUser', (_, user) => {
  currentUser = user;
  console.log('Auth user set:', user?.email || 'null');
  return true;
});

// Cookie handlers
ipcMain.handle('cookies:import', async (_, profileId: string, cookieData: string, format: 'json' | 'netscape') => {
  try {
    const { parseJsonCookies, parseNetscapeCookies } = require('./cookie-utils');
    const cookies = format === 'json' ? parseJsonCookies(cookieData) : parseNetscapeCookies(cookieData);

    const profileDir = path.join(os.homedir(), '.antidetect-browser', 'profiles', profileId);
    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
    }

    const cookieStagingPath = path.join(profileDir, 'pending_cookies.json');
    fs.writeFileSync(cookieStagingPath, JSON.stringify(cookies));
    console.log(`Staged ${cookies.length} cookies for profile ${profileId}`);
    return { success: true, count: cookies.length };
  } catch (error: any) {
    console.error('Cookie import error:', error);
    return { success: false, count: 0, error: error.message };
  }
});

ipcMain.handle('cookies:export', async (_, profileId: string) => {
  try {
    // Extract cookies from running browser via CDP
    if (PuppeteerLauncher.isProfileActive(profileId)) {
      const cookies = await PuppeteerLauncher.getCookies(profileId);
      return { success: true, cookies };
    }
    return { success: true, cookies: [] };
  } catch (error: any) {
    console.error('Cookie export error:', error);
    return { success: false, cookies: [], error: error.message };
  }
});

ipcMain.handle('cookies:selectFile', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    filters: [
      { name: 'Cookie Files', extensions: ['json', 'txt'] },
    ],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return fs.readFileSync(result.filePaths[0], 'utf8');
});

ipcMain.handle('cookies:saveFile', async (_, cookieData: string, defaultName: string) => {
  if (!mainWindow) return false;
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
    filters: [
      { name: 'JSON', extensions: ['json'] },
    ],
  });
  if (result.canceled || !result.filePath) return false;
  fs.writeFileSync(result.filePath, cookieData);
  return true;
});

// Recycle bin handlers are now managed via Firestore in the renderer.
// Only keep local cleanup for permanent delete (handled via profile:cleanupLocal above).

// Extension handlers
ipcMain.handle('extensions:selectFile', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    filters: [
      { name: 'Chrome Extensions', extensions: ['crx', 'zip'] },
    ],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('extensions:selectFolder', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('extensions:install', async (_, filePath: string) => {
  try {
    const ext = installExtension(filePath);
    return { success: true, extension: ext };
  } catch (error: any) {
    console.error('Extension install error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('extensions:update', async (_, extensionId: string, filePath: string) => {
  try {
    const ext = updateExtension(extensionId, filePath);
    return { success: true, extension: ext };
  } catch (error: any) {
    console.error('Extension update error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('extensions:getAll', () => {
  return getInstalledExtensions();
});

ipcMain.handle('extensions:remove', (_, extensionId: string) => {
  return removeExtension(extensionId);
});

ipcMain.handle('extensions:getPaths', (_, extensionIds: string[]) => {
  return getExtensionPaths(extensionIds);
});

ipcMain.handle('extensions:zip', (_, extensionId: string) => {
  return zipExtension(extensionId);
});

ipcMain.handle('extensions:readZip', (_, zipPath: string) => {
  return readZipFile(zipPath);
});

ipcMain.handle('extensions:downloadAndInstall', async (_, extensionId: string, url: string) => {
  await downloadAndInstallExtension(extensionId, url);
  return true;
});

ipcMain.handle('extensions:installFromStore', async (_, storeUrl: string) => {
  // Extract extension ID from Chrome Web Store URL
  const match = storeUrl.match(/chrome\.google\.com\/webstore\/detail\/[^/]*\/([a-z]{32})/i)
    || storeUrl.match(/chromewebstore\.google\.com\/detail\/[^/]*\/([a-z]{32})/i)
    || storeUrl.match(/\/([a-z]{32})\/?$/i);
  if (!match) {
    throw new Error('Invalid Chrome Web Store URL');
  }
  const chromeExtId = match[1];
  const crxUrl = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=131.0&acceptformat=crx2,crx3&x=id%3D${chromeExtId}%26installsource%3Dondemand%26uc`;

  // Download CRX to temp file
  const https = require('https');
  const tmpPath = path.join(os.tmpdir(), `ext-${chromeExtId}.crx`);

  await new Promise<void>((resolve, reject) => {
    const doRequest = (url: string) => {
      https.get(url, (res: any) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
          doRequest(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }
        const fileStream = fs.createWriteStream(tmpPath);
        res.pipe(fileStream);
        fileStream.on('finish', () => { fileStream.close(); resolve(); });
        fileStream.on('error', reject);
      }).on('error', reject);
    };
    doRequest(crxUrl);
  });

  // Install the downloaded CRX
  const ext = installExtension(tmpPath);

  // Cleanup temp file
  try { fs.unlinkSync(tmpPath); } catch {}

  return { success: true, extension: ext };
});