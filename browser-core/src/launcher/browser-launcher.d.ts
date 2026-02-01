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
export declare class BrowserLauncher {
    private sessions;
    private profilesDir;
    constructor(profilesDir?: string);
    launch(options: LaunchOptions): Promise<BrowserSession>;
    private buildChromeArgs;
    private setupProxy;
    private injectFingerprint;
    private getWSEndpoint;
    close(profileId: string): Promise<boolean>;
    closeAll(): Promise<void>;
    getSession(profileId: string): BrowserSession | undefined;
    getAllSessions(): BrowserSession[];
}
//# sourceMappingURL=browser-launcher.d.ts.map