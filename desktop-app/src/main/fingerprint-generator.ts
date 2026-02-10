// Realistic fingerprint generator with weighted random selection

export interface GeneratedFingerprint {
  userAgent: string;
  os: 'windows' | 'macos' | 'linux';
  browserType: 'chrome';
  chromeVersion: string;
  timezone: string;
  timezoneOffset: number;
  language: string;
  languages: string[];
  screenResolution: string;
  screenWidth: number;
  screenHeight: number;
  availWidth: number;
  availHeight: number;
  colorDepth: number;
  pixelDepth: number;
  devicePixelRatio: number;
  hardwareConcurrency: number;
  deviceMemory: number;
  maxTouchPoints: number;
  webglVendor: string;
  webglRenderer: string;
  canvasNoiseSeed: number;
  audioNoiseSeed: number;
  canvasNoise: boolean;
  audioNoise: boolean;
  webrtcMode: 'real' | 'disabled' | 'fake';
  doNotTrack: boolean;
  platform: string;
  vendor: string;
  fonts: string[];
}

// --- Data arrays with weights ---

// Chrome version MUST match the real Chrome binary (140.x)
// Any mismatch causes Sec-CH-UA inconsistency that sites like Twitter detect
const CHROME_VERSIONS = [
  { version: '140.0.7339.82', weight: 100 },
];

const UA_TEMPLATES: Record<string, string> = {
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{VERSION} Safari/537.36',
  macos: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{VERSION} Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{VERSION} Safari/537.36',
};

const SCREEN_RESOLUTIONS = [
  { width: 1920, height: 1080, weight: 30 },
  { width: 1366, height: 768, weight: 15 },
  { width: 1536, height: 864, weight: 10 },
  { width: 1440, height: 900, weight: 8 },
  { width: 1600, height: 900, weight: 6 },
  { width: 2560, height: 1440, weight: 8 },
  { width: 1280, height: 720, weight: 5 },
  { width: 1280, height: 800, weight: 4 },
  { width: 1920, height: 1200, weight: 4 },
  { width: 3840, height: 2160, weight: 3 },
  { width: 2560, height: 1600, weight: 2 },
  { width: 1680, height: 1050, weight: 2 },
  { width: 3440, height: 1440, weight: 2 },
  { width: 1360, height: 768, weight: 1 },
];

const WEBGL_CONFIGS: Record<string, { vendor: string; renderer: string; weight: number }[]> = {
  windows: [
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)', weight: 15 },
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)', weight: 10 },
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', weight: 10 },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB Direct3D11 vs_5_0 ps_5_0, D3D11)', weight: 8 },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', weight: 10 },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)', weight: 7 },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)', weight: 6 },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6600 XT Direct3D11 vs_5_0 ps_5_0, D3D11)', weight: 5 },
  ],
  macos: [
    { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)', weight: 20 },
    { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)', weight: 15 },
    { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)', weight: 15 },
    { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)', weight: 10 },
    { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)', weight: 12 },
    { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)', weight: 8 },
  ],
  linux: [
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)', weight: 15 },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650/PCIe/SSE2, OpenGL 4.6)', weight: 10 },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 (POLARIS10), OpenGL 4.6)', weight: 10 },
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Mesa Intel(R) Xe Graphics (TGL GT2), OpenGL 4.6)', weight: 8 },
  ],
};

const TIMEZONES = [
  { tz: 'America/New_York', offset: 300, weight: 15 },
  { tz: 'America/Chicago', offset: 360, weight: 10 },
  { tz: 'America/Denver', offset: 420, weight: 5 },
  { tz: 'America/Los_Angeles', offset: 480, weight: 12 },
  { tz: 'Europe/London', offset: 0, weight: 10 },
  { tz: 'Europe/Paris', offset: -60, weight: 8 },
  { tz: 'Europe/Berlin', offset: -60, weight: 7 },
  { tz: 'Europe/Moscow', offset: -180, weight: 5 },
  { tz: 'Asia/Tokyo', offset: -540, weight: 5 },
  { tz: 'Asia/Shanghai', offset: -480, weight: 5 },
  { tz: 'Asia/Kolkata', offset: -330, weight: 4 },
  { tz: 'Asia/Singapore', offset: -480, weight: 3 },
  { tz: 'Australia/Sydney', offset: -600, weight: 3 },
  { tz: 'America/Sao_Paulo', offset: 180, weight: 4 },
  { tz: 'America/Toronto', offset: 300, weight: 4 },
];

