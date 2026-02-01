"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FingerprintGenerator = void 0;
const faker_1 = __importDefault(require("faker"));
const ua_parser_js_1 = __importDefault(require("ua-parser-js"));
const crypto_js_1 = __importDefault(require("crypto-js"));
const uuid_1 = require("uuid");
class FingerprintGenerator {
    static generateFingerprint(options) {
        const userAgent = options?.userAgent || this.getRandomElement(this.userAgents);
        const parser = new ua_parser_js_1.default(userAgent);
        const uaResult = parser.getResult();
        const platform = this.getPlatform(uaResult);
        const webglVendor = this.getRandomElement(this.webglVendors);
        const resolution = options?.screenResolution || this.getRandomElement(this.resolutions);
        return {
            userAgent,
            platform,
            hardwareConcurrency: options?.hardwareConcurrency || this.getRandomInt(2, 16),
            deviceMemory: options?.deviceMemory || this.getRandomElement([2, 4, 8, 16]),
            screenResolution: resolution,
            availableScreenResolution: this.getAvailableResolution(resolution),
            colorDepth: options?.colorDepth || 24,
            pixelRatio: this.getPixelRatio(uaResult),
            timezone: options?.timezone || 'America/New_York',
            language: options?.language || 'en-US',
            languages: options?.languages || ['en-US', 'en'],
            webglVendor,
            webglRenderer: this.getWebGLRenderer(webglVendor),
            canvas: this.generateCanvasFingerprint(),
            audioContext: this.generateAudioFingerprint(),
            fonts: this.getRandomFonts(),
            plugins: this.generatePlugins(uaResult),
            webrtc: options?.webrtc || this.generateWebRTCFingerprint(),
            battery: options?.battery || this.generateBatteryFingerprint(),
            connection: this.generateConnectionFingerprint()
        };
    }
    static getPlatform(uaResult) {
        const os = uaResult.os.name;
        if (os?.includes('Windows'))
            return 'Win32';
        if (os?.includes('Mac'))
            return 'MacIntel';
        if (os?.includes('Linux'))
            return 'Linux x86_64';
        return 'Win32';
    }
    static getPixelRatio(uaResult) {
        if (uaResult.device.type === 'mobile')
            return 2;
        if (uaResult.os.name?.includes('Mac'))
            return 2;
        return 1;
    }
    static getAvailableResolution(resolution) {
        const [width, height] = resolution.split('x').map(Number);
        const taskbarHeight = this.getRandomInt(30, 50);
        return `${width}x${height - taskbarHeight}`;
    }
    static getWebGLRenderer(vendor) {
        const renderers = this.webglRenderers[vendor] || ['WebKit WebGL'];
        return this.getRandomElement(renderers);
    }
    static generateCanvasFingerprint() {
        const dataURL = `data:image/png;base64,${this.generateRandomBase64(100)}`;
        const noise = Math.random() * 0.0001;
        const hash = crypto_js_1.default.SHA256(dataURL + noise).toString();
        return {
            dataURL,
            hash,
            noise
        };
    }
    static generateAudioFingerprint() {
        return {
            sampleRate: this.getRandomElement([44100, 48000]),
            channelCount: 2,
            oscillatorType: 'sine',
            dynamicsCompressorFingerprint: this.generateRandomHash()
        };
    }
    static getRandomFonts() {
        const count = this.getRandomInt(10, this.fonts.length);
        const shuffled = [...this.fonts].sort(() => Math.random() - 0.5);
        return shuffled.slice(0, count);
    }
    static generatePlugins(uaResult) {
        if (uaResult.browser.name === 'Firefox') {
            return [];
        }
        const plugins = [
            {
                name: 'Chrome PDF Plugin',
                filename: 'internal-pdf-viewer',
                description: 'Portable Document Format'
            },
            {
                name: 'Chrome PDF Viewer',
                filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai',
                description: ''
            },
            {
                name: 'Native Client',
                filename: 'internal-nacl-plugin',
                description: ''
            }
        ];
        return this.getRandomInt(0, 10) > 3 ? plugins : [];
    }
    static generateWebRTCFingerprint() {
        const mode = this.getRandomElement(['real', 'fake', 'disabled']);
        if (mode === 'disabled') {
            return {
                mode,
                localIPs: [],
                stunServers: []
            };
        }
        return {
            mode,
            publicIP: mode === 'real' ? undefined : faker_1.default.internet.ip(),
            localIPs: [
                `192.168.${this.getRandomInt(0, 255)}.${this.getRandomInt(1, 255)}`,
                `10.${this.getRandomInt(0, 255)}.${this.getRandomInt(0, 255)}.${this.getRandomInt(1, 255)}`
            ],
            stunServers: [
                'stun:stun.l.google.com:19302',
                'stun:stun1.l.google.com:19302'
            ]
        };
    }
    static generateBatteryFingerprint() {
        const charging = Math.random() > 0.5;
        return {
            charging,
            level: Number((Math.random() * 0.8 + 0.2).toFixed(2)),
            chargingTime: charging ? this.getRandomInt(0, 7200) : Infinity,
            dischargingTime: charging ? Infinity : this.getRandomInt(3600, 28800)
        };
    }
    static generateConnectionFingerprint() {
        return {
            effectiveType: this.getRandomElement(['4g', '3g', 'slow-2g']),
            rtt: this.getRandomInt(50, 200),
            downlink: Number((Math.random() * 10 + 0.5).toFixed(2)),
            saveData: false
        };
    }
    static getRandomElement(array) {
        return array[Math.floor(Math.random() * array.length)];
    }
    static getRandomInt(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }
    static generateRandomBase64(length) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        let result = '';
        for (let i = 0; i < length; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }
    static generateRandomHash() {
        return crypto_js_1.default.SHA256((0, uuid_1.v4)()).toString();
    }
    static validateFingerprint(fingerprint) {
        const requiredFields = [
            'userAgent', 'platform', 'hardwareConcurrency', 'deviceMemory',
            'screenResolution', 'colorDepth', 'timezone', 'language'
        ];
        for (const field of requiredFields) {
            if (!fingerprint[field]) {
                return false;
            }
        }
        return true;
    }
    static calculateSimilarity(fp1, fp2) {
        let score = 0;
        const weights = {
            userAgent: 0.15,
            platform: 0.1,
            screenResolution: 0.1,
            timezone: 0.05,
            language: 0.05,
            webglVendor: 0.15,
            webglRenderer: 0.15,
            canvas: 0.15,
            fonts: 0.1
        };
        if (fp1.userAgent === fp2.userAgent)
            score += weights.userAgent;
        if (fp1.platform === fp2.platform)
            score += weights.platform;
        if (fp1.screenResolution === fp2.screenResolution)
            score += weights.screenResolution;
        if (fp1.timezone === fp2.timezone)
            score += weights.timezone;
        if (fp1.language === fp2.language)
            score += weights.language;
        if (fp1.webglVendor === fp2.webglVendor)
            score += weights.webglVendor;
        if (fp1.webglRenderer === fp2.webglRenderer)
            score += weights.webglRenderer;
        if (fp1.canvas.hash === fp2.canvas.hash)
            score += weights.canvas;
        const fontSimilarity = this.calculateArraySimilarity(fp1.fonts, fp2.fonts);
        score += weights.fonts * fontSimilarity;
        return score;
    }
    static calculateArraySimilarity(arr1, arr2) {
        const set1 = new Set(arr1);
        const set2 = new Set(arr2);
        const intersection = new Set([...set1].filter(x => set2.has(x)));
        const union = new Set([...set1, ...set2]);
        return intersection.size / union.size;
    }
}
exports.FingerprintGenerator = FingerprintGenerator;
FingerprintGenerator.userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
];
FingerprintGenerator.webglVendors = [
    'Google Inc.',
    'Intel Inc.',
    'NVIDIA Corporation',
    'AMD',
    'Apple Inc.',
    'Microsoft Corporation'
];
FingerprintGenerator.webglRenderers = {
    'Google Inc.': [
        'ANGLE (Intel(R) HD Graphics Direct3D11 vs_5_0 ps_5_0)',
        'ANGLE (NVIDIA GeForce GTX 1660 Direct3D11 vs_5_0 ps_5_0)',
        'ANGLE (AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0)'
    ],
    'Intel Inc.': [
        'Intel(R) HD Graphics 620',
        'Intel(R) UHD Graphics 630',
        'Intel(R) Iris(R) Xe Graphics'
    ],
    'NVIDIA Corporation': [
        'GeForce GTX 1050/PCIe/SSE2',
        'GeForce GTX 1660/PCIe/SSE2',
        'GeForce RTX 3060/PCIe/SSE2'
    ]
};
FingerprintGenerator.fonts = [
    'Arial', 'Arial Black', 'Comic Sans MS', 'Courier New', 'Georgia',
    'Impact', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Helvetica',
    'Tahoma', 'Segoe UI', 'Calibri', 'Consolas', 'Monaco', 'Lucida Console'
];
FingerprintGenerator.resolutions = [
    '1920x1080', '1366x768', '1440x900', '1536x864', '1600x900',
    '1280x720', '1280x800', '1280x1024', '1920x1200', '2560x1440'
];
exports.default = FingerprintGenerator;
//# sourceMappingURL=fingerprint-generator.js.map