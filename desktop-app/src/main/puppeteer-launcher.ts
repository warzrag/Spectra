import puppeteer from 'puppeteer';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { install, Browser, detectBrowserPlatform } from '@puppeteer/browsers';
import { getCountryFromIP, overrideFingerprintGeo } from './fingerprint-generator';

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

      // Build Chrome args — minimal flags to look like a real browser
      const args = [
        `--user-data-dir=${profilePath}`,
        `--disk-cache-dir=${cacheDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--disable-popup-blocking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-client-side-phishing-detection',
        '--disable-default-apps',
        '--disable-renderer-backgrounding',
        '--disable-sync',
        '--disable-features=Translate,AcceptCHFrame,MediaRouter,OptimizationHints',
        '--password-store=basic',
        `--window-size=${options.fingerprint?.screenWidth || 1200},${options.fingerprint?.screenHeight || 800}`,
        `--lang=${options.fingerprint?.language || options.fingerprint?.languages?.[0] || 'en-US'}`,
      ];

      // Proxy + DNS leak prevention
      if (proxy && proxy.host) {
        args.push(`--proxy-server=${proxy.type || 'http'}://${proxy.host}:${proxy.port}`);
        // Force DNS resolution through proxy — prevent local DNS leaks
        args.push(`--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE ${proxy.host}`);
        args.push('--disable-dns-prefetch');
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

      // User agent will be set after fingerprint OS correction (see below)

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
      // This prevents the proxy auth popup race condition
      console.log(`Start URL (will navigate after auth setup): ${startUrl}`);

      // On macOS, prefer real Google Chrome (Chrome for Testing is detectable)
      // On Windows, keep using Chrome for Testing (already works fine)
      const realChrome = process.platform === 'darwin' ? this.findRealChrome() : null;
      const chromePath = realChrome || await this.getPortableChrome();
      console.log(`Launching Chrome: ${chromePath} (${realChrome ? 'system' : 'portable'})`);

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

      // Handle proxy authentication BEFORE navigation (prevents auth popup)
      if (proxy && proxy.username && proxy.password) {
        for (const p of pages) {
          await p.authenticate({ username: proxy.username, password: proxy.password });
        }

        // Also handle auth for new tabs
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
        console.log('[ProxyAuth] Proxy authentication configured');
      }

      // Force fingerprint OS to match the real OS — prevents cross-OS detection
      let fp = options.fingerprint || {};
      const realOS = process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : 'windows';
      if (fp.os && fp.os !== realOS) {
        console.log(`[Fingerprint] OS mismatch: profile says ${fp.os}, real OS is ${realOS}. Regenerating fingerprint.`);
        const { generateFingerprint } = require('./fingerprint-generator');
        fp = generateFingerprint(realOS);
      }

      // Auto-detect proxy country and override fingerprint timezone/language
      if (proxy && proxy.host) {
        try {
          const country = await getCountryFromIP(proxy.host, proxy.port, proxy.type);
          if (country) {
            console.log(`[GeoIP] Proxy country detected: ${country}`);
            fp = overrideFingerprintGeo(fp, country);
          }
        } catch (e) {
          console.warn('[GeoIP] Failed to detect proxy country:', e);
        }
      }

      // Set user agent AFTER fingerprint OS is corrected
      const defaultUA = process.platform === 'darwin'
        ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.82 Safari/537.36'
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.82 Safari/537.36';
      const userAgent = options.userAgent || fp.userAgent || defaultUA;
      args.push(`--user-agent=${userAgent}`);

      // Extract Chrome version from user agent for Sec-CH-UA consistency
      const chromeVersionMatch = userAgent.match(/Chrome\/(\d+)\.\d+\.\d+\.\d+/);
      const majorVersion = chromeVersionMatch ? chromeVersionMatch[1] : '140';
      const fullVersion = chromeVersionMatch ? chromeVersionMatch[0].replace('Chrome/', '') : '140.0.0.0';

      // Build Sec-CH-UA metadata to match the spoofed user agent
      const uaMetadata = {
        brands: [
          { brand: 'Chromium', version: majorVersion },
          { brand: 'Google Chrome', version: majorVersion },
          { brand: 'Not)A;Brand', version: '99' },
        ],
        fullVersionList: [
          { brand: 'Chromium', version: fullVersion },
          { brand: 'Google Chrome', version: fullVersion },
          { brand: 'Not)A;Brand', version: '99.0.0.0' },
        ],
        fullVersion: fullVersion,
        platform: fp.platform === 'MacIntel' ? 'macOS' : fp.platform === 'Linux x86_64' ? 'Linux' : 'Windows',
        platformVersion: fp.platform === 'MacIntel'
          ? ['14.5.0', '14.6.1', '15.0.0', '15.1.0', '15.2.0'][Math.floor(Math.random() * 5)]
          : fp.platform === 'Linux x86_64' ? '6.5.0' : '15.0.0',
        architecture: 'x86',
        bitness: '64',
        model: '',
        mobile: false,
        wow64: false,
      };

      // Inject dynamic stealth/fingerprint script via CDP
      const stealthScript = buildStealthScript(fp);

      // Helper: apply all CDP overrides to a page
      const applyStealthToPage = async (p: any) => {
        try {
          const cdp = await p.createCDPSession();
          // Override User-Agent + Sec-CH-UA headers at network level
          await cdp.send('Network.setUserAgentOverride', {
            userAgent: userAgent,
            acceptLanguage: fp.language || 'en-US',
            platform: fp.platform || 'Win32',
            userAgentMetadata: uaMetadata,
          });
          await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: stealthScript });
          if (fp.timezone) {
            await cdp.send('Emulation.setTimezoneOverride', { timezoneId: fp.timezone });
          }
          await cdp.detach();
        } catch (e) {
          console.error('Failed to inject stealth into page:', e);
        }
      };

      // Inject into all existing pages
      for (const p of pages) {
        await applyStealthToPage(p);
      }

      // Inject into new tabs/pages
      browser.on('targetcreated', async (target) => {
        if (target.type() === 'page') {
          try {
            const newPage = await target.page();
            if (newPage) {
              await applyStealthToPage(newPage);
            }
          } catch (e) { /* Page may have closed */ }
        }
      });

      console.log(`[Stealth] Sec-CH-UA configured: Chrome/${majorVersion}, platform: ${uaMetadata.platform}`);

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

      // Import synced cookies from cloud via CDP (bypasses Chrome DPAPI encryption)
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
        // Open remaining tabs in parallel
        await Promise.all(savedTabs.slice(1).map(async (url, idx) => {
          try {
            const newPage = await browser.newPage();
            await applyStealthToPage(newPage);
            if (proxy && proxy.username && proxy.password) {
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

      // Cookie save interval ref (declared here so disconnect handler can clear it)
      let cookieSaveInterval: ReturnType<typeof setInterval> | null = null;

      // Listen for browser close
      browser.on('disconnected', () => {
        if (cookieSaveInterval) clearInterval(cookieSaveInterval);
        this.activeProfiles.delete(options.profileId);
        console.log(`Browser closed for profile: ${options.profileId}`);
        // Notify renderer for cloud sync upload
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
          // Also save main page URL for Firestore sync
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

      // --- Periodic cookie export via CDP (bypasses DPAPI encryption for cross-PC sync) ---
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
      // Save cookies 5s after launch (pages need time to load and set cookies)
      setTimeout(saveCookiesViaCDP, 5000);
      // Save cookies every 30s during the session
      cookieSaveInterval = setInterval(saveCookiesViaCDP, 30000);

      console.log(`Chrome launched successfully for profile: ${options.profileId}`);
      return { success: true };

    } catch (error: any) {
      console.error('Error launching Chrome:', error);
      return { success: false, error: error.message };
    }
  }

  private static browserPath: string | null = null;

  /** Find real Google Chrome installed on the system */
  private static findRealChrome(): string | null {
    const platform = os.platform();
    const paths: string[] = [];

    if (platform === 'darwin') {
      paths.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
      paths.push(path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
    } else if (platform === 'win32') {
      paths.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
      paths.push('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe');
      paths.push(path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'));
    } else {
      paths.push('/usr/bin/google-chrome');
      paths.push('/usr/bin/google-chrome-stable');
    }

    for (const p of paths) {
      if (fs.existsSync(p)) {
        console.log(`[Browser] Found system Chrome: ${p}`);
        return p;
      }
    }
    return null;
  }

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

function buildStealthScript(fp: any): string {
  const screenWidth = fp.screenWidth || 1920;
  const screenHeight = fp.screenHeight || 1080;
  const availWidth = fp.availWidth || screenWidth;
  const availHeight = fp.availHeight || screenHeight - 40;
  const colorDepth = fp.colorDepth || 24;
  const pixelDepth = fp.pixelDepth || 24;
  const devicePixelRatio = fp.devicePixelRatio || 1;
  const hardwareConcurrency = fp.hardwareConcurrency || 8;
  const deviceMemory = fp.deviceMemory || 8;
  const maxTouchPoints = fp.maxTouchPoints || 0;
  const webglVendor = JSON.stringify(fp.webglVendor || 'Google Inc. (Intel)');
  const webglRenderer = JSON.stringify(fp.webglRenderer || 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)');
  const languages = JSON.stringify(fp.languages || ['en-US', 'en']);
  const language = JSON.stringify(fp.language || 'en-US');
  const platform = JSON.stringify(fp.platform || 'Win32');
  const vendor = JSON.stringify(fp.vendor || 'Google Inc.');
  const timezoneOffset = fp.timezoneOffset ?? 300;
  const timezone = JSON.stringify(fp.timezone || 'America/New_York');
  const canvasNoiseSeed = fp.canvasNoiseSeed || Math.floor(Math.random() * 999999999) + 1;
  const audioNoiseSeed = fp.audioNoiseSeed || Math.floor(Math.random() * 999999999) + 1;
  const doNotTrack = fp.doNotTrack === true;
  const webrtcMode = fp.webrtcMode || 'disabled';
  const canvasNoise = fp.canvasNoise !== false;
  const audioNoise = fp.audioNoise !== false;
  const fonts = JSON.stringify(fp.fonts || []);

  return `(function() {
  'use strict';

  // --- Navigator overrides ---
  Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${hardwareConcurrency}, configurable: true });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => ${deviceMemory}, configurable: true });
  Object.defineProperty(navigator, 'maxTouchPoints', { get: () => ${maxTouchPoints}, configurable: true });
  Object.defineProperty(navigator, 'languages', { get: () => ${languages}, configurable: true });
  Object.defineProperty(navigator, 'language', { get: () => ${language}, configurable: true });
  Object.defineProperty(navigator, 'platform', { get: () => ${platform}, configurable: true });
  Object.defineProperty(navigator, 'vendor', { get: () => ${vendor}, configurable: true });
  ${doNotTrack ? `Object.defineProperty(navigator, 'doNotTrack', { get: () => '1', configurable: true });` : ''}

  // --- Screen overrides ---
  Object.defineProperty(screen, 'width', { get: () => ${screenWidth}, configurable: true });
  Object.defineProperty(screen, 'height', { get: () => ${screenHeight}, configurable: true });
  Object.defineProperty(screen, 'availWidth', { get: () => ${availWidth}, configurable: true });
  Object.defineProperty(screen, 'availHeight', { get: () => ${availHeight}, configurable: true });
  Object.defineProperty(screen, 'colorDepth', { get: () => ${colorDepth}, configurable: true });
  Object.defineProperty(screen, 'pixelDepth', { get: () => ${pixelDepth}, configurable: true });
  Object.defineProperty(window, 'devicePixelRatio', { get: () => ${devicePixelRatio}, configurable: true });

  // --- Timezone ---
  Date.prototype.getTimezoneOffset = function() { return ${timezoneOffset}; };
  var origResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
  Intl.DateTimeFormat.prototype.resolvedOptions = function() {
    var result = origResolvedOptions.call(this);
    result.timeZone = ${timezone};
    return result;
  };

  // --- WebGL spoofing (WebGL1 + WebGL2) — vendor, renderer + extended params ---
  (function() {
    // Seeded values for consistent extended WebGL params per profile
    var seed = ${canvasNoiseSeed};
    var paramOverrides = {
      3379: 4096 + (seed % 4) * 4096,       // MAX_TEXTURE_SIZE (4096-16384)
      3386: 16 + (seed % 8),                 // MAX_VERTEX_ATTRIBS (16-23)
      3413: 4 + (seed % 5),                  // MAX_TEXTURE_IMAGE_UNITS (4-8)
      34076: 8192 + (seed % 3) * 4096,       // MAX_RENDERBUFFER_SIZE (8192-16384)
      34024: 16 + (seed % 8),                // MAX_VERTEX_TEXTURE_IMAGE_UNITS (16-23)
      34930: 16 + (seed % 16),               // MAX_COMBINED_TEXTURE_IMAGE_UNITS (16-31)
      36349: 256 + (seed % 256),             // MAX_VERTEX_UNIFORM_COMPONENTS (256-511)
      36347: 256 + (seed % 256),             // MAX_FRAGMENT_UNIFORM_COMPONENTS (256-511)
      7936: ${webglVendor},                  // VENDOR
      7937: ${webglRenderer},                // RENDERER
    };
    function spoofWebGL(proto) {
      var origGetParameter = proto.getParameter;
      proto.getParameter = function(param) {
        if (param === 37445) return ${webglVendor};
        if (param === 37446) return ${webglRenderer};
        if (paramOverrides.hasOwnProperty(param)) return paramOverrides[param];
        return origGetParameter.call(this, param);
      };
    }
    spoofWebGL(WebGLRenderingContext.prototype);
    if (typeof WebGL2RenderingContext !== 'undefined') {
      spoofWebGL(WebGL2RenderingContext.prototype);
    }
  })();

  // --- Canvas noise (seeded PRNG) — covers toDataURL, toBlob AND getImageData ---
  ${canvasNoise ? `
  (function() {
    var seed = ${canvasNoiseSeed};
    function mulberry32(a) {
      return function() {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        var t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
    }
    var rng = mulberry32(seed);
    function addNoise(imageData) {
      for (var i = 0; i < imageData.data.length; i += 4) {
        imageData.data[i] = imageData.data[i] ^ (rng() < 0.1 ? 1 : 0);
      }
      return imageData;
    }
    // Hook getImageData — primary fingerprinting vector
    var origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function(sx, sy, sw, sh) {
      var imageData = origGetImageData.call(this, sx, sy, sw, sh);
      try { addNoise(imageData); } catch(e) {}
      return imageData;
    };
    // Hook toDataURL
    var origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(type, quality) {
      try {
        var ctx = this.getContext('2d');
        if (ctx && this.width > 0 && this.height > 0) {
          var w = Math.min(this.width, 16);
          var h = Math.min(this.height, 16);
          var id = origGetImageData.call(ctx, 0, 0, w, h);
          addNoise(id);
          ctx.putImageData(id, 0, 0);
        }
      } catch(e) {}
      return origToDataURL.call(this, type, quality);
    };
    // Hook toBlob
    var origToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function(callback, type, quality) {
      try {
        var ctx = this.getContext('2d');
        if (ctx && this.width > 0 && this.height > 0) {
          var w = Math.min(this.width, 16);
          var h = Math.min(this.height, 16);
          var id = origGetImageData.call(ctx, 0, 0, w, h);
          addNoise(id);
          ctx.putImageData(id, 0, 0);
        }
      } catch(e) {}
      return origToBlob.call(this, callback, type, quality);
    };
  })();
  ` : ''}

  // --- Audio noise (seeded PRNG) — covers AnalyserNode + AudioBuffer (oscillator/compressor pattern) ---
  ${audioNoise ? `
  (function() {
    var seed = ${audioNoiseSeed};
    function mulberry32(a) {
      return function() {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        var t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
    }
    var rng = mulberry32(seed);
    // AnalyserNode — getFloatFrequencyData + getFloatTimeDomainData
    if (typeof AnalyserNode !== 'undefined') {
      var origGetFloatFreq = AnalyserNode.prototype.getFloatFrequencyData;
      AnalyserNode.prototype.getFloatFrequencyData = function(array) {
        origGetFloatFreq.call(this, array);
        for (var i = 0; i < array.length; i++) {
          array[i] = array[i] + (rng() * 0.1 - 0.05);
        }
      };
      var origGetFloatTime = AnalyserNode.prototype.getFloatTimeDomainData;
      AnalyserNode.prototype.getFloatTimeDomainData = function(array) {
        origGetFloatTime.call(this, array);
        for (var i = 0; i < array.length; i++) {
          array[i] = array[i] + (rng() * 0.001 - 0.0005);
        }
      };
    }
    // AudioBuffer.getChannelData — used by oscillator+compressor fingerprinting
    if (typeof AudioBuffer !== 'undefined') {
      var origGetChannelData = AudioBuffer.prototype.getChannelData;
      AudioBuffer.prototype.getChannelData = function(channel) {
        var data = origGetChannelData.call(this, channel);
        for (var i = 0; i < data.length; i++) {
          data[i] = data[i] + (rng() * 0.0001 - 0.00005);
        }
        return data;
      };
    }
  })();
  ` : ''}

  // --- WebRTC leak prevention ---
  ${webrtcMode === 'disabled' ? `
  (function() {
    // Block all WebRTC interfaces to prevent IP leaks
    Object.defineProperty(window, 'RTCPeerConnection', { value: undefined, configurable: true, writable: true });
    Object.defineProperty(window, 'webkitRTCPeerConnection', { value: undefined, configurable: true, writable: true });
    Object.defineProperty(window, 'RTCDataChannel', { value: undefined, configurable: true, writable: true });
    Object.defineProperty(window, 'RTCSessionDescription', { value: undefined, configurable: true, writable: true });
    Object.defineProperty(window, 'RTCIceCandidate', { value: undefined, configurable: true, writable: true });
    // Block media device enumeration (prevents device ID fingerprinting)
    if (navigator.mediaDevices) {
      navigator.mediaDevices.enumerateDevices = function() {
        return Promise.resolve([]);
      };
    }
  })();
  ` : ''}

  // --- Permissions API ---
  var origQuery = navigator.permissions.query;
  navigator.permissions.query = function(params) {
    if (params.name === 'notifications') {
      return Promise.resolve({ state: Notification.permission });
    }
    return origQuery(params);
  };

  // --- Plugins mock (Chrome 120+ removed Native Client) ---
  Object.defineProperty(navigator, 'plugins', {
    get: function() {
      return [
        { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
        { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
        { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
        { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
        { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
      ];
    },
    configurable: true
  });

  // --- Battery API ---
  if (navigator.getBattery) {
    navigator.getBattery = function() {
      return Promise.resolve({ charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1.0 });
    };
  }

  // --- Connection API ---
  if (navigator.connection) {
    Object.defineProperties(navigator.connection, {
      effectiveType: { get: function() { return '4g'; }, configurable: true },
      rtt: { get: function() { return 50; }, configurable: true },
      downlink: { get: function() { return 10; }, configurable: true },
    });
  }

  // --- ClientRects / DOMRect noise (seeded) ---
  (function() {
    var seed = ${canvasNoiseSeed} + 7;
    function mulberry32(a) {
      return function() {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        var t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
    }
    var rng = mulberry32(seed);
    function noiseRect(rect) {
      var n = (rng() - 0.5) * 0.25;
      return new DOMRect(rect.x + n, rect.y + n, rect.width + n, rect.height + n);
    }
    var origGetBCR = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function() {
      var rect = origGetBCR.call(this);
      return noiseRect(rect);
    };
    var origGetCR = Element.prototype.getClientRects;
    Element.prototype.getClientRects = function() {
      var rects = origGetCR.call(this);
      var result = [];
      for (var i = 0; i < rects.length; i++) {
        result.push(noiseRect(rects[i]));
      }
      return result;
    };
    if (typeof Range !== 'undefined') {
      var origRangeGetBCR = Range.prototype.getBoundingClientRect;
      Range.prototype.getBoundingClientRect = function() {
        var rect = origRangeGetBCR.call(this);
        return noiseRect(rect);
      };
      var origRangeGetCR = Range.prototype.getClientRects;
      Range.prototype.getClientRects = function() {
        var rects = origRangeGetCR.call(this);
        var result = [];
        for (var i = 0; i < rects.length; i++) {
          result.push(noiseRect(rects[i]));
        }
        return result;
      };
    }
  })();

  // --- Font enumeration spoofing ---
  (function() {
    var allowedFonts = ${fonts};
    if (allowedFonts.length > 0 && document.fonts && document.fonts.check) {
      var origCheck = document.fonts.check.bind(document.fonts);
      document.fonts.check = function(font, text) {
        // Extract font family name from CSS font shorthand (e.g. "12px Arial")
        var parts = font.split(/\\s+/);
        var family = parts.slice(1).join(' ').replace(/['"]/g, '').trim();
        if (!family) family = parts[0].replace(/['"]/g, '').trim();
        // If font is not in our allowed list, report it as unavailable
        var isAllowed = allowedFonts.some(function(f) {
          return f.toLowerCase() === family.toLowerCase();
        });
        if (!isAllowed) return false;
        return origCheck(font, text);
      };
    }
  })();

  // --- Chrome runtime mock ---
  if (!window.chrome) window.chrome = {};
  window.chrome.runtime = window.chrome.runtime || {};
})();`;
}