const LANGUAGE_SETS = [
  { primary: 'en-US', languages: ['en-US', 'en'], weight: 35 },
  { primary: 'en-GB', languages: ['en-GB', 'en'], weight: 8 },
  { primary: 'fr-FR', languages: ['fr-FR', 'fr', 'en-US', 'en'], weight: 7 },
  { primary: 'de-DE', languages: ['de-DE', 'de', 'en-US', 'en'], weight: 6 },
  { primary: 'es-ES', languages: ['es-ES', 'es', 'en-US', 'en'], weight: 6 },
  { primary: 'pt-BR', languages: ['pt-BR', 'pt', 'en-US', 'en'], weight: 5 },
  { primary: 'it-IT', languages: ['it-IT', 'it', 'en-US', 'en'], weight: 3 },
  { primary: 'ja-JP', languages: ['ja-JP', 'ja', 'en-US', 'en'], weight: 3 },
  { primary: 'zh-CN', languages: ['zh-CN', 'zh', 'en-US', 'en'], weight: 3 },
  { primary: 'ko-KR', languages: ['ko-KR', 'ko', 'en-US', 'en'], weight: 2 },
  { primary: 'ru-RU', languages: ['ru-RU', 'ru', 'en-US', 'en'], weight: 3 },
  { primary: 'nl-NL', languages: ['nl-NL', 'nl', 'en-US', 'en'], weight: 2 },
];

const HARDWARE_CONFIGS = [
  { cores: 2, memory: 4, weight: 5 },
  { cores: 4, memory: 8, weight: 20 },
  { cores: 4, memory: 16, weight: 10 },
  { cores: 6, memory: 8, weight: 8 },
  { cores: 6, memory: 16, weight: 10 },
  { cores: 8, memory: 8, weight: 5 },
  { cores: 8, memory: 16, weight: 15 },
  { cores: 8, memory: 32, weight: 5 },
  { cores: 12, memory: 16, weight: 5 },
  { cores: 12, memory: 32, weight: 3 },
  { cores: 16, memory: 16, weight: 3 },
  { cores: 16, memory: 32, weight: 2 },
];

const OS_OPTIONS: { os: 'windows' | 'macos' | 'linux'; weight: number }[] = [
  { os: 'windows', weight: 70 },
  { os: 'macos', weight: 22 },
  { os: 'linux', weight: 8 },
];

// System fonts per OS — a realistic superset; each profile gets a random subset
const SYSTEM_FONTS: Record<string, string[]> = {
  windows: [
    'Arial', 'Arial Black', 'Calibri', 'Cambria', 'Cambria Math', 'Candara',
    'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New',
    'Ebrima', 'Franklin Gothic Medium', 'Gabriola', 'Gadugi', 'Georgia',
    'Impact', 'Ink Free', 'Javanese Text', 'Leelawadee UI', 'Lucida Console',
    'Lucida Sans Unicode', 'Malgun Gothic', 'Microsoft Himalaya', 'Microsoft JhengHei',
    'Microsoft New Tai Lue', 'Microsoft PhagsPa', 'Microsoft Sans Serif',
    'Microsoft Tai Le', 'Microsoft YaHei', 'Microsoft Yi Baiti', 'MingLiU-ExtB',
    'Mongolian Baiti', 'MS Gothic', 'MV Boli', 'Myanmar Text', 'Nirmala UI',
    'Palatino Linotype', 'Segoe MDL2 Assets', 'Segoe Print', 'Segoe Script',
    'Segoe UI', 'Segoe UI Historic', 'Segoe UI Symbol', 'SimSun',
    'Sitka Text', 'Sylfaen', 'Symbol', 'Tahoma', 'Times New Roman',
    'Trebuchet MS', 'Verdana', 'Webdings', 'Wingdings', 'Yu Gothic',
  ],
  macos: [
    'Arial', 'Arial Black', 'American Typewriter', 'Avenir', 'Avenir Next',
    'Baskerville', 'Big Caslon', 'Brush Script MT', 'Chalkboard', 'Chalkboard SE',
    'Charter', 'Cochin', 'Comic Sans MS', 'Copperplate', 'Courier', 'Courier New',
    'Didot', 'Futura', 'Geneva', 'Georgia', 'Gill Sans', 'Helvetica',
    'Helvetica Neue', 'Herculanum', 'Hoefler Text', 'Impact', 'Lucida Grande',
    'Luminari', 'Marker Felt', 'Menlo', 'Monaco', 'Noteworthy', 'Optima',
    'Palatino', 'Papyrus', 'Phosphate', 'Rockwell', 'Savoye LET',
    'SignPainter', 'Skia', 'Snell Roundhand', 'STIXGeneral', 'Tahoma',
    'Times', 'Times New Roman', 'Trattatello', 'Trebuchet MS', 'Verdana',
    'Zapfino',
  ],
  linux: [
    'Arial', 'Cantarell', 'Comic Sans MS', 'Courier New', 'DejaVu Sans',
    'DejaVu Sans Mono', 'DejaVu Serif', 'Droid Sans', 'Droid Serif',
    'FreeMono', 'FreeSans', 'FreeSerif', 'Georgia', 'Impact',
    'Liberation Mono', 'Liberation Sans', 'Liberation Serif', 'Linux Biolinum',
    'Linux Libertine', 'Noto Sans', 'Noto Serif', 'Open Sans', 'Roboto',
    'Times New Roman', 'Trebuchet MS', 'Ubuntu', 'Ubuntu Mono', 'Verdana',
  ],
};

