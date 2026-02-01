"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProfilePresets = void 0;
class ProfilePresets {
    static getAll() {
        return [...this.presets];
    }
    static getByCategory(category) {
        return this.presets.filter(preset => preset.category === category);
    }
    static getByName(name) {
        return this.presets.find(preset => preset.name === name);
    }
    static addCustomPreset(preset) {
        this.presets.push(preset);
    }
    static removePreset(name) {
        const index = this.presets.findIndex(preset => preset.name === name);
        if (index !== -1) {
            this.presets.splice(index, 1);
            return true;
        }
        return false;
    }
    static exportPresets() {
        return JSON.stringify(this.presets, null, 2);
    }
    static importPresets(json) {
        try {
            const imported = JSON.parse(json);
            if (Array.isArray(imported)) {
                this.presets = imported;
                return true;
            }
            return false;
        }
        catch {
            return false;
        }
    }
}
exports.ProfilePresets = ProfilePresets;
ProfilePresets.presets = [
    {
        name: 'Facebook Ads Manager',
        description: 'Optimized for Facebook advertising accounts',
        category: 'social-media',
        fingerprint: {
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            platform: 'Win32',
            screenResolution: '1920x1080',
            timezone: 'America/New_York',
            language: 'en-US',
            languages: ['en-US', 'en']
        },
        recommendedProxy: {
            type: 'residential',
            location: 'US'
        }
    },
    {
        name: 'Instagram Business',
        description: 'Ideal for Instagram business account management',
        category: 'social-media',
        fingerprint: {
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            platform: 'MacIntel',
            screenResolution: '1440x900',
            timezone: 'America/Los_Angeles',
            language: 'en-US'
        },
        recommendedProxy: {
            type: 'mobile'
        }
    },
    {
        name: 'Amazon Seller',
        description: 'Configured for Amazon seller account management',
        category: 'e-commerce',
        fingerprint: {
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            platform: 'Win32',
            screenResolution: '1920x1080',
            colorDepth: 24,
            hardwareConcurrency: 8,
            deviceMemory: 8
        },
        recommendedProxy: {
            type: 'residential',
            location: 'US'
        }
    },
    {
        name: 'eBay Power Seller',
        description: 'Optimized for eBay seller accounts',
        category: 'e-commerce',
        fingerprint: {
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
            platform: 'Win32',
            screenResolution: '1366x768',
            timezone: 'America/Chicago'
        },
        recommendedProxy: {
            type: 'residential'
        }
    },
    {
        name: 'Crypto Trading',
        description: 'Secure profile for cryptocurrency exchanges',
        category: 'crypto',
        fingerprint: {
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            platform: 'Linux x86_64',
            screenResolution: '1920x1080',
            hardwareConcurrency: 16,
            deviceMemory: 16,
            webrtc: {
                mode: 'disabled',
                localIPs: [],
                stunServers: []
            }
        },
        recommendedProxy: {
            type: 'residential',
            location: 'CH'
        }
    },
    {
        name: 'Google Ads',
        description: 'Profile for Google Ads account management',
        category: 'social-media',
        fingerprint: {
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            platform: 'Win32',
            screenResolution: '1920x1080',
            timezone: 'America/New_York',
            language: 'en-US'
        },
        recommendedProxy: {
            type: 'datacenter',
            location: 'US'
        }
    },
    {
        name: 'TikTok Creator',
        description: 'Optimized for TikTok content creation',
        category: 'social-media',
        fingerprint: {
            userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
            platform: 'iPhone',
            screenResolution: '375x812',
            pixelRatio: 3,
            timezone: 'America/Los_Angeles',
            language: 'en-US'
        },
        recommendedProxy: {
            type: 'mobile',
            location: 'US'
        }
    },
    {
        name: 'LinkedIn Business',
        description: 'Professional profile for LinkedIn automation',
        category: 'social-media',
        fingerprint: {
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            platform: 'Win32',
            screenResolution: '1920x1080',
            timezone: 'America/New_York',
            language: 'en-US',
            hardwareConcurrency: 8
        },
        recommendedProxy: {
            type: 'residential',
            location: 'US'
        }
    },
    {
        name: 'Shopify Store Manager',
        description: 'E-commerce profile for Shopify management',
        category: 'e-commerce',
        fingerprint: {
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
            platform: 'MacIntel',
            screenResolution: '1512x982',
            timezone: 'America/Toronto',
            language: 'en-CA'
        },
        recommendedProxy: {
            type: 'residential',
            location: 'CA'
        }
    },
    {
        name: 'General Browsing',
        description: 'Standard profile for general web browsing',
        category: 'general',
        fingerprint: {
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            platform: 'Win32',
            screenResolution: '1920x1080',
            timezone: 'UTC',
            language: 'en-US'
        }
    }
];
//# sourceMappingURL=profile-presets.js.map