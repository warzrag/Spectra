export interface BrowserFingerprint {
    userAgent: string;
    platform: string;
    hardwareConcurrency: number;
    deviceMemory: number;
    screenResolution: string;
    availableScreenResolution: string;
    colorDepth: number;
    pixelRatio: number;
    timezone: string;
    language: string;
    languages: string[];
    webglVendor: string;
    webglRenderer: string;
    canvas: CanvasFingerprint;
    audioContext: AudioFingerprint;
    fonts: string[];
    plugins: PluginData[];
    webrtc: WebRTCFingerprint;
    battery?: BatteryFingerprint;
    connection?: ConnectionFingerprint;
}
interface CanvasFingerprint {
    dataURL: string;
    hash: string;
    noise: number;
}
interface AudioFingerprint {
    sampleRate: number;
    channelCount: number;
    oscillatorType: string;
    dynamicsCompressorFingerprint: string;
}
interface PluginData {
    name: string;
    filename: string;
    description: string;
}
interface WebRTCFingerprint {
    publicIP?: string;
    localIPs: string[];
    stunServers: string[];
    mode: 'real' | 'fake' | 'disabled';
}
interface BatteryFingerprint {
    charging: boolean;
    level: number;
    chargingTime: number;
    dischargingTime: number;
}
interface ConnectionFingerprint {
    effectiveType: string;
    rtt: number;
    downlink: number;
    saveData: boolean;
}
export declare class FingerprintGenerator {
    private static userAgents;
    private static webglVendors;
    private static webglRenderers;
    private static fonts;
    private static resolutions;
    static generateFingerprint(options?: Partial<BrowserFingerprint>): BrowserFingerprint;
    private static getPlatform;
    private static getPixelRatio;
    private static getAvailableResolution;
    private static getWebGLRenderer;
    private static generateCanvasFingerprint;
    private static generateAudioFingerprint;
    private static getRandomFonts;
    private static generatePlugins;
    private static generateWebRTCFingerprint;
    private static generateBatteryFingerprint;
    private static generateConnectionFingerprint;
    private static getRandomElement;
    private static getRandomInt;
    private static generateRandomBase64;
    private static generateRandomHash;
    static validateFingerprint(fingerprint: BrowserFingerprint): boolean;
    static calculateSimilarity(fp1: BrowserFingerprint, fp2: BrowserFingerprint): number;
    private static calculateArraySimilarity;
}
export default FingerprintGenerator;
//# sourceMappingURL=fingerprint-generator.d.ts.map