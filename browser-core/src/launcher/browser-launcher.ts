import * as chromeLauncher from 'chrome-launcher';
import puppeteer from 'puppeteer-core';
import * as proxyChain from 'proxy-chain';
import path from 'path';
import fs from 'fs';
import { BrowserFingerprint } from '../../fingerprint-engine/src/generators/fingerprint-generator';

export interface LaunchOptions {
  profileId: string;
  profilePath?: string;
  fingerprint: BrowserFingerprint;
  proxy?: ProxyConfig;
  headless?: boolean;
  args?: string[];
  extensions?: string[];
}

export interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

export interface BrowserSession {
  browser: puppeteer.Browser;
  profileId: string;
  wsEndpoint: string;
  pid: number;
}

export class BrowserLauncher {
  private sessions: Map<string, BrowserSession> = new Map();
  private profilesDir: string;

  constructor(profilesDir?: string) {
    this.profilesDir = profilesDir || path.join(process.cwd(), 'browser-profiles');
    if (!fs.existsSync(this.profilesDir)) {
      fs.mkdirSync(this.profilesDir, { recursive: true });
    }
  }

  async launch(options: LaunchOptions): Promise<BrowserSession> {
    const profilePath = options.profilePath || path.join(this.profilesDir, options.profileId);
    
    if (!fs.existsSync(profilePath)) {
      fs.mkdirSync(profilePath, { recursive: true });
    }

    const chromeArgs = await this.buildChromeArgs(options, profilePath);
    
    // Launch Chrome with chrome-launcher
    const chrome = await chromeLauncher.launch({
      chromeFlags: chromeArgs,
      userDataDir: profilePath,
      logLevel: 'silent'
    });

    // Connect with Puppeteer
    const browser = await puppeteer.connect({
      browserWSEndpoint: `ws://localhost:${chrome.port}/devtools/browser/${await this.getWSEndpoint(chrome.port)}`,
      defaultViewport: null
    });

    // Inject fingerprint on all pages
    browser.on('targetcreated', async (target) => {
      if (target.type() === 'page') {
        const page = await target.page();
        if (page) {
          await this.injectFingerprint(page, options.fingerprint);
        }
      }
    });

    // Apply fingerprint to existing pages
    const pages = await browser.pages();
    for (const page of pages) {
      await this.injectFingerprint(page, options.fingerprint);
    }

    const session: BrowserSession = {
      browser,
      profileId: options.profileId,
      wsEndpoint: browser.wsEndpoint(),
      pid: chrome.pid
    };

    this.sessions.set(options.profileId, session);

    return session;
  }

  private async buildChromeArgs(options: LaunchOptions, profilePath: string): Promise<string[]> {
    const args = [
      '--no-default-browser-check',
      '--no-first-run',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-site-isolation-trials',
      '--enable-features=PasswordManager,PasswordManagerOnboarding',
      '--enable-autofill',
      '--enable-sync',
      '--test-type',
      `--user-data-dir=${profilePath}`,
      `--profile-directory=Default`,
      `--window-size=${options.fingerprint.screenResolution}`,
      `--user-agent=${options.fingerprint.userAgent}`,
      `--lang=${options.fingerprint.language}`,
    ];

    // Timezone
    args.push(`--timezone=${options.fingerprint.timezone}`);

    // WebRTC
    if (options.fingerprint.webrtc.mode === 'disabled') {
      args.push('--disable-webrtc');
    } else if (options.fingerprint.webrtc.mode === 'fake') {
      args.push(`--webrtc-public-ip=${options.fingerprint.webrtc.publicIP}`);
      args.push(`--webrtc-local-ips=${options.fingerprint.webrtc.localIPs.join(',')}`);
    }

    // Proxy
    if (options.proxy) {
      const proxyUrl = await this.setupProxy(options.proxy);
      args.push(`--proxy-server=${proxyUrl}`);
    }

    // Extensions
    if (options.extensions && options.extensions.length > 0) {
      args.push(`--load-extension=${options.extensions.join(',')}`);
    }

    // Headless
    if (options.headless) {
      args.push('--headless=new');
    }

    // Additional args
    if (options.args) {
      args.push(...options.args);
    }

    return args;
  }

  private async setupProxy(proxyConfig: ProxyConfig): Promise<string> {
    if (proxyConfig.username && proxyConfig.password) {
      // Create authenticated proxy
      const oldProxyUrl = `http://${proxyConfig.username}:${proxyConfig.password}@${proxyConfig.server}`;
      const newProxyUrl = await proxyChain.anonymizeProxy(oldProxyUrl);
      return newProxyUrl;
    }
    return proxyConfig.server;
  }

