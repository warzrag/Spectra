import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { autoUpdater } from 'electron-updater';
import { Profile, Folder } from '../types';
import { ChromeLauncher } from './chrome-launcher';
import { resolveLaunchMode } from '../shared/launch-policy';
import { hasAuthenticatedXSession } from '../shared/x-auth-snapshot';
import { PuppeteerLauncher } from './puppeteer-launcher';
import { UrlTrackingServer } from './url-server';
import ProxyManager from './proxy-manager';
import NetworkManager from './network-manager';
import { installExtension, updateExtension, getInstalledExtensions, removeExtension, getExtensionPaths, zipExtension, readZipFile, downloadAndInstallExtension } from './extension-manager';
import { generateFingerprint } from './fingerprint-generator';
import {
  zipProfileDir,
  unzipProfileDir,
  profileDirExists,
  getLocalSyncVersion,
  setLocalSyncVersion,
  getLocalSyncRevision,
  setLocalSyncRevision,
} from './profile-sync';

const Store = require('electron-store');

const isDev = !app.isPackaged;

function assertSafeId(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
}

function getProfilesBaseDir(): string {
  return process.platform === 'win32'
    ? path.join(os.homedir(), 'AppData', 'Local', 'AntidetectBrowser', 'Profiles')
    : path.join(os.homedir(), '.antidetect-browser', 'profiles');
}

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
const sessionImportWaiters = new Map<
  string,
  {
    profileId: string;
    resolve: (result: { status: string; message: string }) => void;
    timeout: NodeJS.Timeout;
  }
>();
let profileSyncBusy = false;
let devRestartPending = false;
let devRestartTimer: NodeJS.Timeout | null = null;
let devRestartInProgress = false;

function hasUnsafeShutdownState(): boolean {
  return PuppeteerLauncher.getActiveProfiles().length > 0 || profileSyncBusy;
}

function requestDevRestart(changedFile?: string): void {
  if (!isDev || devRestartInProgress) return;
  if (devRestartTimer) clearTimeout(devRestartTimer);
  devRestartTimer = setTimeout(() => {
    devRestartTimer = null;
    if (hasUnsafeShutdownState()) {
      devRestartPending = true;
      console.log(
        `[DevReload] Main-process change deferred until profiles are closed: ${changedFile || 'unknown'}`
      );
      return;
    }
    devRestartInProgress = true;
    console.log(`[DevReload] Restarting Electron after change: ${changedFile || 'compiled main file'}`);
    app.relaunch();
    app.exit(0);
  }, 350);
}

function startDevAutoRestart(): void {
  if (!isDev) return;
  const watchDirectories = [
    path.join(app.getAppPath(), 'dist', 'src', 'main'),
    path.join(app.getAppPath(), 'dist', 'src', 'shared'),
  ];
  for (const directory of watchDirectories) {
    if (!fs.existsSync(directory)) continue;
    try {
      fs.watch(directory, { recursive: true }, (_, fileName) => {
        const changedFile = String(fileName || '');
        if (!changedFile.endsWith('.js')) return;
        requestDevRestart(changedFile);
      });
      console.log(`[DevReload] Watching ${directory}`);
    } catch (error) {
      console.warn(`[DevReload] Could not watch ${directory}:`, error);
    }
  }
  setInterval(() => {
    if (devRestartPending && !hasUnsafeShutdownState()) {
      devRestartPending = false;
      requestDevRestart('deferred main-process changes');
    }
  }, 500);
}

