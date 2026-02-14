import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import * as net from 'net';
import { spawn, ChildProcess } from 'child_process';
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
   */
  private static cleanProfileState(profilePath: string) {
    const keepFiles = new Set([
      'pending_cookies.json', 'synced_cookies.json', 'open_tabs.json',
      'last_url.txt', '__proxy_auth_ext', '__brand_fix_ext',
      '__cookie_sync_ext', '__platform_fix_ext',
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
        if (instance && instance.chromeProcess && !instance.chromeProcess.killed) {
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
      // Enable developer mode for extensions loading
      if (!prefs.extensions) prefs.extensions = {};
      prefs.extensions.developer_mode = true;
      // Suppress "disable developer mode extensions" dialog
      if (!prefs.extensions.alerts) prefs.extensions.alerts = {};
      prefs.extensions.alerts.initialized = true;
      fs.writeFileSync(prefsPath, JSON.stringify(prefs));

      // Proxy config
      let proxy: any = null;
      if (options.proxy?.host) {
        proxy = options.proxy;
      }

      const cacheDir = path.join(profilePath, 'Cache');
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }

      // Get Chrome for Testing (supports --load-extension for unpacked extensions)
      const chromePath = await this.downloadChromeForTesting();

      // Build Chrome args — MINIMAL flags only
      const userAgent = options.userAgent || options.fingerprint?.userAgent || '';
      const args = [
        `--user-data-dir=${profilePath}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-infobars',
        '--window-size=1280,800',
        `--lang=${options.fingerprint?.language || options.fingerprint?.languages?.[0] || 'en-US'}`,
        '--disable-features=UserAgentClientHint',
      ];

      // Force User-Agent to match fingerprint (consistent across Mac/Windows)
      if (userAgent) {
        args.push(`--user-agent=${userAgent}`);
        console.log(`[UA] Forced: ${userAgent.substring(0, 80)}...`);
      }

      // WebRTC leak protection when using proxy
      if (proxy && proxy.host) {
        args.push('--webrtc-ip-handling-policy=disable_non_proxied_udp');
        args.push('--enforce-webrtc-ip-permission-check');
      }

      // Proxy — local relay server handles auth transparently
      let localProxyServer: http.Server | null = null;
      if (proxy && proxy.host) {
        const proxyType = (proxy.type || 'http').toLowerCase();

        if (proxy.username && proxy.password && (proxyType === 'http' || proxyType === 'https')) {
          // Spawn a local proxy that relays to remote proxy with auth
          const localProxy = await this.createLocalProxy(proxy);
          localProxyServer = localProxy.server;
          args.push(`--proxy-server=http://127.0.0.1:${localProxy.port}`);
          console.log(`[Proxy] Local relay on port ${localProxy.port} → ${proxy.host}:${proxy.port}`);
        } else if (proxyType === 'socks5' || proxyType === 'socks4') {
          args.push(`--proxy-server=${proxyType}://${proxy.host}:${proxy.port}`);
        } else {
          args.push(`--proxy-server=http://${proxy.host}:${proxy.port}`);
        }
      }

      // Create platform-fix extension (overrides navigator.platform to match UA)
      let platformFixPath: string | null = null;
      if (userAgent) {
        const isWindows = userAgent.includes('Windows');
        const isMac = userAgent.includes('Macintosh');
        const platform = isWindows ? 'Win32' : isMac ? 'MacIntel' : 'Linux x86_64';

        platformFixPath = path.join(profilePath, '__platform_fix_ext');
        if (fs.existsSync(platformFixPath)) {
          fs.rmSync(platformFixPath, { recursive: true, force: true });
        }
        fs.mkdirSync(platformFixPath, { recursive: true });

        fs.writeFileSync(path.join(platformFixPath, 'manifest.json'), JSON.stringify({
          manifest_version: 3,
          name: 'Platform',
          version: '1.0',
          content_scripts: [{
            matches: ['<all_urls>'],
            js: ['platform.js'],
            run_at: 'document_start',
            all_frames: true,
            world: 'MAIN',
          }],
        }));

        fs.writeFileSync(path.join(platformFixPath, 'platform.js'),
          `Object.defineProperty(navigator, 'platform', { get: () => ${JSON.stringify(platform)} });`
        );
        console.log(`[Platform] Override: ${platform}`);
      }

      // Create cookie-sync extension (export/import cookies for cloud sync)
      const cookieSyncPath = path.join(profilePath, '__cookie_sync_ext');
      if (fs.existsSync(cookieSyncPath)) {
        fs.rmSync(cookieSyncPath, { recursive: true, force: true });
      }
      fs.mkdirSync(cookieSyncPath, { recursive: true });

      fs.writeFileSync(path.join(cookieSyncPath, 'manifest.json'), JSON.stringify({
        manifest_version: 3,
        name: 'Cookie Sync',
        version: '1.0',
        permissions: ['cookies'],
        host_permissions: ['<all_urls>'],
        background: { service_worker: 'background.js' },
      }));

      // Write synced cookies as cookies.json for import
      const syncedCookiesPath = path.join(profilePath, 'synced_cookies.json');
      if (fs.existsSync(syncedCookiesPath)) {
        try {
          const cookies = fs.readFileSync(syncedCookiesPath, 'utf8');
          fs.writeFileSync(path.join(cookieSyncPath, 'cookies.json'), cookies);
          console.log(`[CookieSync] Loaded cookies for import`);
        } catch {}
      } else {
        fs.writeFileSync(path.join(cookieSyncPath, 'cookies.json'), '[]');
      }

      fs.writeFileSync(path.join(cookieSyncPath, 'background.js'),
`const PROFILE_ID = ${JSON.stringify(options.profileId)};
const SERVER = 'http://127.0.0.1:45678';

// Import cookies from cookies.json at startup
async function importCookies() {
  try {
    const response = await fetch(chrome.runtime.getURL('cookies.json'));
    if (!response.ok) return;
    const cookies = await response.json();
    if (!Array.isArray(cookies) || cookies.length === 0) return;
    let imported = 0;
    for (const c of cookies) {
      try {
        const details = {
          url: 'http' + (c.secure ? 's' : '') + '://' + (c.domain || '').replace(/^\\./, '') + (c.path || '/'),
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          secure: c.secure || false,
          httpOnly: c.httpOnly || false,
          sameSite: c.sameSite === 'None' ? 'no_restriction' : (c.sameSite || 'lax').toLowerCase(),
        };
        if (c.expires && c.expires > 0) details.expirationDate = c.expires;
        else if (c.expirationDate && c.expirationDate > 0) details.expirationDate = c.expirationDate;
        await chrome.cookies.set(details);
        imported++;
      } catch (e) {}
    }
    console.log('[CookieSync] Imported ' + imported + '/' + cookies.length + ' cookies');
  } catch (e) {}
}

// Export all cookies to local server
async function exportCookies() {
  try {
    const cookies = await chrome.cookies.getAll({});
    await fetch(SERVER + '/api/save-cookies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: PROFILE_ID, cookies }),
    });
    console.log('[CookieSync] Exported ' + cookies.length + ' cookies');
  } catch (e) {}
}

// Import on startup
importCookies();

// Export every 30 seconds
setInterval(exportCookies, 30000);

// Also export after 5 seconds (initial page load)
setTimeout(exportCookies, 5000);
`
      );
      console.log(`[CookieSync] Created cookie sync extension`);

      // Collect extensions
      const extPaths: string[] = [cookieSyncPath];
      if (platformFixPath) extPaths.push(platformFixPath);
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
        console.log(`[Extensions] Loading ${extPaths.length} extension(s)`);
      }

      // Determine start URL
      const isValidUrl = (url: string) => url && (url.startsWith('https://') || url.startsWith('http://'));
      let startUrl = isValidUrl(options.lastUrl || '') ? options.lastUrl! : 'https://www.google.com';
      const lastUrlPath = path.join(profilePath, 'last_url.txt');
      if (fs.existsSync(lastUrlPath)) {
        try {
          const savedUrl = fs.readFileSync(lastUrlPath, 'utf8').trim();
          if (isValidUrl(savedUrl)) {
            startUrl = savedUrl;
          }
        } catch {}
      }
      args.push(startUrl);

      console.log(`Launching Chrome: ${chromePath}`);
      console.log(`Start URL: ${startUrl}`);
      console.log(`Mode: ZERO CDP (no debug port, no WebSocket, fully clean)`);

      // Clean environment
      const cleanEnv: Record<string, string | undefined> = {};
      for (const [key, val] of Object.entries(process.env)) {
        if (!key.startsWith('ELECTRON') && key !== 'NODE_OPTIONS') {
          cleanEnv[key] = val;
        }
      }
      // Set timezone to match fingerprint/proxy location
      if (options.fingerprint?.timezone) {
        cleanEnv['TZ'] = options.fingerprint.timezone;
        console.log(`[Timezone] Set to ${options.fingerprint.timezone}`);
      }

      // === SPAWN Chrome — no Puppeteer, no CDP, no debug port ===
      const chromeProcess = spawn(chromePath, args, {
        detached: false,
        stdio: 'ignore',
        env: cleanEnv as any,
      });

      console.log(`[Chrome] Process spawned (PID: ${chromeProcess.pid}) — CDP-free`);

      // Store profile instance
      this.activeProfiles.set(options.profileId, {
        chromeProcess,
        profilePath,
        profileId: options.profileId,
        localProxyServer,
      });

      // Monitor Chrome process exit
      chromeProcess.on('exit', (code, signal) => {
        console.log(`[Chrome] Process exited (code: ${code}) for profile: ${options.profileId}`);
        // Close local proxy server
        if (localProxyServer) {
          localProxyServer.close();
          console.log(`[Proxy] Local relay closed for profile: ${options.profileId}`);
        }

        // Save last URL from open_tabs.json (updated by extension or Chrome itself)
        // Note: Without CDP we can't export cookies on exit, but Chrome saves them
        // to its native Cookies DB which is included in profile sync

        this.activeProfiles.delete(options.profileId);
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('profiles:activeUpdate', Array.from(this.activeProfiles.keys()));
          this.mainWindow.webContents.send('profile:closed', options.profileId);
        }
      });

      console.log(`Chrome launched successfully for profile: ${options.profileId}`);
      return { success: true };

    } catch (error: any) {
      console.error('Error launching browser:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Find system-installed Chrome (sends proper "Google Chrome" in Sec-Ch-Ua)
   */
  private static findSystemChrome(): string | null {
    const candidates: string[] = [];
    if (process.platform === 'win32') {
      const programFiles = process.env['PROGRAMFILES'] || 'C:\\Program Files';
      const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
      const localAppData = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');
      candidates.push(
        path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      );
    } else if (process.platform === 'darwin') {
      candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    } else {
      candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable');
    }
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        console.log(`[Browser] Found system Chrome: ${c}`);
        return c;
      }
    }
    console.log('[Browser] System Chrome not found, will use Chrome for Testing');
    return null;
  }

  /**
   * Download Chrome for Testing (fallback)
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

  /**
   * Create a local HTTP proxy that relays to a remote proxy with authentication.
   * Chrome connects to localhost (no auth needed), local proxy adds Proxy-Authorization.
   */
  private static createLocalProxy(proxy: any): Promise<{ server: http.Server; port: number }> {
    return new Promise((resolve, reject) => {
      const authHeader = 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
      const remoteHost = proxy.host;
      const remotePort = Number(proxy.port);

      const server = http.createServer((req, res) => {
        // HTTP requests — forward with auth header
        const options: http.RequestOptions = {
          host: remoteHost,
          port: remotePort,
          method: req.method,
          path: req.url,
          headers: { ...req.headers, 'Proxy-Authorization': authHeader },
        };
        const proxyReq = http.request(options, (proxyRes) => {
          res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
          proxyRes.pipe(res);
        });
        proxyReq.on('error', (e) => {
          console.error('[Proxy] HTTP relay error:', e.message);
          res.writeHead(502);
          res.end('Proxy error');
        });
        req.pipe(proxyReq);
      });

      // HTTPS CONNECT tunneling
      server.on('connect', (req, clientSocket, head) => {
        const connectReq = `CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\nProxy-Authorization: ${authHeader}\r\n\r\n`;
        const remoteSocket = net.connect(remotePort, remoteHost, () => {
          remoteSocket.write(connectReq);
        });

        let responded = false;
        remoteSocket.once('data', (chunk) => {
          const response = chunk.toString();
          if (response.includes('200')) {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length > 0) remoteSocket.write(head);
            remoteSocket.pipe(clientSocket);
            clientSocket.pipe(remoteSocket);
            responded = true;
          } else {
            clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
            clientSocket.end();
            remoteSocket.end();
          }
        });

        remoteSocket.on('error', (e) => {
          console.error('[Proxy] CONNECT relay error:', e.message);
          if (!responded) {
            clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
            clientSocket.end();
          }
        });

        clientSocket.on('error', () => remoteSocket.destroy());
        remoteSocket.on('close', () => clientSocket.destroy());
        clientSocket.on('close', () => remoteSocket.destroy());
      });

      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        console.log(`[Proxy] Local relay started on 127.0.0.1:${addr.port}`);
        resolve({ server, port: addr.port });
      });

      server.on('error', reject);
    });
  }

  static async closeProfile(profileId: string) {
    const instance = this.activeProfiles.get(profileId);
    if (instance) {
      try {
        if (instance.localProxyServer) instance.localProxyServer.close();
        if (instance.chromeProcess && !instance.chromeProcess.killed) {
          instance.chromeProcess.kill();
        }
      } catch {}
      this.activeProfiles.delete(profileId);
    }
  }

  static getActiveProfiles(): string[] {
    return Array.from(this.activeProfiles.keys());
  }

  static async getCookies(profileId: string): Promise<any[]> {
    // Without CDP, we read cookies from the synced_cookies.json file
    const instance = this.activeProfiles.get(profileId);
    if (!instance) return [];

    try {
      const syncedPath = path.join(instance.profilePath, 'synced_cookies.json');
      if (fs.existsSync(syncedPath)) {
        return JSON.parse(fs.readFileSync(syncedPath, 'utf8'));
      }
    } catch {}
    return [];
  }
}