function randomizeFonts(os: string): string[] {
  const allFonts = SYSTEM_FONTS[os] || SYSTEM_FONTS.windows;
  // Keep 70-90% of fonts, randomly remove some to create a unique font fingerprint
  const keepRatio = 0.7 + Math.random() * 0.2;
  const shuffled = [...allFonts].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.floor(allFonts.length * keepRatio)).sort();
}

// --- Helper functions ---

function weightedRandom<T extends { weight: number }>(items: T[]): T {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  let random = Math.random() * totalWeight;
  for (const item of items) {
    random -= item.weight;
    if (random <= 0) return item;
  }
  return items[items.length - 1];
}

function getOSPlatform(os: string): string {
  switch (os) {
    case 'windows': return 'Win32';
    case 'macos': return 'MacIntel';
    case 'linux': return 'Linux x86_64';
    default: return 'Win32';
  }
}

function getAvailDimensions(width: number, height: number, os: string): { availWidth: number; availHeight: number } {
  const taskbarHeight = os === 'macos' ? 25 : os === 'linux' ? 27 : 40;
  return {
    availWidth: width,
    availHeight: height - taskbarHeight,
  };
}

function getDevicePixelRatio(width: number): number {
  if (width >= 3840) return 2;
  if (width >= 2560) return Math.random() < 0.4 ? 2 : 1;
  return 1;
}

// --- Country → timezone/language mapping ---

