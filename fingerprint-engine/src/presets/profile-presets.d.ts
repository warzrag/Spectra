import { BrowserFingerprint } from '../generators/fingerprint-generator';
export interface ProfilePreset {
    name: string;
    description: string;
    category: 'social-media' | 'e-commerce' | 'crypto' | 'general';
    fingerprint: Partial<BrowserFingerprint>;
    recommendedProxy?: {
        type: 'residential' | 'mobile' | 'datacenter';
        location?: string;
    };
}
export declare class ProfilePresets {
    private static presets;
    static getAll(): ProfilePreset[];
    static getByCategory(category: ProfilePreset['category']): ProfilePreset[];
    static getByName(name: string): ProfilePreset | undefined;
    static addCustomPreset(preset: ProfilePreset): void;
    static removePreset(name: string): boolean;
    static exportPresets(): string;
    static importPresets(json: string): boolean;
}
//# sourceMappingURL=profile-presets.d.ts.map