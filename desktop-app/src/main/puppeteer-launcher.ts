import puppeteer from 'puppeteer';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as https from 'https';
import { execFile } from 'child_process';
import { install, Browser, detectBrowserPlatform } from '@puppeteer/browsers';

// BotBrowser release info
const BOTBROWSER_VERSION = '145.0.7632.46';
const BOTBROWSER_DATE = '20260210';
const BOTBROWSER_BASE_URL = `https://github.com/botswin/BotBrowser/releases/download/${BOTBROWSER_VERSION}`;

function getBotBrowserDownloadInfo(): { url: string; filename: string; profileUrl: string; profileName: string } {
  const platform = os.platform();
  const arch = os.arch();

  if (platform === 'win32') {
    return {
      url: `${BOTBROWSER_BASE_URL}/botbrowser_${BOTBROWSER_DATE}_${BOTBROWSER_VERSION}_win_x86_64.7z`,
      filename: `botbrowser_${BOTBROWSER_DATE}_${BOTBROWSER_VERSION}_win_x86_64.7z`,
      profileUrl: 'https://raw.githubusercontent.com/botswin/BotBrowser/main/profiles/stable/chrome145_win10_x64.enc',
      profileName: 'chrome145_win10_x64.enc',
    };
  } else if (platform === 'darwin') {
    const isArm = arch === 'arm64';
    const archStr = isArm ? 'arm64' : 'x86_64';
    return {
      url: `${BOTBROWSER_BASE_URL}/botbrowser_${BOTBROWSER_DATE}_${BOTBROWSER_VERSION}_mac_${archStr}.dmg`,
      filename: `botbrowser_${BOTBROWSER_DATE}_${BOTBROWSER_VERSION}_mac_${archStr}.dmg`,
      profileUrl: `https://raw.githubusercontent.com/botswin/BotBrowser/main/profiles/stable/chrome145_mac_${archStr}.enc`,
      profileName: `chrome145_mac_${archStr}.enc`,
    };
  } else {
    const archStr = arch === 'arm64' ? 'arm64' : 'x86_64';
    return {
      url: `${BOTBROWSER_BASE_URL}/botbrowser_${BOTBROWSER_DATE}_${BOTBROWSER_VERSION}_${archStr}.deb`,
      filename: `botbrowser_${BOTBROWSER_DATE}_${BOTBROWSER_VERSION}_${archStr}.deb`,
      profileUrl: `https://raw.githubusercontent.com/AntBrowserTeam/BotBrowser/main/profiles/stable/chrome145_win10_x64.enc`,
      profileName: 'chrome145_win10_x64.enc',
    };
  }
}

// Get the Chrome version this Puppeteer version supports (fallback only)
const COMPATIBLE_CHROME_VERSION = (() => {
  try {
    const { PUPPETEER_REVISIONS } = require('puppeteer');
    return PUPPETEER_REVISIONS?.chrome || '140.0.7339.82';
  } catch {
    return '140.0.7339.82';
  }
})();

export interface PuppeteerLaunchOptions {
  profileId: string;
  profileName: string;
  userAgent?: string;
  proxy?: any;
  fingerprint?: any;
  lastUrl?: string;
  connectionType?: string;
  extensionPaths?: string[];
}

export class PuppeteerLauncher {
  private static activeProfiles = new Map<string, any>();
  private static mainWindow: any = null;

  static setMainWindow(win: any) {
    this.mainWindow = win;
  }