const GEO_PROFILES: Record<string, { timezones: { tz: string; offset: number; weight: number }[]; languages: { primary: string; languages: string[]; weight: number }[] }> = {
  US: {
    timezones: [
      { tz: 'America/New_York', offset: 300, weight: 30 },
      { tz: 'America/Chicago', offset: 360, weight: 20 },
      { tz: 'America/Denver', offset: 420, weight: 10 },
      { tz: 'America/Los_Angeles', offset: 480, weight: 25 },
    ],
    languages: [{ primary: 'en-US', languages: ['en-US', 'en'], weight: 100 }],
  },
  GB: {
    timezones: [{ tz: 'Europe/London', offset: 0, weight: 100 }],
    languages: [{ primary: 'en-GB', languages: ['en-GB', 'en'], weight: 100 }],
  },
  FR: {
    timezones: [{ tz: 'Europe/Paris', offset: -60, weight: 100 }],
    languages: [{ primary: 'fr-FR', languages: ['fr-FR', 'fr', 'en-US', 'en'], weight: 100 }],
  },
  DE: {
    timezones: [{ tz: 'Europe/Berlin', offset: -60, weight: 100 }],
    languages: [{ primary: 'de-DE', languages: ['de-DE', 'de', 'en-US', 'en'], weight: 100 }],
  },
  ES: {
    timezones: [{ tz: 'Europe/Madrid', offset: -60, weight: 100 }],
    languages: [{ primary: 'es-ES', languages: ['es-ES', 'es', 'en-US', 'en'], weight: 100 }],
  },
  IT: {
    timezones: [{ tz: 'Europe/Rome', offset: -60, weight: 100 }],
    languages: [{ primary: 'it-IT', languages: ['it-IT', 'it', 'en-US', 'en'], weight: 100 }],
  },
  NL: {
    timezones: [{ tz: 'Europe/Amsterdam', offset: -60, weight: 100 }],
    languages: [{ primary: 'nl-NL', languages: ['nl-NL', 'nl', 'en-US', 'en'], weight: 100 }],
  },
  BR: {
    timezones: [{ tz: 'America/Sao_Paulo', offset: 180, weight: 100 }],
    languages: [{ primary: 'pt-BR', languages: ['pt-BR', 'pt', 'en-US', 'en'], weight: 100 }],
  },
  CA: {
    timezones: [
      { tz: 'America/Toronto', offset: 300, weight: 50 },
      { tz: 'America/Vancouver', offset: 480, weight: 30 },
    ],
    languages: [
      { primary: 'en-US', languages: ['en-US', 'en', 'fr'], weight: 70 },
      { primary: 'fr-CA', languages: ['fr-CA', 'fr', 'en-US', 'en'], weight: 30 },
    ],
  },
  JP: {
    timezones: [{ tz: 'Asia/Tokyo', offset: -540, weight: 100 }],
    languages: [{ primary: 'ja-JP', languages: ['ja-JP', 'ja', 'en-US', 'en'], weight: 100 }],
  },
  RU: {
    timezones: [{ tz: 'Europe/Moscow', offset: -180, weight: 100 }],
    languages: [{ primary: 'ru-RU', languages: ['ru-RU', 'ru', 'en-US', 'en'], weight: 100 }],
  },
  AU: {
    timezones: [{ tz: 'Australia/Sydney', offset: -600, weight: 100 }],
    languages: [{ primary: 'en-AU', languages: ['en-AU', 'en'], weight: 100 }],
  },
  IN: {
    timezones: [{ tz: 'Asia/Kolkata', offset: -330, weight: 100 }],
    languages: [{ primary: 'en-IN', languages: ['en-IN', 'en', 'hi'], weight: 100 }],
  },
  CN: {
    timezones: [{ tz: 'Asia/Shanghai', offset: -480, weight: 100 }],
    languages: [{ primary: 'zh-CN', languages: ['zh-CN', 'zh', 'en-US', 'en'], weight: 100 }],
  },
  KR: {
    timezones: [{ tz: 'Asia/Seoul', offset: -540, weight: 100 }],
    languages: [{ primary: 'ko-KR', languages: ['ko-KR', 'ko', 'en-US', 'en'], weight: 100 }],
  },
  SG: {
    timezones: [{ tz: 'Asia/Singapore', offset: -480, weight: 100 }],
    languages: [{ primary: 'en-SG', languages: ['en-SG', 'en', 'zh'], weight: 100 }],
  },
};

// --- GeoIP lookup ---

export async function getCountryFromIP(proxyHost?: string, proxyPort?: number, proxyType?: string): Promise<string | null> {
  if (!proxyHost) return null;

  return new Promise((resolve) => {
    const http = require('http');
    const https = require('https');

    const url = 'http://ip-api.com/json/?fields=countryCode';
    const timeout = setTimeout(() => resolve(null), 5000);

    try {
      if (proxyType === 'socks5' || proxyType === 'socks4') {
        // For SOCKS proxies, skip GeoIP (would need a SOCKS agent)
        clearTimeout(timeout);
        resolve(null);
        return;
      }

      // For HTTP/HTTPS proxies, make request through proxy
      const proxyUrl = `http://${proxyHost}:${proxyPort}`;
      const { URL } = require('url');
      const parsedProxy = new URL(proxyUrl);

      const options = {
        hostname: parsedProxy.hostname,
        port: parsedProxy.port,
        path: url,
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0' },
      };

      const req = http.request(options, (res: any) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          clearTimeout(timeout);
          try {
            const json = JSON.parse(data);
            resolve(json.countryCode || null);
          } catch {
            resolve(null);
          }
        });
      });
      req.on('error', () => { clearTimeout(timeout); resolve(null); });
      req.end();
    } catch {
      clearTimeout(timeout);
      resolve(null);
    }
  });
}

