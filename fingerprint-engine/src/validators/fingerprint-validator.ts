import { BrowserFingerprint } from '../generators/fingerprint-generator';
import UAParser from 'ua-parser-js';

export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  score: number;
}

export interface ValidationError {
  field: string;
  message: string;
  severity: 'error';
}

export interface ValidationWarning {
  field: string;
  message: string;
  severity: 'warning';
}

export class FingerprintValidator {
  static validate(fingerprint: BrowserFingerprint): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];
    let score = 100;

    // Validate User Agent
    const uaValidation = this.validateUserAgent(fingerprint.userAgent, fingerprint.platform);
    errors.push(...uaValidation.errors);
    warnings.push(...uaValidation.warnings);
    score -= uaValidation.errors.length * 10;
    score -= uaValidation.warnings.length * 5;

    // Validate Screen Resolution
    const resolutionValidation = this.validateScreenResolution(
      fingerprint.screenResolution,
      fingerprint.availableScreenResolution
    );
    errors.push(...resolutionValidation.errors);
    warnings.push(...resolutionValidation.warnings);
    score -= resolutionValidation.errors.length * 10;
    score -= resolutionValidation.warnings.length * 5;

    // Validate Hardware
    const hardwareValidation = this.validateHardware(
      fingerprint.hardwareConcurrency,
      fingerprint.deviceMemory
    );
    warnings.push(...hardwareValidation.warnings);
    score -= hardwareValidation.warnings.length * 3;

    // Validate WebGL
    const webglValidation = this.validateWebGL(
      fingerprint.webglVendor,
      fingerprint.webglRenderer,
      fingerprint.platform
    );
    errors.push(...webglValidation.errors);
    warnings.push(...webglValidation.warnings);
    score -= webglValidation.errors.length * 8;
    score -= webglValidation.warnings.length * 4;

    // Validate Languages
    const langValidation = this.validateLanguages(
      fingerprint.language,
      fingerprint.languages
    );
    errors.push(...langValidation.errors);
    score -= langValidation.errors.length * 5;

    // Validate WebRTC
    const webrtcValidation = this.validateWebRTC(fingerprint.webrtc);
    warnings.push(...webrtcValidation.warnings);
    score -= webrtcValidation.warnings.length * 3;

    // Calculate final score
    score = Math.max(0, score);

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      score
    };
  }

  private static validateUserAgent(
    userAgent: string,
    platform: string
  ): { errors: ValidationError[]; warnings: ValidationWarning[] } {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    if (!userAgent || userAgent.trim().length === 0) {
      errors.push({
        field: 'userAgent',
        message: 'User agent cannot be empty',
        severity: 'error'
      });
      return { errors, warnings };
    }

    const parser = new UAParser(userAgent);
    const uaResult = parser.getResult();

    // Check platform consistency
    if (platform === 'Win32' && !userAgent.includes('Windows')) {
      errors.push({
        field: 'userAgent',
        message: 'User agent does not match Windows platform',
        severity: 'error'
      });
    } else if (platform === 'MacIntel' && !userAgent.includes('Mac')) {
      errors.push({
        field: 'userAgent',
        message: 'User agent does not match Mac platform',
        severity: 'error'
      });
    } else if (platform.includes('Linux') && !userAgent.includes('Linux')) {
      errors.push({
        field: 'userAgent',
        message: 'User agent does not match Linux platform',
        severity: 'error'
      });
    }

    // Check for outdated browsers
    if (uaResult.browser.name === 'Chrome') {
      const version = parseInt(uaResult.browser.version?.split('.')[0] || '0');
      if (version < 100) {
        warnings.push({
          field: 'userAgent',
          message: 'Chrome version is outdated (< 100)',
          severity: 'warning'
        });
      }
    }

    return { errors, warnings };
  }

  private static validateScreenResolution(
    screenRes: string,
    availableRes: string
  ): { errors: ValidationError[]; warnings: ValidationWarning[] } {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    const screenMatch = screenRes.match(/^(\d+)x(\d+)$/);
    const availMatch = availableRes.match(/^(\d+)x(\d+)$/);

    if (!screenMatch || !availMatch) {
      errors.push({
        field: 'screenResolution',
        message: 'Invalid resolution format',
        severity: 'error'
      });
      return { errors, warnings };
    }

    const [, screenWidth, screenHeight] = screenMatch;
    const [, availWidth, availHeight] = availMatch;

    if (parseInt(availWidth) > parseInt(screenWidth) || 
        parseInt(availHeight) > parseInt(screenHeight)) {
      errors.push({
        field: 'availableScreenResolution',
        message: 'Available resolution cannot exceed screen resolution',
        severity: 'error'
      });
    }

    // Check for unusual resolutions
    const commonResolutions = [
      '1920x1080', '1366x768', '1440x900', '1536x864',
      '1600x900', '1280x720', '1280x800', '1920x1200',
      '2560x1440', '2560x1600', '3840x2160'
    ];

    if (!commonResolutions.includes(screenRes)) {
      warnings.push({
        field: 'screenResolution',
        message: 'Uncommon screen resolution detected',
        severity: 'warning'
      });
    }

    return { errors, warnings };
  }

  private static validateHardware(
    cores: number,
    memory: number
  ): { warnings: ValidationWarning[] } {
    const warnings: ValidationWarning[] = [];

    if (cores < 2 || cores > 64) {
      warnings.push({
        field: 'hardwareConcurrency',
        message: `Unusual CPU core count: ${cores}`,
        severity: 'warning'
      });
    }

    if (![2, 4, 8, 16, 32, 64].includes(memory)) {
      warnings.push({
        field: 'deviceMemory',
        message: `Unusual device memory: ${memory}GB`,
        severity: 'warning'
      });
    }

    return { warnings };
  }

  private static validateWebGL(
    vendor: string,
    renderer: string,
    platform: string
  ): { errors: ValidationError[]; warnings: ValidationWarning[] } {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    if (!vendor || !renderer) {
      errors.push({
        field: 'webgl',
        message: 'WebGL vendor and renderer are required',
        severity: 'error'
      });
      return { errors, warnings };
    }

    // Platform-specific validation
    if (platform === 'MacIntel' && !vendor.includes('Apple') && !vendor.includes('Intel')) {
      warnings.push({
        field: 'webglVendor',
        message: 'WebGL vendor unusual for Mac platform',
        severity: 'warning'
      });
    }

    if (vendor.includes('Google') && !renderer.includes('ANGLE')) {
      warnings.push({
        field: 'webglRenderer',
        message: 'Google vendor typically uses ANGLE renderer',
        severity: 'warning'
      });
    }

    return { errors, warnings };
  }

  private static validateLanguages(
    language: string,
    languages: string[]
  ): { errors: ValidationError[] } {
    const errors: ValidationError[] = [];

    if (!languages.includes(language)) {
      errors.push({
        field: 'languages',
        message: 'Primary language must be in languages array',
        severity: 'error'
      });
    }

    const validLangPattern = /^[a-z]{2}(-[A-Z]{2})?$/;
    if (!validLangPattern.test(language)) {
      errors.push({
        field: 'language',
        message: 'Invalid language format (expected: en-US format)',
        severity: 'error'
      });
    }

    return { errors };
  }

  private static validateWebRTC(
    webrtc: any
  ): { warnings: ValidationWarning[] } {
    const warnings: ValidationWarning[] = [];

    if (webrtc.mode === 'real' && webrtc.publicIP) {
      warnings.push({
        field: 'webrtc',
        message: 'Real mode should not have predefined public IP',
        severity: 'warning'
      });
    }

    if (webrtc.localIPs.length > 0) {
      const ipPattern = /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/;
      for (const ip of webrtc.localIPs) {
        if (!ipPattern.test(ip)) {
          warnings.push({
            field: 'webrtc.localIPs',
            message: `Invalid private IP address: ${ip}`,
            severity: 'warning'
          });
          break;
        }
      }
    }

    return { warnings };
  }

  static calculateUniqueness(
    fingerprint: BrowserFingerprint,
    database: BrowserFingerprint[]
  ): number {
    if (database.length === 0) return 100;

    let uniqueFields = 0;
    const totalFields = 10;

    const fieldCounts = {
      userAgent: new Set(database.map(fp => fp.userAgent)),
      screenResolution: new Set(database.map(fp => fp.screenResolution)),
      timezone: new Set(database.map(fp => fp.timezone)),
      language: new Set(database.map(fp => fp.language)),
      webglVendor: new Set(database.map(fp => fp.webglVendor)),
      webglRenderer: new Set(database.map(fp => fp.webglRenderer)),
      hardwareConcurrency: new Set(database.map(fp => fp.hardwareConcurrency)),
      deviceMemory: new Set(database.map(fp => fp.deviceMemory)),
      platform: new Set(database.map(fp => fp.platform)),
      colorDepth: new Set(database.map(fp => fp.colorDepth))
    };

    if (!fieldCounts.userAgent.has(fingerprint.userAgent)) uniqueFields++;
    if (!fieldCounts.screenResolution.has(fingerprint.screenResolution)) uniqueFields++;
    if (!fieldCounts.timezone.has(fingerprint.timezone)) uniqueFields++;
    if (!fieldCounts.language.has(fingerprint.language)) uniqueFields++;
    if (!fieldCounts.webglVendor.has(fingerprint.webglVendor)) uniqueFields++;
    if (!fieldCounts.webglRenderer.has(fingerprint.webglRenderer)) uniqueFields++;
    if (!fieldCounts.hardwareConcurrency.has(fingerprint.hardwareConcurrency)) uniqueFields++;
    if (!fieldCounts.deviceMemory.has(fingerprint.deviceMemory)) uniqueFields++;
    if (!fieldCounts.platform.has(fingerprint.platform)) uniqueFields++;
    if (!fieldCounts.colorDepth.has(fingerprint.colorDepth)) uniqueFields++;

    return (uniqueFields / totalFields) * 100;
  }
}