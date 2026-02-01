"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserLauncher = void 0;
const chromeLauncher = __importStar(require("chrome-launcher"));
const puppeteer_core_1 = __importDefault(require("puppeteer-core"));
const proxyChain = __importStar(require("proxy-chain"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
class BrowserLauncher {
    constructor(profilesDir) {
        this.sessions = new Map();
        this.profilesDir = profilesDir || path_1.default.join(process.cwd(), 'browser-profiles');
        if (!fs_1.default.existsSync(this.profilesDir)) {
            fs_1.default.mkdirSync(this.profilesDir, { recursive: true });
        }
    }
    async launch(options) {
        const profilePath = options.profilePath || path_1.default.join(this.profilesDir, options.profileId);
        if (!fs_1.default.existsSync(profilePath)) {
            fs_1.default.mkdirSync(profilePath, { recursive: true });
        }
        const chromeArgs = await this.buildChromeArgs(options, profilePath);
        // Launch Chrome with chrome-launcher
        const chrome = await chromeLauncher.launch({
            chromeFlags: chromeArgs,
            userDataDir: profilePath,
            logLevel: 'silent'
        });
        // Connect with Puppeteer
        const browser = await puppeteer_core_1.default.connect({
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
        const session = {
            browser,
            profileId: options.profileId,
            wsEndpoint: browser.wsEndpoint(),
            pid: chrome.pid
        };
        this.sessions.set(options.profileId, session);
        return session;
    }
    async buildChromeArgs(options, profilePath) {
        const args = [
            '--no-default-browser-check',
            '--no-first-run',
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-web-security',
            '--disable-site-isolation-trials',
            `--user-data-dir=${profilePath}`,
            `--window-size=${options.fingerprint.screenResolution}`,
            `--user-agent=${options.fingerprint.userAgent}`,
            `--lang=${options.fingerprint.language}`,
        ];
        // Timezone
        args.push(`--timezone=${options.fingerprint.timezone}`);
        // WebRTC
        if (options.fingerprint.webrtc.mode === 'disabled') {
            args.push('--disable-webrtc');
        }
        else if (options.fingerprint.webrtc.mode === 'fake') {
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
    async setupProxy(proxyConfig) {
        if (proxyConfig.username && proxyConfig.password) {
            // Create authenticated proxy
            const oldProxyUrl = `http://${proxyConfig.username}:${proxyConfig.password}@${proxyConfig.server}`;
            const newProxyUrl = await proxyChain.anonymizeProxy(oldProxyUrl);
            return newProxyUrl;
        }
        return proxyConfig.server;
    }
    async injectFingerprint(page, fingerprint) {
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
            WebGLRenderingContext.prototype.getParameter = function (parameter) {
                if (parameter === 37445)
                    return fp.webglVendor;
                if (parameter === 37446)
                    return fp.webglRenderer;
                return getParameter.apply(this, arguments);
            };
            const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
            WebGL2RenderingContext.prototype.getParameter = function (parameter) {
                if (parameter === 37445)
                    return fp.webglVendor;
                if (parameter === 37446)
                    return fp.webglRenderer;
                return getParameter2.apply(this, arguments);
            };
            // Override Canvas
            const toDataURL = HTMLCanvasElement.prototype.toDataURL;
            HTMLCanvasElement.prototype.toDataURL = function () {
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
                    addEventListener: () => { },
                    removeEventListener: () => { }
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
                        addEventListener: () => { },
                        removeEventListener: () => { }
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
    async getWSEndpoint(port) {
        const response = await fetch(`http://localhost:${port}/json/version`);
        const data = await response.json();
        const wsUrl = data.webSocketDebuggerUrl;
        return wsUrl.split('/').pop();
    }
    async close(profileId) {
        const session = this.sessions.get(profileId);
        if (!session)
            return false;
        await session.browser.close();
        this.sessions.delete(profileId);
        // Kill Chrome process
        try {
            process.kill(session.pid);
        }
        catch (e) {
            // Process might already be dead
        }
        return true;
    }
    async closeAll() {
        const promises = Array.from(this.sessions.keys()).map(id => this.close(id));
        await Promise.all(promises);
    }
    getSession(profileId) {
        return this.sessions.get(profileId);
    }
    getAllSessions() {
        return Array.from(this.sessions.values());
    }
}
exports.BrowserLauncher = BrowserLauncher;
//# sourceMappingURL=browser-launcher.js.map