// --- Main generator ---

export function generateFingerprint(
  requestedOS?: 'windows' | 'macos' | 'linux',
  _browserType?: 'chrome',
  countryCode?: string
): GeneratedFingerprint {
  // Select OS
  const os = requestedOS || weightedRandom(OS_OPTIONS).os;

  // Chrome version & user agent
  const chromeVersion = weightedRandom(CHROME_VERSIONS).version;
  const userAgent = UA_TEMPLATES[os].replace('{VERSION}', chromeVersion);

  // Screen
  const screen = weightedRandom(SCREEN_RESOLUTIONS);
  const { availWidth, availHeight } = getAvailDimensions(screen.width, screen.height, os);
  const devicePixelRatio = getDevicePixelRatio(screen.width);
  const colorDepth = screen.width >= 3840 ? 30 : 24;

  // Hardware
  const hw = weightedRandom(HARDWARE_CONFIGS);

  // WebGL
  const webglConfigs = WEBGL_CONFIGS[os] || WEBGL_CONFIGS.windows;
  const webgl = weightedRandom(webglConfigs);

  // Timezone & Language — always pick from a coherent country profile
  // This prevents mismatches like America/Chicago + ja-JP
  let tz: { tz: string; offset: number };
  let lang: { primary: string; languages: string[] };

  const geoCountry = countryCode ? countryCode.toUpperCase() : null;
  const geo = geoCountry ? GEO_PROFILES[geoCountry] : null;
  if (geo) {
    tz = weightedRandom(geo.timezones);
    lang = weightedRandom(geo.languages);
  } else {
    // No country specified — pick a random country, then use its timezone+language
    const countryKeys = Object.keys(GEO_PROFILES);
    const countryWeights = [
      { key: 'US', weight: 35 }, { key: 'GB', weight: 10 }, { key: 'CA', weight: 8 },
      { key: 'FR', weight: 7 }, { key: 'DE', weight: 7 }, { key: 'AU', weight: 5 },
      { key: 'BR', weight: 5 }, { key: 'ES', weight: 4 }, { key: 'IT', weight: 3 },
      { key: 'NL', weight: 3 }, { key: 'JP', weight: 3 }, { key: 'KR', weight: 2 },
      { key: 'IN', weight: 3 }, { key: 'RU', weight: 2 }, { key: 'SG', weight: 2 },
      { key: 'CN', weight: 1 },
    ];
    const randomCountry = weightedRandom(countryWeights);
    const randomGeo = GEO_PROFILES[randomCountry.key];
    tz = weightedRandom(randomGeo.timezones);
    lang = weightedRandom(randomGeo.languages);
  }

  // Seeds for stable noise
  const canvasNoiseSeed = Math.floor(Math.random() * 999999999) + 1;
  const audioNoiseSeed = Math.floor(Math.random() * 999999999) + 1;

  return {
    userAgent,
    os,
    browserType: 'chrome',
    chromeVersion,
    timezone: tz.tz,
    timezoneOffset: tz.offset,
    language: lang.primary,
    languages: lang.languages,
    screenResolution: `${screen.width}x${screen.height}`,
    screenWidth: screen.width,
    screenHeight: screen.height,
    availWidth,
    availHeight,
    colorDepth,
    pixelDepth: colorDepth,
    devicePixelRatio,
    hardwareConcurrency: hw.cores,
    deviceMemory: hw.memory,
    maxTouchPoints: 0,
    webglVendor: webgl.vendor,
    webglRenderer: webgl.renderer,
    canvasNoiseSeed,
    audioNoiseSeed,
    canvasNoise: true,
    audioNoise: true,
    webrtcMode: 'disabled',
    doNotTrack: false,
    platform: getOSPlatform(os),
    vendor: 'Google Inc.',
    fonts: randomizeFonts(os),
  };
}

// --- Override timezone/language from country code ---

export function overrideFingerprintGeo(fp: any, countryCode: string): any {
  const geo = GEO_PROFILES[countryCode.toUpperCase()];
  if (!geo) return fp;

  const tz = weightedRandom(geo.timezones);
  const lang = weightedRandom(geo.languages);

  return {
    ...fp,
    timezone: tz.tz,
    timezoneOffset: tz.offset,
    language: lang.primary,
    languages: lang.languages,
  };
}