  private static sendProgress(percent: number, status: string) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('browser:downloadProgress', { percent, status });
    }
  }

  static isProfileActive(profileId: string): boolean {
    return this.activeProfiles.has(profileId);
  }

  static async launch(options: PuppeteerLaunchOptions) {
    try {
      // Check if already running
      if (this.isProfileActive(options.profileId)) {
        const instance = this.activeProfiles.get(options.profileId);
        if (instance && instance.browser) {
          const pages = await instance.browser.pages();
          if (pages.length > 0) {
            await pages[0].bringToFront();
          }
          return { success: false, error: 'Profile already running', alreadyRunning: true };
        }
      }

      // Get user data directory path
      const userDataDir = process.platform === 'win32'
        ? path.join(os.homedir(), 'AppData', 'Local', 'AntidetectBrowser', 'Profiles')
        : path.join(os.homedir(), '.antidetect-browser', 'profiles');

      const profilePath = path.join(userDataDir, options.profileId);

      if (!fs.existsSync(profilePath)) {
        fs.mkdirSync(profilePath, { recursive: true });
      }

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

      fs.writeFileSync(prefsPath, JSON.stringify(prefs));

      // Get proxy configuration
      let proxy: any = null;
      if (options.proxy?.host) {
        proxy = options.proxy;
      }

      const cacheDir = path.join(profilePath, 'Cache');
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }

      // Get BotBrowser paths
      const { chromePath, profileEncPath, isBotBrowser } = await this.getPortableChrome();

      // Build Chrome args
      const args = [
        `--user-data-dir=${profilePath}`,
        `--disk-cache-dir=${cacheDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-infobars',
        '--disable-popup-blocking',
        '--disable-default-apps',
        '--disable-sync',
        '--window-size=1280,800',
      ];

      if (isBotBrowser && profileEncPath) {
        // BotBrowser: minimal flags + bot-profile (everything else handled natively)
        args.push(`--bot-profile=${profileEncPath}`);
        args.push('--bot-config-timezone=auto');
        args.push('--bot-config-languages=auto');
        args.push('--bot-config-webrtc=disabled');
        console.log(`[BotBrowser] Using profile: ${profileEncPath}`);
      } else {
        // Fallback Chrome for Testing: need extra flags
        args.push('--disable-blink-features=AutomationControlled');
        args.push('--disable-dev-shm-usage');
        args.push('--disable-background-timer-throttling');
        args.push('--disable-backgrounding-occluded-windows');
        args.push('--disable-breakpad');
        args.push('--disable-client-side-phishing-detection');
        args.push('--disable-hang-monitor');
        args.push('--disable-ipc-flooding-protection');
        args.push('--disable-renderer-backgrounding');
        args.push('--disable-features=Translate,AcceptCHFrame,MediaRouter,OptimizationHints');
        args.push(`--lang=${options.fingerprint?.language || options.fingerprint?.languages?.[0] || 'en-US'}`);
      }

      // Proxy + DNS leak prevention
      if (proxy && proxy.host) {
        args.push(`--proxy-server=${proxy.type || 'http'}://${proxy.host}:${proxy.port}`);
        // Force DNS resolution through proxy — prevent local DNS leaks
        args.push(`--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE ${proxy.host}`);
        args.push('--disable-dns-prefetch');
      }

      // Create proxy auth extension if proxy has credentials
      // This handles auth for ALL requests (pages + extensions) unlike page.authenticate()
      let proxyAuthExtPath: string | null = null;
      if (proxy && proxy.username && proxy.password) {
        proxyAuthExtPath = path.join(profilePath, '__proxy_auth_ext');
        if (!fs.existsSync(proxyAuthExtPath)) {
          fs.mkdirSync(proxyAuthExtPath, { recursive: true });
        }
        fs.writeFileSync(path.join(proxyAuthExtPath, 'manifest.json'), JSON.stringify({
          manifest_version: 3,
          name: 'Proxy Auth',
          version: '1.0',
          permissions: ['webRequest', 'webRequestAuthProvider'],
          host_permissions: ['<all_urls>'],
          background: { service_worker: 'background.js' },
        }));
        fs.writeFileSync(path.join(proxyAuthExtPath, 'background.js'),
          `chrome.webRequest.onAuthRequired.addListener((details) => {
            return { authCredentials: { username: ${JSON.stringify(proxy.username)}, password: ${JSON.stringify(proxy.password)} } };
          }, { urls: ['<all_urls>'] }, ['asyncBlocking']);`
        );
        console.log('[ProxyAuth] Created proxy auth extension');
      }

      // Load extensions via --load-extension flag
      const extPaths: string[] = [];
      if (proxyAuthExtPath) extPaths.push(proxyAuthExtPath);
      if (options.extensionPaths && options.extensionPaths.length > 0) {
        const validPaths = options.extensionPaths.filter(p => {
          const manifestPath = path.join(p, 'manifest.json');
          const exists = fs.existsSync(manifestPath);
          console.log(`[Extensions] ${p} — manifest exists: ${exists}`);
          return exists;
        });
        extPaths.push(...validPaths);
      }
      if (extPaths.length > 0) {
        args.push(`--load-extension=${extPaths.join(',')}`);
        args.push(`--disable-extensions-except=${extPaths.join(',')}`);
        console.log(`[Extensions] Loading ${extPaths.length} extension(s) via --load-extension`);
      }

      // Determine start URL
      let startUrl = options.lastUrl || 'https://www.google.com';
      const lastUrlPath = path.join(profilePath, 'last_url.txt');
      if (fs.existsSync(lastUrlPath)) {
        try {
          const savedUrl = fs.readFileSync(lastUrlPath, 'utf8').trim();
          if (savedUrl && savedUrl.startsWith('http')) {
            startUrl = savedUrl;
            console.log(`Restored saved URL: ${savedUrl}`);
          }
        } catch (e) {
          console.error('Error reading saved URL:', e);
        }
      }

      // Don't pass startUrl as Chrome arg — we navigate AFTER proxy auth is configured
      console.log(`Start URL (will navigate after auth setup): ${startUrl}`);
      console.log(`Launching ${isBotBrowser ? 'BotBrowser' : 'Chrome'}: ${chromePath}`);

      // Clean environment: remove Electron-specific env vars that crash Chrome
      const cleanEnv: Record<string, string | undefined> = {};
      for (const [key, val] of Object.entries(process.env)) {
        if (!key.startsWith('ELECTRON') && key !== 'NODE_OPTIONS') {
          cleanEnv[key] = val;
        }
      }

      // BotBrowser needs extra ignoreDefaultArgs to avoid interfering with fingerprint protection
      const ignoreArgs = ['--enable-automation', '--disable-extensions'];
      if (isBotBrowser) {
        ignoreArgs.push('--disable-crash-reporter', '--disable-crashpad-for-testing', '--disable-gpu-watchdog');
      }

      const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        args: args,
        ignoreDefaultArgs: ignoreArgs,
        executablePath: chromePath,
        pipe: false,
        env: cleanEnv,
        protocolTimeout: 30000,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      });
      console.log(`[${isBotBrowser ? 'BotBrowser' : 'Chrome'}] Browser launched successfully!`);

      // Get the page that Chrome opened
      const pages = await browser.pages();
      const page = pages.length > 1 ? pages[1] : pages[0];

      // Handle proxy authentication BEFORE navigation (prevents auth popup)
      // With BotBrowser, only use the extension (no CDP page.authenticate which is detectable)
      if (proxy && proxy.username && proxy.password && !isBotBrowser) {
        for (const p of pages) {
          await p.authenticate({ username: proxy.username, password: proxy.password });
        }

        browser.on('targetcreated', async (target) => {
          if (target.type() === 'page') {
            try {
              const newPage = await target.page();
              if (newPage) {
                await newPage.authenticate({ username: proxy.username, password: proxy.password });
              }
            } catch {}
          }
        });
        console.log('[ProxyAuth] Proxy authentication configured via CDP');
      } else if (proxy && proxy.username && proxy.password) {
        console.log('[ProxyAuth] Using extension-only auth (BotBrowser mode)');
      }

      // Load pending cookies via CDP
      const pendingCookiesPath = path.join(profilePath, 'pending_cookies.json');
      if (fs.existsSync(pendingCookiesPath)) {
        try {
          const cookieData = JSON.parse(fs.readFileSync(pendingCookiesPath, 'utf8'));
          if (Array.isArray(cookieData) && cookieData.length > 0) {
            const cdpSession = await page.createCDPSession();
            for (const c of cookieData) {
              await cdpSession.send('Network.setCookie', {
                name: c.name,
                value: c.value,
                domain: c.domain,
                path: c.path || '/',
                httpOnly: c.httpOnly || false,
                secure: c.secure || false,
                ...(c.expirationDate ? { expires: c.expirationDate } : {}),
              });
            }
            await cdpSession.detach();
            console.log(`Loaded ${cookieData.length} cookies for profile ${options.profileId}`);
          }
          fs.unlinkSync(pendingCookiesPath);
        } catch (e) {
          console.error('Error loading pending cookies:', e);
        }
      }

      // Import synced cookies from cloud via CDP
      const syncedCookiesPath = path.join(profilePath, 'synced_cookies.json');
      if (fs.existsSync(syncedCookiesPath)) {
        try {
          const syncedCookies = JSON.parse(fs.readFileSync(syncedCookiesPath, 'utf8'));
          if (Array.isArray(syncedCookies) && syncedCookies.length > 0) {
            const cdpSession = await page.createCDPSession();
            let imported = 0;
            for (const c of syncedCookies) {
              try {
                await cdpSession.send('Network.setCookie', {
                  name: c.name,
                  value: c.value,
                  domain: c.domain,
                  path: c.path || '/',
                  httpOnly: c.httpOnly || false,
                  secure: c.secure || false,
                  sameSite: c.sameSite || undefined,
                  ...(c.expires && c.expires > 0 ? { expires: c.expires } : {}),
                });
                imported++;
              } catch {}
            }
            await cdpSession.detach();
            console.log(`[CookieSync] Imported ${imported}/${syncedCookies.length} synced cookies`);
          }
        } catch (e) {
          console.error('[CookieSync] Error importing synced cookies:', e);
        }
      }

      // Restore all saved tabs or navigate to start URL
      const tabsFilePath = path.join(profilePath, 'open_tabs.json');
      let savedTabs: string[] = [];
      if (fs.existsSync(tabsFilePath)) {
        try { savedTabs = JSON.parse(fs.readFileSync(tabsFilePath, 'utf8')); } catch {}
      }

      if (savedTabs.length > 0) {
        // Restore first tab in existing page
        try {
          await page.goto(savedTabs[0], { waitUntil: 'domcontentloaded', timeout: 30000 });
          console.log(`[Navigation] Restored tab 1/${savedTabs.length}: ${savedTabs[0]}`);
        } catch (e) {
          console.error('[Navigation] Failed to restore first tab:', e);
        }
        // Open remaining tabs
        await Promise.all(savedTabs.slice(1).map(async (url, idx) => {
          try {
            const newPage = await browser.newPage();
            if (proxy && proxy.username && proxy.password && !isBotBrowser) {
              await newPage.authenticate({ username: proxy.username, password: proxy.password });
            }
            newPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            console.log(`[Navigation] Restored tab ${idx + 2}/${savedTabs.length}: ${url}`);
          } catch (e) {
            console.error(`[Navigation] Failed to restore tab ${idx + 2}:`, e);
          }
        }));
      } else {
        try {
          await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          console.log(`[Navigation] Navigated to: ${startUrl}`);
        } catch (e) {
          console.error('[Navigation] Failed to navigate to start URL:', e);
        }
      }

      // Store browser instance
      this.activeProfiles.set(options.profileId, { browser, page });

      // Cookie save interval ref
      let cookieSaveInterval: ReturnType<typeof setInterval> | null = null;

      // Listen for browser close
      browser.on('disconnected', () => {
        if (cookieSaveInterval) clearInterval(cookieSaveInterval);
        this.activeProfiles.delete(options.profileId);
        console.log(`Browser closed for profile: ${options.profileId}`);
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('profiles:activeUpdate', Array.from(this.activeProfiles.keys()));
          this.mainWindow.webContents.send('profile:closed', options.profileId);
        }
      });

      // Track all open tabs and save their URLs for multi-tab restoration
      let tabSaveTimeout: ReturnType<typeof setTimeout> | null = null;
      const saveAllTabUrls = async () => {
        try {
          const allPages = await browser.pages();
          const urls: string[] = [];
          for (const p of allPages) {
            try {
              const url = p.url();
              if (url && !url.startsWith('about:') && !url.startsWith('chrome://') && !url.startsWith('devtools://')) {
                urls.push(url);
              }
            } catch {}
          }
          if (urls.length > 0) {
            fs.writeFileSync(tabsFilePath, JSON.stringify(urls));
            console.log(`[Tabs] Saved ${urls.length} tab(s)`);
          }
          const mainUrl = page.url();
          if (mainUrl && !mainUrl.startsWith('about:') && !mainUrl.startsWith('chrome://')) {
            fs.writeFileSync(path.join(profilePath, 'last_url.txt'), mainUrl);
            const stateDir = path.join(os.homedir(), '.antidetect-browser', 'state');
            if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
            fs.writeFileSync(
              path.join(stateDir, `${options.profileId}.json`),
              JSON.stringify({ lastUrl: mainUrl, lastUpdated: new Date().toISOString() }, null, 2)
            );
          }
        } catch {}
      };

      const debouncedSaveTabs = () => {
        if (tabSaveTimeout) clearTimeout(tabSaveTimeout);
        tabSaveTimeout = setTimeout(saveAllTabUrls, 1000);
      };

      // Track main page navigations
      page.on('framenavigated', (frame: any) => {
        if (frame === page.mainFrame()) debouncedSaveTabs();
      });
      page.on('load', debouncedSaveTabs);

      // Track new tabs opened by user
      browser.on('targetcreated', async (target) => {
        if (target.type() === 'page') {
          try {
            const p = await target.page();
            if (p) {
              p.on('framenavigated', (frame: any) => {
                if (frame === p.mainFrame()) debouncedSaveTabs();
              });
              p.on('load', debouncedSaveTabs);
            }
          } catch {}
        }
      });

      // Save when a tab is closed
      browser.on('targetdestroyed', debouncedSaveTabs);

      // --- Periodic cookie export via CDP ---
      const saveCookiesViaCDP = async () => {
        try {
          const allPages = await browser.pages();
          if (allPages.length === 0) return;
          const cdpSession = await allPages[0].createCDPSession();
          const result = await cdpSession.send('Network.getAllCookies');
          await cdpSession.detach();
          if (result.cookies && result.cookies.length > 0) {
            fs.writeFileSync(syncedCookiesPath, JSON.stringify(result.cookies));
            console.log(`[CookieSync] Exported ${result.cookies.length} cookies via CDP`);
          }
        } catch {}
      };
      setTimeout(saveCookiesViaCDP, 5000);
      cookieSaveInterval = setInterval(saveCookiesViaCDP, 30000);

      console.log(`${isBotBrowser ? 'BotBrowser' : 'Chrome'} launched successfully for profile: ${options.profileId}`);
      return { success: true };

    } catch (error: any) {
      console.error('Error launching browser:', error);
      return { success: false, error: error.message };
    }
  }

  private static browserPath: string | null = null;
  private static profileEncPath: string | null = null;
  private static usingBotBrowser: boolean = false;

  /**
   * Download a file from URL to disk with progress reporting.
   */
  private static downloadFile(url: string, destPath: string, label: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const follow = (url: string, redirects: number) => {
        if (redirects > 5) return reject(new Error('Too many redirects'));

        const makeRequest = (requestUrl: string) => {
          https.get(requestUrl, { headers: { 'User-Agent': 'Spectra/1.0' } }, (res) => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              return follow(res.headers.location, redirects + 1);
            }
            if (res.statusCode !== 200) {
              return reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
            }

            const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
            let downloadedBytes = 0;
            let lastPercent = 0;
            const file = fs.createWriteStream(destPath);

            res.on('data', (chunk: Buffer) => {
              downloadedBytes += chunk.length;
              if (totalBytes > 0) {
                const percent = Math.round((downloadedBytes / totalBytes) * 100);
                if (percent !== lastPercent) {
                  lastPercent = percent;
                  const dlMB = (downloadedBytes / 1024 / 1024).toFixed(1);
                  const totalMB = (totalBytes / 1024 / 1024).toFixed(1);
                  this.sendProgress(percent, `${label}... ${dlMB} / ${totalMB} Mo`);
                  if (percent % 10 === 0) {
                    console.log(`[BotBrowser] ${label}: ${percent}% (${dlMB}/${totalMB} MB)`);
                  }
                }
              }
            });

            res.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
            file.on('error', (err) => { fs.unlinkSync(destPath); reject(err); });
          }).on('error', reject);
        };

        makeRequest(url);
      };

      follow(url, 0);
    });
  }

  /**
   * Extract a .7z archive using 7zip-bin (Windows)
   */
  private static extract7z(archivePath: string, destDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let sevenZipBin: string;
      try {
        sevenZipBin = require('7zip-bin').path7za;
      } catch {
        return reject(new Error('7zip-bin not installed'));
      }

      console.log(`[BotBrowser] Extracting ${archivePath} to ${destDir}`);
      this.sendProgress(50, 'Extraction en cours...');

      execFile(sevenZipBin, ['x', archivePath, `-o${destDir}`, '-y'], { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          console.error('[BotBrowser] 7z extraction error:', stderr || err.message);
          return reject(err);
        }
        console.log('[BotBrowser] Extraction complete');
        this.sendProgress(80, 'Extraction terminée');
        resolve();
      });
    });
  }

  /**
   * Extract a .dmg on macOS using hdiutil
   */
  private static extractDmg(dmgPath: string, destDir: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const mountPoint = path.join(os.tmpdir(), 'botbrowser_mount');

      // Mount the DMG
      execFile('hdiutil', ['attach', dmgPath, '-mountpoint', mountPoint, '-nobrowse', '-quiet'], (err) => {
        if (err) return reject(new Error(`Failed to mount DMG: ${err.message}`));

        this.sendProgress(60, 'Copie des fichiers...');

        // Find .app inside mounted volume
        try {
          const entries = fs.readdirSync(mountPoint);
          const appEntry = entries.find(e => e.endsWith('.app'));
          if (!appEntry) {
            execFile('hdiutil', ['detach', mountPoint, '-quiet'], () => {});
            return reject(new Error('No .app found in DMG'));
          }

          const srcApp = path.join(mountPoint, appEntry);
          const destApp = path.join(destDir, appEntry);

          // Copy .app to destination
          execFile('cp', ['-R', srcApp, destApp], (err) => {
            // Unmount regardless
            execFile('hdiutil', ['detach', mountPoint, '-quiet'], () => {});

            if (err) return reject(new Error(`Failed to copy app: ${err.message}`));

            // Remove macOS quarantine attribute (prevents "Chromium is damaged" error)
            execFile('xattr', ['-rd', 'com.apple.quarantine', destApp], () => {
              console.log('[BotBrowser] Removed quarantine attribute from .app bundle');
            });

            // Find the executable inside the .app bundle
            const execPath = path.join(destApp, 'Contents', 'MacOS', 'Chromium');
            if (fs.existsSync(execPath)) {
              fs.chmodSync(execPath, 0o755);
              resolve(execPath);
            } else {
              // Try to find any executable
              const macosDir = path.join(destApp, 'Contents', 'MacOS');
              if (fs.existsSync(macosDir)) {
                const execs = fs.readdirSync(macosDir);
                if (execs.length > 0) {
                  const executablePath = path.join(macosDir, execs[0]);
                  fs.chmodSync(executablePath, 0o755);
                  resolve(executablePath);
                } else {
                  reject(new Error('No executable found in .app bundle'));
                }
              } else {
                reject(new Error('No MacOS directory in .app bundle'));
              }
            }
          });
        } catch (e) {
          execFile('hdiutil', ['detach', mountPoint, '-quiet'], () => {});
          reject(e);
        }
      });
    });
  }

  /**
   * Download BotBrowser and profile, with fallback to Chrome for Testing
   */
  private static async getPortableChrome(): Promise<{ chromePath: string; profileEncPath: string | null; isBotBrowser: boolean }> {
    // Return cached paths
    if (this.browserPath && fs.existsSync(this.browserPath)) {
      return {
        chromePath: this.browserPath,
        profileEncPath: this.profileEncPath,
        isBotBrowser: this.usingBotBrowser,
      };
    }

    const botBrowserDir = path.join(os.homedir(), '.antidetect-browser', 'botbrowser');
    const markerPath = path.join(botBrowserDir, '.installed');

    // Check if BotBrowser is already installed
    if (fs.existsSync(markerPath)) {
      try {
        const saved = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        if (saved.chromePath && fs.existsSync(saved.chromePath)) {
          console.log(`[BotBrowser] Using cached installation: ${saved.chromePath}`);
          this.browserPath = saved.chromePath;
          this.profileEncPath = saved.profileEncPath || null;
          this.usingBotBrowser = true;
          return { chromePath: saved.chromePath, profileEncPath: saved.profileEncPath, isBotBrowser: true };
        }
      } catch {}
    }

    // Try to download and install BotBrowser
    try {
      const info = getBotBrowserDownloadInfo();
      console.log(`[BotBrowser] Downloading ${info.filename}...`);
      this.sendProgress(0, 'Téléchargement de BotBrowser...');

      if (!fs.existsSync(botBrowserDir)) {
        fs.mkdirSync(botBrowserDir, { recursive: true });
      }

      // Download the browser archive
      const archivePath = path.join(botBrowserDir, info.filename);
      if (!fs.existsSync(archivePath)) {
        await this.downloadFile(info.url, archivePath, 'Téléchargement de BotBrowser');
      }

      // Extract based on platform
      let executablePath: string;
      const extractDir = path.join(botBrowserDir, 'browser');

      if (process.platform === 'win32') {
        // Extract .7z on Windows
        if (!fs.existsSync(extractDir)) {
          fs.mkdirSync(extractDir, { recursive: true });
        }
        await this.extract7z(archivePath, extractDir);

        // Find chrome.exe in extracted directory
        executablePath = this.findExecutableInDir(extractDir, 'chrome.exe');
        if (!executablePath) {
          throw new Error('chrome.exe not found in extracted BotBrowser archive');
        }
      } else if (process.platform === 'darwin') {
        // Extract .dmg on macOS
        if (!fs.existsSync(extractDir)) {
          fs.mkdirSync(extractDir, { recursive: true });
        }
        executablePath = await this.extractDmg(archivePath, extractDir);
      } else {
        throw new Error('Linux BotBrowser installation not yet supported');
      }

      // Download profile .enc file
      this.sendProgress(85, 'Téléchargement du profil...');
      const profileEncPath = path.join(botBrowserDir, info.profileName);
      if (!fs.existsSync(profileEncPath)) {
        await this.downloadFile(info.profileUrl, profileEncPath, 'Téléchargement du profil');
      }

      this.sendProgress(95, 'Installation terminée');

      // Save marker
      const markerData = { chromePath: executablePath, profileEncPath, version: BOTBROWSER_VERSION };
      fs.writeFileSync(markerPath, JSON.stringify(markerData));

      // Clean up archive to save disk space
      try { fs.unlinkSync(archivePath); } catch {}

      this.browserPath = executablePath;
      this.profileEncPath = profileEncPath;
      this.usingBotBrowser = true;

      this.sendProgress(100, 'BotBrowser prêt !');
      console.log(`[BotBrowser] Installed: ${executablePath}`);

      return { chromePath: executablePath, profileEncPath, isBotBrowser: true };

    } catch (err: any) {
      console.error(`[BotBrowser] Installation failed, falling back to Chrome for Testing:`, err.message);
      this.sendProgress(0, 'Fallback: Chrome for Testing...');

      // Fallback to Chrome for Testing
      const chromePath = await this.downloadChromeForTesting();
      this.browserPath = chromePath;
      this.profileEncPath = null;
      this.usingBotBrowser = false;

      return { chromePath, profileEncPath: null, isBotBrowser: false };
    }
  }

  /**
   * Recursively find an executable in a directory
   */
  private static findExecutableInDir(dir: string, name: string): string {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    // Check current directory first
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) {
        return path.join(dir, entry.name);
      }
    }

    // Recurse into subdirectories
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const found = this.findExecutableInDir(path.join(dir, entry.name), name);
        if (found) return found;
      }
    }

    return '';
  }

  /**
   * Fallback: Download Chrome for Testing (original method)
   */
  private static async downloadChromeForTesting(): Promise<string> {
    const cacheDir = path.join(os.homedir(), '.antidetect-browser', 'browser');
    const platform = detectBrowserPlatform();

    if (!platform) {
      throw new Error('Cannot detect browser platform');
    }

    const markerPath = path.join(cacheDir, '.installed');
    if (fs.existsSync(markerPath)) {
      const savedPath = fs.readFileSync(markerPath, 'utf8').trim();
      if (fs.existsSync(savedPath)) {
        console.log(`[Browser] Using cached Chrome: ${savedPath}`);
        return savedPath;
      }
    }

    console.log('[Browser] Downloading Chrome for Testing (fallback)...');
    this.sendProgress(0, 'Téléchargement Chrome for Testing...');
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    const buildId = COMPATIBLE_CHROME_VERSION;
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

  static async closeProfile(profileId: string) {
    const instance = this.activeProfiles.get(profileId);
    if (instance) {
      try { await instance.browser?.close(); } catch {}
      this.activeProfiles.delete(profileId);
    }
  }

  static getActiveProfiles(): string[] {
    return Array.from(this.activeProfiles.keys());
  }

  static async getCookies(profileId: string): Promise<any[]> {
    const instance = this.activeProfiles.get(profileId);
    if (!instance || !instance.page) return [];

    try {
      const cdp = await instance.page.createCDPSession();
      const result = await cdp.send('Network.getAllCookies');
      await cdp.detach();
      return result.cookies || [];
    } catch (e) {
      console.error('Failed to extract cookies:', e);
      return [];
    }
  }
}