function showUnsafeShutdownWarning(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const detail = PuppeteerLauncher.getActiveProfiles().length > 0
    ? 'Fermez toutes les instances, puis attendez le message de synchronisation avant de quitter Spectra.'
    : 'Un profil est encore en cours de synchronisation. Attendez la fin avant de quitter Spectra.';
  dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Synchronisation requise',
    message: 'Spectra ne peut pas se fermer maintenant.',
    detail,
    buttons: ['OK'],
    defaultId: 0,
  }).catch(() => {});
}

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
      webSecurity: true,
    },
    titleBarStyle: 'hidden',
    frame: false,
    backgroundColor: '#000000',
    show: false,
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('close', (event) => {
    if (!hasUnsafeShutdownState()) return;
    event.preventDefault();
    showUnsafeShutdownWarning();
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
    const launchMode = resolveLaunchMode({
      launchMode: profileData.launchMode,
      sessionImportAttemptId: profileData.sessionImport?.attemptId,
      targetTweetUrl: profileData.targetTweetUrl,
      autoStartTwitterBot: profileData.autoStartTwitterBot,
    });
    const result = await PuppeteerLauncher.launch({
      profileId: profileId,
      profileName: profileData.name,
      launchMode,
      platform: profileData.platform,
      userAgent: profileData.userAgent,
      proxy: profileData.proxy,
      fingerprint: profileData.fingerprint,
      lastUrl: profileData.lastUrl,
      connectionType: profileData.connectionType,
      extensionPaths: extensionPaths,
      windowLayout: profileData.windowLayout,
      autoStartTwitterBot: profileData.autoStartTwitterBot === true,
      targetTweetUrl: profileData.targetTweetUrl,
      sessionImport: profileData.sessionImport,
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
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'warzrag',
    repo: 'Spectra',
    private: false,
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
  if (hasUnsafeShutdownState()) {
    showUnsafeShutdownWarning();
    return false;
  }
  autoUpdater.quitAndInstall(false, true);
  return true;
});

ipcMain.handle('app:openExternal', (_, url: string) => {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    throw new Error('Only HTTPS links can be opened externally');
  }
  return shell.openExternal(parsed.toString());
});

ipcMain.handle('app:quit', () => {
  if (hasUnsafeShutdownState()) {
    showUnsafeShutdownWarning();
    return false;
  }
  app.quit();
  return true;
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

app.whenReady().then(async () => {
  createWindow();
  startDevAutoRestart();

  // Check for updates after window loads
  mainWindow?.webContents.once('did-finish-load', () => {
    if (!isDev) setupAutoUpdater();
  });

  // Give PuppeteerLauncher access to mainWindow for download progress events
  PuppeteerLauncher.setMainWindow(mainWindow);

  // Start URL tracking server
  try {
    const localServerConfig = await urlServer.start();
    PuppeteerLauncher.setLocalServerConfig(localServerConfig);
  } catch (error) {
    console.error('[LocalServer] Cookie tracking server could not start:', error);
  }
  
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

// Handle internal cookie save event — save to synced_cookies.json for cloud sync
function atomicWriteJson(filePath: string, value: unknown): void {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tempPath, JSON.stringify(value));
  fs.renameSync(tempPath, filePath);
}

ipcMain.on('internal:save-cookies', (_, profileId, cookies) => {
  try {
    if (typeof profileId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(profileId)) {
      throw new Error('Invalid profile ID');
    }
    if (!Array.isArray(cookies)) {
      throw new Error('Invalid cookie payload');
    }
    const userDataDir = process.platform === 'win32'
      ? path.join(os.homedir(), 'AppData', 'Local', 'AntidetectBrowser', 'Profiles')
      : path.join(os.homedir(), '.antidetect-browser', 'profiles');
    const profileDir = path.join(userDataDir, profileId);
    const syncedPath = path.join(profileDir, 'synced_cookies.json');
    atomicWriteJson(syncedPath, cookies);
    const authenticated = hasAuthenticatedXSession(cookies);
    if (authenticated) {
      atomicWriteJson(path.join(profileDir, 'authenticated_cookies.json'), cookies);
    }
    console.log(
      `[CookieSync] Saved ${cookies.length} cookies for profile ${profileId}` +
      (authenticated ? ' (authenticated X snapshot protected)' : ' (protected X snapshot retained)')
    );
  } catch (e: any) {
    console.error('[CookieSync] Error saving cookies:', e.message);
  }
});

ipcMain.on('internal:launch-status', (_, payload) => {
  PuppeteerLauncher.reportLaunchStatus(payload);
});

ipcMain.on('internal:session-import-status', (_, payload) => {
  if (!payload || typeof payload.attemptId !== 'string') return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sessionImport:status', payload);
  }
  if (!['success', 'manual', 'failed'].includes(payload.status)) return;
  const waiter = sessionImportWaiters.get(payload.attemptId);
  if (!waiter) return;
  clearTimeout(waiter.timeout);
  sessionImportWaiters.delete(payload.attemptId);
  waiter.resolve({ status: payload.status, message: payload.message || '' });
});

ipcMain.on('internal:close-profile', (_, profileId) => {
  if (typeof profileId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(profileId)) {
    console.warn('[Spectra OpenPost] Ignored invalid close-profile request');
    return;
  }
  console.log(`[Spectra OpenPost] Forwarding forced close for ${profileId}`);
  PuppeteerLauncher.forceCloseProfile(profileId).catch(error => {
    console.error(`[Spectra OpenPost] Failed to close profile ${profileId}:`, error);
  });
});

ipcMain.handle('app:getVersion', () => {
  return app.getVersion();
});

ipcMain.handle('diagnostics:environment', () => {
  return PuppeteerLauncher.diagnoseEnvironment();
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

ipcMain.handle('sessionImport:run', async (_, profileData, credentials) => {
  const profileId = String(profileData?.id || '');
  assertSafeId(profileId, 'profile ID');
  const username = String(credentials?.username || '').trim();
  const password = String(credentials?.password || '');
  const totpSecret = String(credentials?.totpSecret || '').replace(/[\s-]/g, '').toUpperCase();
  if (
    !/^@?[A-Za-z0-9_.-]{1,64}$/.test(username) ||
    !password ||
    password.length > 512 ||
    !/^[A-Z2-7]+=*$/.test(totpSecret) ||
    totpSecret.length > 128
  ) {
    throw new Error('Invalid session import account');
  }

  const attemptId = crypto.randomUUID();
  urlServer.stageSessionImport(attemptId, profileId, {
    username: username.replace(/^@/, ''),
    password,
    totpSecret,
  });

  const resultPromise = new Promise<{ status: string; message: string }>((resolve) => {
    const timeout = setTimeout(() => {
      sessionImportWaiters.delete(attemptId);
      urlServer.clearSessionImport(attemptId);
      resolve({ status: 'failed', message: 'Délai de connexion X dépassé' });
    }, 3 * 60 * 1000);
    sessionImportWaiters.set(attemptId, { profileId, resolve, timeout });
  });

  const launchResult = await launchProfileBrowser(profileId, {
    ...profileData,
    lastUrl: 'https://x.com/i/flow/login',
    launchMode: 'session-import',
    autoStartTwitterBot: false,
    targetTweetUrl: undefined,
    sessionImport: { attemptId },
    windowLayout: { index: 0, total: 1 },
  });
  if (!launchResult.success) {
    const waiter = sessionImportWaiters.get(attemptId);
    if (waiter) clearTimeout(waiter.timeout);
    sessionImportWaiters.delete(attemptId);
    urlServer.clearSessionImport(attemptId);
    return { status: 'failed', message: launchResult.error || 'Impossible d’ouvrir le profil' };
  }

  const result = await resultPromise;
  urlServer.clearSessionImport(attemptId);
  if (result.status === 'success') {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await PuppeteerLauncher.closeProfile(profileId).catch(() =>
      PuppeteerLauncher.forceCloseProfile(profileId)
    );
  } else if (result.status === 'failed') {
    await PuppeteerLauncher.forceCloseProfile(profileId).catch(() => {});
  }
  return result;
});

ipcMain.handle('sessionImport:stop', async (_, profileId?: string) => {
  if (profileId) {
    assertSafeId(profileId, 'profile ID');
    for (const [attemptId, waiter] of sessionImportWaiters) {
      if (waiter.profileId !== profileId) continue;
      clearTimeout(waiter.timeout);
      sessionImportWaiters.delete(attemptId);
      urlServer.clearSessionImport(attemptId);
      waiter.resolve({ status: 'failed', message: 'Import arrêté' });
    }
    await PuppeteerLauncher.forceCloseProfile(profileId).catch(() => {});
  }
  return true;
});

ipcMain.handle('profile:forceClose', async (_, profileId) => {
  await PuppeteerLauncher.forceCloseProfile(profileId);
  return true;
});

ipcMain.handle('profiles:getRunning', async (_, profileIds: string[]) => {
  return PuppeteerLauncher.getRunningProfiles(Array.isArray(profileIds) ? profileIds : []);
});

ipcMain.handle('profileSync:setBusy', (_, busy: boolean) => {
  profileSyncBusy = busy === true;
  return true;
});

ipcMain.handle(
  'profileSync:downloadFromCloud',
  async (_, profileId: string, rawUrl: string, idToken: string) => {
    if (typeof profileId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(profileId)) {
      throw new Error('Invalid profile ID');
    }
    if (typeof idToken !== 'string' || idToken.length < 100 || idToken.length > 8192) {
      throw new Error('Invalid Firebase authentication token');
    }

    const url = new URL(rawUrl);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'firebasestorage.googleapis.com' ||
      !url.pathname.startsWith('/v0/b/spectra-59160.firebasestorage.app/o/')
    ) {
      throw new Error('Invalid Firebase Storage URL');
    }

    const encodedObjectPath = url.pathname.split('/o/')[1] || '';
    const objectPath = decodeURIComponent(encodedObjectPath);
    if (
      !objectPath.startsWith(`profiles/${profileId}/`) ||
      !objectPath.toLowerCase().endsWith('.zip')
    ) {
      throw new Error('Cloud profile URL does not match the requested profile');
    }

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${idToken}` },
      redirect: 'error',
    });
    if (!response.ok || !response.body) {
      throw new Error(`Firebase Storage download failed (${response.status})`);
    }

    const contentLength = Number(response.headers.get('content-length') || 0);
    const maxBytes = 2 * 1024 * 1024 * 1024;
    if (contentLength > maxBytes) {
      throw new Error('Cloud profile archive is too large');
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let downloadedBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      downloadedBytes += value.byteLength;
      if (downloadedBytes > maxBytes) {
        await reader.cancel();
        throw new Error('Cloud profile archive exceeded the size limit');
      }
      chunks.push(value);
      if (contentLength > 0 && mainWindow && !mainWindow.isDestroyed()) {
        const percent = 10 + Math.round((downloadedBytes / contentLength) * 50);
        mainWindow.webContents.send(
          'profileSync:downloadProgress',
          profileId,
          Math.min(60, percent)
        );
      }
    }

    const archive = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('profileSync:downloadProgress', profileId, 60);
    }
    return new Uint8Array(archive);
  }
);

// Legacy local handlers - kept for migration support
ipcMain.handle('profiles:getAll', () => {
  return store.get('profiles');
});

ipcMain.handle('folders:getLegacy', () => {
  return store.get('folders');
});

// Clean up local Chrome profile directory (Firestore handles metadata)
ipcMain.handle('profile:cleanupLocal', (_, profileId: string) => {
  assertSafeId(profileId, 'profile ID');
  const profileDir = path.join(getProfilesBaseDir(), profileId);
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

ipcMain.handle('profile:hasAuthenticatedXSnapshot', (_, profileId: string) => {
  return PuppeteerLauncher.hasAuthenticatedXSnapshot(profileId);
});

ipcMain.handle('profile:getLocalSyncRevision', (_, profileId: string) => {
  return getLocalSyncRevision(profileId);
});

ipcMain.handle('profile:setLocalSyncRevision', (_, profileId: string, revision: string) => {
  setLocalSyncRevision(profileId, revision);
  return true;
});

ipcMain.handle('system:hostname', () => {
  return os.hostname();
});

ipcMain.handle('system:installationId', () => {
  let installationId = store.get('installationId') as string | undefined;
  if (!installationId) {
    installationId = require('crypto').randomUUID();
    store.set('installationId', installationId);
  }
  return installationId;
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
    assertSafeId(profileId, 'profile ID');
    const { parseJsonCookies, parseNetscapeCookies } = require('./cookie-utils');
    const cookies = format === 'json' ? parseJsonCookies(cookieData) : parseNetscapeCookies(cookieData);

    const profileDir = path.join(getProfilesBaseDir(), profileId);
    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
    }

    const cookieStagingPath = path.join(profileDir, 'synced_cookies.json');
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
    assertSafeId(profileId, 'profile ID');
    // Extract cookies from running browser via CDP
    if (PuppeteerLauncher.isProfileActive(profileId)) {
      const cookies = await PuppeteerLauncher.getCookies(profileId);
      return { success: true, cookies };
    }
    const syncedPath = path.join(getProfilesBaseDir(), profileId, 'synced_cookies.json');
    if (fs.existsSync(syncedPath)) {
      const cookies = JSON.parse(fs.readFileSync(syncedPath, 'utf8'));
      return { success: true, cookies: Array.isArray(cookies) ? cookies : [] };
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

ipcMain.handle('extensions:downloadAndInstall', async (
  _,
  extensionId: string,
  url: string,
  updatedAt?: string,
  expectedVersion?: string
) => {
  await downloadAndInstallExtension(extensionId, url, updatedAt, expectedVersion);
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
