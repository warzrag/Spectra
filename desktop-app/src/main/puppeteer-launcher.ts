import puppeteer from 'puppeteer';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { install, Browser, detectBrowserPlatform } from '@puppeteer/browsers';

// Get the Chrome version this Puppeteer version supports
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

  /**
   * Clean Chrome-internal state from a profile directory to fix version incompatibility.
   * Keeps our custom files (cookies, tabs, last_url, proxy auth extension).
   */
  private static cleanProfileState(profilePath: string) {
    const keepFiles = new Set([
      'pending_cookies.json', 'synced_cookies.json', 'open_tabs.json',
      'last_url.txt', '__proxy_auth_ext',
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

      // Get Chrome for Testing
      const chromePath = await this.downloadChromeForTesting();

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
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-breakpad',
        '--disable-client-side-phishing-detection',
        '--disable-hang-monitor',
        '--disable-ipc-flooding-protection',
        '--disable-renderer-backgrounding',
        '--disable-features=Translate,AcceptCHFrame,MediaRouter,OptimizationHints',
        `--lang=${options.fingerprint?.language || options.fingerprint?.languages?.[0] || 'en-US'}`,
      ];

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

      // Load stealth extension (replaces CDP injection — undetectable by Twitter)
      const stealthExtPath = path.join(__dirname, '..', '..', '..', 'assets', 'stealth-extension');
      // Also check packaged app path
      const stealthExtPathAlt = path.join(process.resourcesPath || '', 'assets', 'stealth-extension');
      const stealthExt = fs.existsSync(path.join(stealthExtPath, 'manifest.json')) ? stealthExtPath
        : fs.existsSync(path.join(stealthExtPathAlt, 'manifest.json')) ? stealthExtPathAlt : null;

      // Load extensions via --load-extension flag
      const extPaths: string[] = [];
      if (stealthExt) {
        extPaths.push(stealthExt);
        console.log(`[Stealth] Loading stealth extension from: ${stealthExt}`);
      } else {
        console.warn('[Stealth] Stealth extension not found!');
      }
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

      // Determine start URL — only allow http/https
      const isValidUrl = (url: string) => url && (url.startsWith('https://') || url.startsWith('http://'));
      let startUrl = isValidUrl(options.lastUrl || '') ? options.lastUrl! : 'https://www.google.com';
      const lastUrlPath = path.join(profilePath, 'last_url.txt');
      if (fs.existsSync(lastUrlPath)) {
        try {
          const savedUrl = fs.readFileSync(lastUrlPath, 'utf8').trim();
          if (isValidUrl(savedUrl)) {
            startUrl = savedUrl;
            console.log(`Restored saved URL: ${savedUrl}`);
          }
        } catch (e) {
          console.error('Error reading saved URL:', e);
        }
      }

      // Don't pass startUrl as Chrome arg — we navigate AFTER proxy auth is configured
      console.log(`Start URL (will navigate after auth setup): ${startUrl}`);
      console.log(`Launching Chrome: ${chromePath}`);

      // Clean environment: remove Electron-specific env vars that crash Chrome
      const cleanEnv: Record<string, string | undefined> = {};
      for (const [key, val] of Object.entries(process.env)) {
        if (!key.startsWith('ELECTRON') && key !== 'NODE_OPTIONS') {
          cleanEnv[key] = val;
        }
      }

      const ignoreArgs = ['--enable-automation', '--disable-extensions'];

      const launchOptions = {
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
      };

      let browser;
      try {
        browser = await puppeteer.launch(launchOptions);
      } catch (launchErr: any) {
        // If profile is incompatible (e.g. created by BotBrowser Chrome 145), clean and retry
        if (launchErr.message?.includes('Target closed') || launchErr.message?.includes('Protocol error')) {
          console.warn('[Chrome] Launch failed — cleaning incompatible profile state and retrying...');
          this.cleanProfileState(profilePath);
          // Recreate Default directory and Preferences
          const retryDefaultDir = path.join(profilePath, 'Default');
          if (!fs.existsSync(retryDefaultDir)) fs.mkdirSync(retryDefaultDir, { recursive: true });
          fs.writeFileSync(path.join(retryDefaultDir, 'Preferences'), '{}');
          if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
          browser = await puppeteer.launch(launchOptions);
        } else {
          throw launchErr;
        }
      }
      console.log('[Chrome] Browser launched!');

      let page: any;
      let pages = await browser.pages();
      if (pages.length === 0) {
        pages = [await browser.newPage()];
      }
      page = pages[pages.length - 1];

      // Handle proxy authentication BEFORE navigation (prevents auth popup)
      if (proxy && proxy.username && proxy.password) {
        const allPages = await browser.pages();
        for (const p of allPages) {
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

      // Navigate to saved tabs or start URL
      const tabsFilePath = path.join(profilePath, 'open_tabs.json');
      let savedTabs: string[] = [];
      if (fs.existsSync(tabsFilePath)) {
        try {
          savedTabs = JSON.parse(fs.readFileSync(tabsFilePath, 'utf8'));
          savedTabs = savedTabs.filter(url => url.startsWith('http://') || url.startsWith('https://'));
        } catch {}
      }

      if (savedTabs.length > 0) {
        try {
          await page.goto(savedTabs[0], { waitUntil: 'domcontentloaded', timeout: 30000 });
          console.log(`[Navigation] Restored tab 1/${savedTabs.length}: ${savedTabs[0]}`);
        } catch (e: any) {
          console.error(`[Navigation] Failed to restore first tab:`, e.message);
        }
        for (const [idx, url] of savedTabs.slice(1).entries()) {
          try {
            const newPage = await browser.newPage();
            if (proxy && proxy.username && proxy.password) {
              await newPage.authenticate({ username: proxy.username, password: proxy.password });
            }
            newPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            console.log(`[Navigation] Restored tab ${idx + 2}/${savedTabs.length}: ${url}`);
          } catch {}
        }
      } else {
        try {
          await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          console.log(`[Navigation] Navigated to: ${startUrl}`);
        } catch (e: any) {
          console.error(`[Navigation] Failed to navigate:`, e.message);
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
          if (mainUrl && (mainUrl.startsWith('https://') || mainUrl.startsWith('http://'))) {
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

      console.log(`Chrome launched successfully for profile: ${options.profileId}`);
      return { success: true };

    } catch (error: any) {
      console.error('Error launching browser:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Download Chrome for Testing
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

    console.log('[Browser] Downloading Chrome for Testing...');
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
