import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { SessionManager } from './session-manager';
import ProxyManager from './proxy-manager';
import { ProfilePreferences } from './profile-preferences';

export interface ChromeLaunchOptions {
  profileId: string;
  profileName: string;
  userAgent?: string;
  proxy?: string;
  fingerprint?: any;
  lastUrl?: string;
}

const isDev = process.env.NODE_ENV !== 'production';

export class ChromeLauncher {
  private static processes = new Map<string, any>();
  private static activeUrls = new Map<string, string>();
  private static activeProfiles = new Set<string>();

  static isProfileActive(profileId: string): boolean {
    return this.activeProfiles.has(profileId);
  }

  static getActiveProfiles(): string[] {
    return Array.from(this.activeProfiles);
  }

  static async launch(options: ChromeLaunchOptions) {
    console.log('ChromeLauncher.launch called with:', options);
    
    // Check if profile is already running
    if (this.isProfileActive(options.profileId)) {
      console.log('Profile is already running:', options.profileId);
      
      // Try to focus the existing window (Windows-specific)
      const existingProcess = this.processes.get(options.profileId);
      if (existingProcess && os.platform() === 'win32') {
        try {
          // Use PowerShell to bring Chrome window to front
          const focusCommand = `
            $chrome = Get-Process chrome | Where-Object {$_.Id -eq ${existingProcess.pid}}
            if ($chrome) {
              Add-Type @"
                using System;
                using System.Runtime.InteropServices;
                public class Win32 {
                  [DllImport("user32.dll")]
                  public static extern bool SetForegroundWindow(IntPtr hWnd);
                  [DllImport("user32.dll")]
                  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
                }
"@
              $chrome.MainWindowHandle | ForEach-Object {
                [Win32]::ShowWindow($_, 3)
                [Win32]::SetForegroundWindow($_)
              }
            }
          `;
          spawn('powershell', ['-Command', focusCommand], { shell: true });
        } catch (error) {
          console.error('Failed to focus Chrome window:', error);
        }
      }
      
      return { success: false, error: 'Profile already running', alreadyRunning: true };
    }
    // Create profile directory
    const profilesDir = path.join(os.homedir(), '.antidetect-browser', 'profiles');
    const profilePath = path.join(profilesDir, options.profileId);
    
    if (!fs.existsSync(profilePath)) {
      fs.mkdirSync(profilePath, { recursive: true });
    }
    
    // Store the initial URL for this profile
    if (options.lastUrl) {
      this.activeUrls.set(options.profileId, options.lastUrl);
    }
    
    // Get proxy for this profile
    const proxyManager = ProxyManager.getInstance();
    const proxy = await proxyManager.getProxyForProfile(options.profileId);
    
    // Write profile config for extension to read
    const profileConfig: any = {
      profileId: options.profileId,
      profileName: options.profileName,
      lastUrl: options.lastUrl || 'https://www.google.com'
    };
    
    // Add proxy auth to config if available
    if (proxy && proxy.username && proxy.password) {
      profileConfig.proxyAuth = {
        username: proxy.username,
        password: proxy.password
      };
    }
    
    fs.writeFileSync(
      path.join(profilePath, 'antidetect-config.json'),
      JSON.stringify(profileConfig, null, 2)
    );

    // Setup Chrome preferences for session restoration
    ProfilePreferences.setupChromePreferences(profilePath, options.lastUrl);
    
    // Create Chrome session files for URL persistence (like AdsPower/GoLogin)
    if (options.lastUrl && options.lastUrl !== '') {
      try {
        await SessionManager.createSessionFile(options.profileId, options.lastUrl);
      } catch (error) {
        console.error('Failed to create session file:', error);
        // Continue launching even if session creation fails
      }
    }

    // Find Chrome executable
    const chromePath = this.findChrome();
    if (!chromePath) {
      throw new Error('Chrome not found. Please install Google Chrome.');
    }

    // Path to our extension
    const extensionPath = isDev 
      ? path.join(__dirname, '../../src/chrome-extension')
      : path.join(__dirname, '../chrome-extension');
    
    // Copy config file to extension directory for proxy auth
    const configPath = path.join(profilePath, 'antidetect-config.json');
    const targetConfigPath = path.join(extensionPath, 'antidetect-config.json');
    
    if (fs.existsSync(configPath)) {
      try {
        // Ensure target directory exists
        const targetDir = path.dirname(targetConfigPath);
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }
        
        fs.copyFileSync(configPath, targetConfigPath);
      } catch (error) {
        console.error('Failed to copy config file:', error);
        // Continue without config file
      }
    }
    
