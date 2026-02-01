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

      if (options.lastUrl) {
        prefs.session = { restore_on_startup: 1, startup_urls: [options.lastUrl] };
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

      // Build Chrome args
      const args = [
        `--user-data-dir=${profilePath}`,
        `--disk-cache-dir=${cacheDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--disable-popup-blocking',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-breakpad',
        '--disable-client-side-phishing-detection',
        '--disable-crash-reporter',
        '--disable-default-apps',
        '--disable-hang-monitor',
        '--disable-ipc-flooding-protection',
        '--disable-renderer-backgrounding',
        '--disable-sync',
        '--disable-web-security',
        '--disable-site-isolation-trials',
        '--disable-features=IsolateOrigins,site-per-process,Translate,AcceptCHFrame,MediaRouter,OptimizationHints,BlockInsecurePrivateNetworkRequests',
        '--metrics-recording-only',
        '--force-color-profile=srgb',
        '--password-store=basic',
        '--window-size=1200,800',
        '--lang=fr-FR',
      ];

      // Proxy
      if (proxy && proxy.host) {
        args.push(`--proxy-server=${proxy.type || 'http'}://${proxy.host}:${proxy.port}`);
      }

      // Load extensions via --load-extension flag (like AdsPower/GoLogin)
      if (options.extensionPaths && options.extensionPaths.length > 0) {
        const validPaths = options.extensionPaths.filter(p => {
          const manifestPath = path.join(p, 'manifest.json');
          const exists = fs.existsSync(manifestPath);
          console.log(`[Extensions] ${p} — manifest exists: ${exists}`);
          return exists;
        });
        if (validPaths.length > 0) {
          args.push(`--load-extension=${validPaths.join(',')}`);
          args.push(`--disable-extensions-except=${validPaths.join(',')}`);
          console.log(`[Extensions] Loading ${validPaths.length} extension(s) via --load-extension`);
        }
      }

      // Set user agent and start URL as Chrome args (avoids Puppeteer viewport emulation)
      const userAgent = options.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
      args.push(`--user-agent=${userAgent}`);

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

      // Pass URL as Chrome arg — Chrome opens it natively, no Puppeteer viewport emulation
      args.push(startUrl);
      console.log(`Start URL: ${startUrl}`);

      // Get portable Chrome (downloads on first use)
      const chromePath = await this.getPortableChrome();
      console.log(`Launching Chrome: ${chromePath}`);

      // Clean environment: remove Electron-specific env vars that crash Chrome
      const cleanEnv: Record<string, string | undefined> = {};
      for (const [key, val] of Object.entries(process.env)) {
        if (!key.startsWith('ELECTRON') && key !== 'NODE_OPTIONS') {
          cleanEnv[key] = val;
        }
      }

      const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        args: args,
        ignoreDefaultArgs: ['--enable-automation', '--disable-extensions'],
        executablePath: chromePath,
        pipe: false,
        env: cleanEnv,
        protocolTimeout: 30000,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      });
      console.log('[Chrome] Browser launched successfully!');

      // Get the page that Chrome opened (with the start URL)
      const pages = await browser.pages();
      const page = pages.length > 1 ? pages[1] : pages[0];

      // Load pending cookies via CDP (no page-level API to avoid viewport emulation)
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

      // Store browser instance
      this.activeProfiles.set(options.profileId, { browser, page });

      // Listen for browser close
      browser.on('disconnected', () => {
        this.activeProfiles.delete(options.profileId);
        console.log(`Browser closed for profile: ${options.profileId}`);
      });

      // Save URL on navigation
      const saveUrl = async (url: string) => {
        if (url && !url.includes('about:blank') && !url.includes('chrome://')) {
          const curPrefsPath = path.join(profilePath, 'Default', 'Preferences');
          if (fs.existsSync(curPrefsPath)) {
            try {
              const curPrefs = JSON.parse(fs.readFileSync(curPrefsPath, 'utf8'));
              curPrefs.session = curPrefs.session || {};
              curPrefs.session.restore_on_startup = 1;
              curPrefs.session.startup_urls = [url];
              fs.writeFileSync(curPrefsPath, JSON.stringify(curPrefs));
            } catch (e) {
              console.error('Error saving Chrome prefs:', e);
            }
          }

          const urlPath = path.join(profilePath, 'last_url.txt');
          fs.writeFileSync(urlPath, url);

          const stateDir = path.join(os.homedir(), '.antidetect-browser', 'state');
          if (!fs.existsSync(stateDir)) {
            fs.mkdirSync(stateDir, { recursive: true });
          }
          const statePath = path.join(stateDir, `${options.profileId}.json`);
          fs.writeFileSync(statePath, JSON.stringify({ lastUrl: url, lastUpdated: new Date().toISOString() }, null, 2));
          console.log(`Saved URL for profile ${options.profileId}: ${url}`);
        }
      };

      page.on('framenavigated', async (frame) => {
        if (frame === page.mainFrame()) {
          await saveUrl(page.url());
        }
      });

      page.on('load', async () => {
        await saveUrl(page.url());
      });

      console.log(`Chrome launched successfully for profile: ${options.profileId}`);
      return { success: true };

    } catch (error: any) {
      console.error('Error launching Chrome:', error);
      return { success: false, error: error.message };
    }
  }

  private static browserPath: string | null = null;

  /** Download Chrome for Testing on first use, then reuse */
  private static async getPortableChrome(): Promise<string> {
    if (this.browserPath && fs.existsSync(this.browserPath)) {
      return this.browserPath;
    }

    const cacheDir = path.join(os.homedir(), '.antidetect-browser', 'browser');
    const platform = detectBrowserPlatform();

    if (!platform) {
      throw new Error('Cannot detect browser platform');
    }

    // Check if already downloaded
    const markerPath = path.join(cacheDir, '.installed');
    if (fs.existsSync(markerPath)) {
      const savedPath = fs.readFileSync(markerPath, 'utf8').trim();
      if (fs.existsSync(savedPath)) {
        console.log(`[Browser] Using cached Chrome: ${savedPath}`);
        this.browserPath = savedPath;
        return savedPath;
      }
    }

    // Download Chrome for Testing
    console.log('[Browser] Downloading Chrome for Testing (first time only)...');
    this.sendProgress(0, 'Téléchargement du navigateur...');
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    // Use the exact Chrome version that this Puppeteer version supports
    const buildId = COMPATIBLE_CHROME_VERSION;
    console.log(`[Browser] Using Puppeteer-compatible Chrome version: ${buildId}`);
    this.sendProgress(5, `Chrome ${buildId} — téléchargement...`);

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
          this.sendProgress(percent, `Téléchargement du navigateur... ${dlMB} / ${totalMB} Mo`);
          if (percent % 10 === 0) {
            console.log(`[Browser] Download: ${percent}% (${dlMB}/${totalMB} MB)`);
          }
        }
      },
    });

    this.sendProgress(100, 'Navigateur prêt !');
    console.log(`[Browser] Chrome downloaded: ${result.executablePath}`);

    // Save the path for next time
    fs.writeFileSync(markerPath, result.executablePath);
    this.browserPath = result.executablePath;
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
}