  private async injectFingerprint(page: puppeteer.Page, fingerprint: BrowserFingerprint): Promise<void> {
    await page.evaluateOnNewDocument((fp) => {
      // Override navigator properties
      Object.defineProperty(navigator, 'hardwareConcurrency', {
        get: () => fp.hardwareConcurrency
      });

      Object.defineProperty(navigator, 'deviceMemory', {
        get: () => fp.deviceMemory
      });

      Object.defineProperty(navigator, 'platform', {
        get: () => fp.platform
      });

      Object.defineProperty(navigator, 'language', {
        get: () => fp.language
      });

      Object.defineProperty(navigator, 'languages', {
        get: () => fp.languages
      });

      // Override screen properties
      Object.defineProperty(screen, 'colorDepth', {
        get: () => fp.colorDepth
      });

      Object.defineProperty(screen, 'pixelDepth', {
        get: () => fp.colorDepth
      });

      const [width, height] = fp.screenResolution.split('x').map(Number);
      Object.defineProperty(screen, 'width', {
        get: () => width
      });

      Object.defineProperty(screen, 'height', {
        get: () => height
      });

      const [availWidth, availHeight] = fp.availableScreenResolution.split('x').map(Number);
      Object.defineProperty(screen, 'availWidth', {
        get: () => availWidth
      });

      Object.defineProperty(screen, 'availHeight', {
        get: () => availHeight
      });

      // Override WebGL
      const getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function(parameter) {
        if (parameter === 37445) return fp.webglVendor;
        if (parameter === 37446) return fp.webglRenderer;
        return getParameter.apply(this, arguments);
      };

      const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function(parameter) {
        if (parameter === 37445) return fp.webglVendor;
        if (parameter === 37446) return fp.webglRenderer;
        return getParameter2.apply(this, arguments);
      };

      // Override Canvas
      const toDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function() {
        const context = this.getContext('2d');
        if (context) {
          context.fillStyle = `rgba(0, 0, 0, ${fp.canvas.noise})`;
          context.fillRect(0, 0, 1, 1);
        }
        return toDataURL.apply(this, arguments);
      };

      // Override Plugins
      Object.defineProperty(navigator, 'plugins', {
        get: () => {
          const plugins = [];
          for (const plugin of fp.plugins) {
            plugins.push({
              name: plugin.name,
              filename: plugin.filename,
              description: plugin.description,
              length: 0
            });
          }
          return plugins;
        }
      });

      // Override Battery API
      if (fp.battery && 'getBattery' in navigator) {
        navigator.getBattery = async () => ({
          charging: fp.battery.charging,
          chargingTime: fp.battery.chargingTime,
          dischargingTime: fp.battery.dischargingTime,
          level: fp.battery.level,
          addEventListener: () => {},
          removeEventListener: () => {}
        });
      }

      // Override Connection API
      if (fp.connection && 'connection' in navigator) {
        Object.defineProperty(navigator, 'connection', {
          get: () => ({
            effectiveType: fp.connection.effectiveType,
            rtt: fp.connection.rtt,
            downlink: fp.connection.downlink,
            saveData: fp.connection.saveData,
            addEventListener: () => {},
            removeEventListener: () => {}
          })
        });
      }

      // Remove webdriver traces
      delete navigator.__proto__.webdriver;
      
      // Override permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => {
        if (parameters.name === 'notifications') {
          return Promise.resolve({ state: 'prompt' });
        }
        return originalQuery(parameters);
      };

    }, fingerprint);

    // Inject timezone
    await page.emulateTimezone(fingerprint.timezone);

    // Set viewport
    const [width, height] = fingerprint.screenResolution.split('x').map(Number);
    await page.setViewport({ width, height });
  }

  private async getWSEndpoint(port: number): Promise<string> {
    const response = await fetch(`http://localhost:${port}/json/version`);
    const data = await response.json();
    const wsUrl = data.webSocketDebuggerUrl;
    return wsUrl.split('/').pop();
  }

  async close(profileId: string): Promise<boolean> {
    const session = this.sessions.get(profileId);
    if (!session) return false;

    await session.browser.close();
    this.sessions.delete(profileId);
    
    // Kill Chrome process
    try {
      process.kill(session.pid);
    } catch (e) {
      // Process might already be dead
    }

    return true;
  }

  async closeAll(): Promise<void> {
    const promises = Array.from(this.sessions.keys()).map(id => this.close(id));
    await Promise.all(promises);
  }

  getSession(profileId: string): BrowserSession | undefined {
    return this.sessions.get(profileId);
  }

  getAllSessions(): BrowserSession[] {
    return Array.from(this.sessions.values());
  }
}