    // Build arguments — minimal flags to avoid detection
    const args = [
      `--user-data-dir=${profilePath}`,
      '--no-default-browser-check',
      '--no-first-run',
      '--restore-last-session',

      // Anti-automation detection
      '--disable-blink-features=AutomationControlled',
      '--exclude-switches=enable-automation',

      // Performance & background
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-background-timer-throttling',
      '--disable-ipc-flooding-protection',
      '--disable-client-side-phishing-detection',
      '--disable-default-apps',
      '--disable-dev-shm-usage',
      '--disable-hang-monitor',

      // Disable sync & promos
      '--disable-sync',
      '--disable-signin-promo',
      '--disable-sync-promos',
      '--no-service-autorun',

      // UI
      '--disable-infobars',
      '--disable-popup-blocking',
    ];
    
    // Don't load the tracking extension as it can be detected
    // console.log('Extension path:', extensionPath);
    // if (fs.existsSync(extensionPath)) {
    //   console.log('Loading extension from:', extensionPath);
    //   args.push(`--load-extension=${extensionPath}`);
    // } else {
    //   console.warn('Extension path does not exist:', extensionPath);
    // }

    // Add user agent - match the actual OS with recent Chrome version
    const defaultUserAgent = process.platform === 'darwin'
      ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    args.push(`--user-agent="${options.userAgent || defaultUserAgent}"`);

    // Add proxy if available
    if (proxy) {
      const formattedProxy = proxyManager.formatProviderProxy(proxy);
      const proxyString = proxyManager.getProxyString(formattedProxy);
      args.push(`--proxy-server=${proxyString}`);
      console.log('Using proxy:', proxyString);
    } else if (options.proxy) {
      // Fallback to legacy proxy option
      args.push(`--proxy-server=${options.proxy}`);
    }

    // Add startup URL if we have one, otherwise Chrome will use session restoration
    if (options.lastUrl && options.lastUrl !== 'https://www.google.com') {
      args.push(options.lastUrl);
      console.log('Chrome launcher - Starting with URL:', options.lastUrl);
    } else {
      // Check if profile has existing session files
      const hasSessionFiles = fs.existsSync(path.join(profilePath, 'Default', 'Current Session')) ||
                             fs.existsSync(path.join(profilePath, 'Default', 'Last Session'));
      
      if (!hasSessionFiles && options.lastUrl) {
        // No session files, provide initial URL
        args.push(options.lastUrl);
        console.log('Chrome launcher - No session files found, using:', options.lastUrl);
      } else {
        console.log('Chrome launcher - Using session restoration');
      }
    }

    // Log all arguments for debugging
    console.log('Launching Chrome with args:', args);
    
    // Launch Chrome
    const chromeProcess = spawn(chromePath, args, {
      detached: true,
      stdio: 'ignore'
    });

    // Store process reference
    this.processes.set(options.profileId, chromeProcess);
    this.activeProfiles.add(options.profileId);

    // Monitor process to detect when it closes
    chromeProcess.on('exit', () => {
      console.log(`Chrome process for profile ${options.profileId} has exited`);
      this.processes.delete(options.profileId);
      this.activeProfiles.delete(options.profileId);
      this.activeUrls.delete(options.profileId);
    });

    // Unref the process so node can exit
    chromeProcess.unref();

    return { success: true, pid: chromeProcess.pid, alreadyRunning: false };
  }

  static close(profileId: string) {
    const process = this.processes.get(profileId);
    if (process) {
      try {
        // Kill the process tree
        if (os.platform() === 'win32') {
          spawn('taskkill', ['/pid', process.pid.toString(), '/T', '/F']);
        } else {
          process.kill('SIGTERM');
        }
        this.processes.delete(profileId);
        this.activeProfiles.delete(profileId);
        this.activeUrls.delete(profileId);
        return true;
      } catch (error) {
        console.error('Error closing Chrome:', error);
        return false;
      }
    }
    return false;
  }

  private static findChrome(): string | null {
    const platform = os.platform();
    
    if (platform === 'win32') {
      const paths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
      ];
      
      for (const chromePath of paths) {
        if (fs.existsSync(chromePath)) {
          return chromePath;
        }
      }
    } else if (platform === 'darwin') {
      const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      if (fs.existsSync(chromePath)) {
        return chromePath;
      }
    } else {
      // Linux - including WSL
      const paths = [
        // WSL paths to Windows Chrome
        '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
        '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        '/mnt/d/Program Files/Google/Chrome/Application/chrome.exe',
        '/mnt/d/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        // Standard Linux paths
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
      ];
      
      for (const chromePath of paths) {
        if (fs.existsSync(chromePath)) {
          console.log('Found Chrome at:', chromePath);
          return chromePath;
        }
      }
    }
    
    console.error('Chrome not found. Searched paths:', this.getSearchPaths());
    return null;
  }
  
  private static getSearchPaths(): string[] {
    const platform = os.platform();
    if (platform === 'linux') {
      return [
        '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
        '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
      ];
    }
    return [];
  }
}