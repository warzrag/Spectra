import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import * as net from 'net';
import * as crypto from 'crypto';
import { spawn, execFile, ChildProcess } from 'child_process';
import { install, Browser, detectBrowserPlatform } from '@puppeteer/browsers';
import { resolveVenusAutostartState } from './venus-autostart-state';
import { normalizeTweetUrl } from '../shared/twitter-url';
import { hasAuthenticatedXSession } from '../shared/x-auth-snapshot';
import {
  isManagedLaunch,
  fitWindowToWorkArea,
  resolveLaunchMode,
  shouldAppendLaunchUrl,
  shouldOpenSetupTab,
  SpectraLaunchMode,
} from '../shared/launch-policy';

// Keep the managed browser aligned with the Chrome version advertised by new profiles.
const MANAGED_CHROME_VERSION = '151.0.7922.47';

export interface PuppeteerLaunchOptions {
  profileId: string;
  profileName: string;
  launchMode?: SpectraLaunchMode;
  platform?: string;
  userAgent?: string;
  proxy?: any;
  fingerprint?: any;
  lastUrl?: string;
  connectionType?: string;
  extensionPaths?: string[];
  windowLayout?: { index: number; total: number };
  autoStartTwitterBot?: boolean;
  targetTweetUrl?: string;
  sessionImport?: { attemptId: string };
}

export class PuppeteerLauncher {
  private static activeProfiles = new Map<string, any>();
  private static pendingProfiles = new Set<string>();
  private static pendingLaunchModes = new Map<string, SpectraLaunchMode>();
  private static cancelledProfiles = new Set<string>();
  private static launchConfirmationWaiters = new Map<
    string,
    { resolve: (status: string) => void; timeout: NodeJS.Timeout }
  >();
  private static browserVersions = new Map<string, Promise<string | null>>();
  private static mainWindow: any = null;
  private static localServerConfig: { port: number; token: string } | null = null;
  private static readonly compactWindow = { width: 900, height: 720, margin: 0, gap: 0 };
  private static readonly openSelectedWindow = {
    width: 620,
    height: 520,
    margin: 8,
    gap: 8,
  };

  private static getProfilesRoot(): string {
    return process.platform === 'win32'
      ? path.join(os.homedir(), 'AppData', 'Local', 'AntidetectBrowser', 'Profiles')
      : path.join(os.homedir(), '.antidetect-browser', 'profiles');
  }

  private static appendLifecycleEvent(
    profileId: string,
    event: string,
    details: Record<string, unknown> = {}
  ): void {
    try {
      this.assertSafeId(profileId, 'profile ID');
      const profilesRoot = this.getProfilesRoot();
      const profilePath = path.join(profilesRoot, profileId);
      const logsPath = path.join(path.dirname(profilesRoot), 'Logs');
      fs.mkdirSync(profilePath, { recursive: true });
      fs.mkdirSync(logsPath, { recursive: true });
      const record = JSON.stringify({
        timestamp: new Date().toISOString(),
        profileId,
        event: String(event || 'unknown').slice(0, 96),
        details,
      }) + os.EOL;
      fs.appendFileSync(path.join(profilePath, '.spectra-lifecycle.ndjson'), record, 'utf8');
      fs.appendFileSync(path.join(logsPath, 'profile-lifecycle.ndjson'), record, 'utf8');
    } catch (error) {
      console.warn(`[Lifecycle] Could not persist ${event} for ${profileId}:`, error);
    }
  }

  static reportLifecycleEvent(payload: {
    profileId?: string;
    launchId?: string;
    event?: string;
    details?: Record<string, unknown>;
  }): void {
    const profileId = String(payload?.profileId || '');
    const event = String(payload?.event || '');
    if (!profileId || !event) return;
    const safeDetails = payload?.details && typeof payload.details === 'object'
      ? payload.details
      : {};
    this.appendLifecycleEvent(profileId, `chrome-${event}`, {
      launchId: String(payload?.launchId || '').slice(0, 96),
      ...safeDetails,
    });
  }

  private static assertSafeId(value: string, label: string): void {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(value)) {
      throw new Error(`Invalid ${label}`);
    }
  }

  private static runPowerShell(script: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error((stderr || error.message).trim()));
            return;
          }
          resolve(stdout.trim());
        }
      );
    });
  }

  private static async getBrowserVersion(executablePath: string): Promise<string | null> {
    const normalizedPath = path.resolve(executablePath);
    const managedBrowserRoot = path.join(
      os.homedir(),
      '.antidetect-browser',
      'browser',
      'chrome'
    );
    const pathVersion = normalizedPath.match(/(\d+\.\d+\.\d+\.\d+)/)?.[1];

    if (pathVersion && normalizedPath.startsWith(`${managedBrowserRoot}${path.sep}`)) {
      return pathVersion;
    }

    const cached = this.browserVersions.get(normalizedPath);
    if (cached) return cached;

    const versionPromise = (async () => {
      if (process.platform === 'win32') {
        const escapedPath = normalizedPath.replace(/'/g, "''");
        try {
          const version = await this.runPowerShell(
            `(Get-Item -LiteralPath '${escapedPath}').VersionInfo.FileVersion`
          );
          const normalized = version.match(/\d+\.\d+\.\d+\.\d+/)?.[0];
          if (normalized) return normalized;
        } catch (error) {
          console.warn('[Browser] Could not inspect executable version:', error);
        }
      }

      return pathVersion || null;
    })();

    this.browserVersions.set(normalizedPath, versionPromise);
    return versionPromise;
  }

  private static alignUserAgentToBrowser(userAgent: string, browserVersion: string | null): string {
    if (!userAgent || !browserVersion) return userAgent;

    const advertisedVersion = userAgent.match(/\bChrome\/(\d+\.\d+\.\d+\.\d+)/)?.[1];
    if (!advertisedVersion || advertisedVersion === browserVersion) return userAgent;

    console.warn(
      `[Browser] Correcting Chrome User-Agent mismatch: ${advertisedVersion} -> ${browserVersion}`
    );
    return userAgent.replace(
      /\bChrome\/\d+\.\d+\.\d+\.\d+\b/,
      `Chrome/${browserVersion}`
    );
  }

  /**
   * Chromium derives Accept-Language from the browser locale. --lang is honoured on
   * Windows but largely ignored on macOS, where the system language wins: a US profile
   * opened on a French Mac announced "fr-FR" behind a US proxy. Build the header from
   * the fingerprint so it stays identical on every host.
   */
  private static buildAcceptLanguage(fingerprint: any): string {
    const languages: string[] = Array.isArray(fingerprint?.languages) && fingerprint.languages.length
      ? fingerprint.languages
      : [fingerprint?.language || 'en-US'];

    return languages
      .filter((language: string) => typeof language === 'string' && language.length > 0)
      .map((language: string, index: number) => {
        if (index === 0) return language;
        const quality = Math.max(0.1, 1 - index * 0.1);
        return `${language};q=${quality.toFixed(1)}`;
      })
      .join(',');
  }

  /**
   * Chromium builds User-Agent Client Hints from the real OS and --user-agent does not
   * regenerate them, so a Windows-fingerprinted profile opened on macOS advertises
   * Sec-CH-UA-Platform: "macOS" while its User-Agent claims Windows. No CDP is available
   * on this launcher by design, so the per-profile MV3 extension rewrites the headers.
   */
  private static buildClientHintsRules(clientHintsPlatform: string, acceptLanguage: string) {
    return [
      {
        id: 1,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            {
              header: 'sec-ch-ua-platform',
              operation: 'set',
              value: `"${clientHintsPlatform}"`,
            },
            {
              header: 'accept-language',
              operation: 'set',
              value: acceptLanguage,
            },
            // High-entropy hints are only sent when a site opts in through Accept-CH.
            // Removing them is a no-op when absent and never leaks the host OS, whereas
            // forcing values would advertise them unsolicited on every request.
            { header: 'sec-ch-ua-platform-version', operation: 'remove' },
            { header: 'sec-ch-ua-arch', operation: 'remove' },
            { header: 'sec-ch-ua-bitness', operation: 'remove' },
            { header: 'sec-ch-ua-model', operation: 'remove' },
            { header: 'sec-ch-ua-full-version', operation: 'remove' },
            { header: 'sec-ch-ua-full-version-list', operation: 'remove' },
          ],
        },
        condition: {
          urlFilter: '*',
          resourceTypes: [
            'main_frame',
            'sub_frame',
            'stylesheet',
            'script',
            'image',
            'font',
            'object',
            'xmlhttprequest',
            'ping',
            'csp_report',
            'media',
            'websocket',
            'other',
          ],
        },
      },
    ];
  }

  private static async getProfileProcessIds(profilePath: string): Promise<number[]> {
    if (process.platform !== 'win32') return [];
    const escapedPath = profilePath.replace(/'/g, "''");
    try {
      const output = await this.runPowerShell(`
        $profilePath = '${escapedPath}'
        Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" |
          Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profilePath) } |
          ForEach-Object { $_.ProcessId }
      `);
      return output
        .split(/\r?\n/)
        .map(Number)
        .filter(processId => Number.isFinite(processId) && processId > 0);
    } catch (error) {
      console.warn('[Chrome] Could not inspect existing profile processes:', error);
      return [];
    }
  }

  private static async terminateProfileProcesses(profilePath: string): Promise<void> {
    if (process.platform !== 'win32') return;
    const escapedPath = profilePath.replace(/'/g, "''");
    try {
      await this.runPowerShell(`
        $profilePath = '${escapedPath}'
        Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" |
          Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profilePath) } |
          ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
          }
      `);
    } catch (error) {
      console.warn('[Chrome] Could not terminate stale profile processes:', error);
    }
  }

  private static async waitForVisibleWindow(
    profilePath: string,
    timeoutMs = 12000,
    preferredProcessId?: number
  ): Promise<number | null> {
    if (process.platform !== 'win32') return null;
    const escapedPath = profilePath.replace(/'/g, "''");
    const timeoutSeconds = Math.max(3, Math.ceil(timeoutMs / 1000));
    const preferredPid = Number.isFinite(preferredProcessId) && Number(preferredProcessId) > 0
      ? Number(preferredProcessId)
      : 0;
    const output = await this.runPowerShell(`
      $profilePath = '${escapedPath}'
      $preferredPid = ${preferredPid}
      $deadline = (Get-Date).AddSeconds(${timeoutSeconds})
      do {
        if ($preferredPid -gt 0) {
          $preferredProcess = Get-Process -Id $preferredPid -ErrorAction SilentlyContinue
          if ($preferredProcess) {
            $preferredProcess.Refresh()
            if ($preferredProcess.MainWindowHandle -ne 0) {
              Write-Output $preferredProcess.MainWindowHandle
              exit 0
            }
          }
        }
        $browserProcesses = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" |
          Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profilePath) }
        foreach ($browserProcess in $browserProcesses) {
          $process = Get-Process -Id $browserProcess.ProcessId -ErrorAction SilentlyContinue
          if ($process -and $process.MainWindowHandle -ne 0) {
            Write-Output $process.MainWindowHandle
            exit 0
          }
        }
        Start-Sleep -Milliseconds 250
      } while ((Get-Date) -lt $deadline)
      exit 2
    `);
    const handle = Number(output.split(/\r?\n/).find(Boolean));
    return Number.isFinite(handle) && handle > 0 ? handle : null;
  }

  private static clearStaleSingletonFiles(profilePath: string): void {
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      const target = path.join(profilePath, name);
      try {
        if (fs.existsSync(target)) fs.rmSync(target, { force: true, recursive: true });
      } catch (error) {
        console.warn(`[Chrome] Could not remove stale ${name}:`, error);
      }
    }
  }

  static setMainWindow(win: any) {
    this.mainWindow = win;
  }

  static setLocalServerConfig(config: { port: number; token: string }) {
    this.localServerConfig = config;
  }

  private static sendProgress(percent: number, status: string) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('browser:downloadProgress', { percent, status });
    }
  }

  static isProfileActive(profileId: string): boolean {
    return this.activeProfiles.has(profileId);
  }

  static reportLaunchStatus(payload: {
    profileId?: string;
    launchId?: string;
    status?: string;
    details?: Record<string, unknown>;
  }): void {
    const profileId = String(payload?.profileId || '');
    const launchId = String(payload?.launchId || '');
    const status = String(payload?.status || '');
    if (!profileId || !launchId || !status) return;

    const key = `${profileId}:${launchId}`;
    console.log(`[Spectra AutoStart] ${profileId} status: ${status}`, payload.details || {});
    const waiter = this.launchConfirmationWaiters.get(key);
    if (!waiter) return;
    if (status !== 'venus-confirmed' && status !== 'manual-pause-preserved') return;

    clearTimeout(waiter.timeout);
    this.launchConfirmationWaiters.delete(key);
    waiter.resolve(status);
  }

  private static waitForLaunchConfirmation(
    profileId: string,
    launchId: string,
    timeoutMs = 90000
  ): Promise<string> {
    const key = `${profileId}:${launchId}`;
    return new Promise(resolve => {
      const timeout = setTimeout(() => {
        this.launchConfirmationWaiters.delete(key);
        resolve('timeout');
      }, timeoutMs);
      this.launchConfirmationWaiters.set(key, { resolve, timeout });
    });
  }

  private static cancelLaunchConfirmation(profileId: string, launchId: string): void {
    const key = `${profileId}:${launchId}`;
    const waiter = this.launchConfirmationWaiters.get(key);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    this.launchConfirmationWaiters.delete(key);
    waiter.resolve('process-exited');
  }

  static async diagnoseEnvironment() {
    const cacheDir = path.join(os.homedir(), '.antidetect-browser', 'browser');
    const markerPath = path.join(cacheDir, '.installed');
    const profilesDir = process.platform === 'win32'
      ? path.join(os.homedir(), 'AppData', 'Local', 'AntidetectBrowser', 'Profiles')
      : path.join(os.homedir(), '.antidetect-browser', 'profiles');
    let managedBrowserPath = '';
    try {
      managedBrowserPath = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8').trim() : '';
    } catch {}

    let profilesDirectoryWritable = false;
    try {
      fs.mkdirSync(profilesDir, { recursive: true });
      const probe = path.join(profilesDir, `.spectra-write-test-${process.pid}`);
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      profilesDirectoryWritable = true;
    } catch {}

    let powershellAvailable = process.platform !== 'win32';
    if (process.platform === 'win32') {
      try {
        powershellAvailable = (await this.runPowerShell("Write-Output 'ok'")) === 'ok';
      } catch {}
    }

    return {
      platform: process.platform,
      architecture: process.arch,
      osRelease: os.release(),
      managedBrowserPath,
      managedBrowserReady: Boolean(managedBrowserPath && fs.existsSync(managedBrowserPath)),
      systemBrowserPath: this.findSystemChrome() || '',
      profilesDir,
      profilesDirectoryWritable,
      powershellAvailable,
      activeProfileIds: this.getActiveProfiles(),
    };
  }

  private static focusProfileWindow(profileId: string): boolean {
    const instance = this.activeProfiles.get(profileId);
    const pid = instance?.chromeProcess?.pid;
    if (!pid || process.platform !== 'win32') return false;

    const ps = `
      Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
      $p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
      if ($p) {
        $deadline = (Get-Date).AddSeconds(3)
        while ($p.MainWindowHandle -eq 0 -and (Get-Date) -lt $deadline) {
          Start-Sleep -Milliseconds 150
          $p.Refresh()
        }
        if ($p.MainWindowHandle -ne 0) {
          [Win32]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
          [Win32]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
        }
      }
    `;

    try {
      spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], {
        detached: true,
        stdio: 'ignore',
      }).unref();
      return true;
    } catch (error) {
      console.error(`[WindowFocus] Failed to focus profile ${profileId}:`, error);
      return false;
    }
  }

  private static getWindowPlacement(
    layout?: { index: number; total: number },
    launchMode?: SpectraLaunchMode
  ) {
    let workArea = { x: 0, y: 0, width: 1920, height: 1080 };

    try {
      const { screen } = require('electron');
      const display = this.mainWindow && !this.mainWindow.isDestroyed()
        ? screen.getDisplayMatching(this.mainWindow.getBounds())
        : screen.getPrimaryDisplay();
      workArea = display.workArea;
    } catch {}

    const win = launchMode === 'automation'
      ? this.openSelectedWindow
      : this.compactWindow;
    const maxColumns = Math.max(1, Math.floor((workArea.width - win.margin * 2 + win.gap) / (win.width + win.gap)));
    const columns = Math.max(1, maxColumns);
    const rawSlot = Math.max(0, layout?.index ?? this.activeProfiles.size);
    const maxRows = Math.max(1, Math.floor(
      (workArea.height - win.margin * 2 + win.gap) / (win.height + win.gap)
    ));
    const visibleCapacity = Math.max(1, columns * maxRows);
    // Open Selected may launch more profiles than the display can tile. Cycle
    // through the visible slots instead of placing later windows off-screen.
    // On the VPS display this yields six slots: 7 overlays 1, 8 overlays 2, etc.
    const slot = launchMode === 'automation'
      ? rawSlot % visibleCapacity
      : rawSlot;
    const col = slot % columns;
    const row = Math.floor(slot / columns);
    const left = workArea.x + win.margin + col * (win.width + win.gap);
    const top = workArea.y + win.margin + row * (win.height + win.gap);

    return {
      left,
      top,
      right: left + win.width,
      bottom: top + win.height,
      width: win.width,
      height: win.height,
      workArea,
    };
  }

  private static applyCleanLaunchState(profilePath: string, prefs: any) {
    prefs.profile = {
      ...(prefs.profile || {}),
      exit_type: 'Normal',
      exited_cleanly: true,
    };
    prefs.session = {
      ...(prefs.session || {}),
      restore_on_startup: 0,
      startup_urls: [],
    };

    const localStatePath = path.join(profilePath, 'Local State');
    try {
      const localState = fs.existsSync(localStatePath) ? JSON.parse(fs.readFileSync(localStatePath, 'utf8')) : {};
      localState.profile = {
        ...(localState.profile || {}),
        exit_type: 'Normal',
        exited_cleanly: true,
      };
      fs.writeFileSync(localStatePath, JSON.stringify(localState));
    } catch {}
  }

  private static applyManualLaunchState(profilePath: string, prefs: any) {
    prefs.profile = {
      ...(prefs.profile || {}),
      exit_type: 'Normal',
      exited_cleanly: true,
    };
    prefs.session = {
      ...(prefs.session || {}),
      restore_on_startup: 1,
    };

    const localStatePath = path.join(profilePath, 'Local State');
    try {
      const localState = fs.existsSync(localStatePath) ? JSON.parse(fs.readFileSync(localStatePath, 'utf8')) : {};
      localState.profile = {
        ...(localState.profile || {}),
        exit_type: 'Normal',
        exited_cleanly: true,
      };
      fs.writeFileSync(localStatePath, JSON.stringify(localState));
    } catch {}
  }

  private static hasChromeSessionRestore(profilePath: string): boolean {
    const defaultDir = path.join(profilePath, 'Default');
    const sessionTargets = [
      path.join(defaultDir, 'Current Session'),
      path.join(defaultDir, 'Current Tabs'),
      path.join(defaultDir, 'Last Session'),
      path.join(defaultDir, 'Last Tabs'),
      path.join(defaultDir, 'Sessions'),
    ];

    return sessionTargets.some(target => {
      try {
        if (!fs.existsSync(target)) return false;
        const stat = fs.statSync(target);
        if (stat.isDirectory()) return fs.readdirSync(target).length > 0;
        return stat.size > 0;
      } catch {
        return false;
      }
    });
  }

  private static fileHasAuthenticatedXSession(filePath: string): boolean {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return hasAuthenticatedXSession(parsed);
    } catch {
      return false;
    }
  }

  static hasAuthenticatedXSnapshot(profileId: string): boolean {
    this.assertSafeId(profileId, 'profile ID');
    const profilesRoot = process.platform === 'win32'
      ? path.join(os.homedir(), 'AppData', 'Local', 'AntidetectBrowser', 'Profiles')
      : path.join(os.homedir(), '.antidetect-browser', 'profiles');
    return this.ensureAuthenticatedXSnapshot(path.join(profilesRoot, profileId));
  }

  private static ensureAuthenticatedXSnapshot(profilePath: string): boolean {
    const protectedPath = path.join(profilePath, 'authenticated_cookies.json');
    if (fs.existsSync(protectedPath) && this.fileHasAuthenticatedXSession(protectedPath)) {
      return true;
    }

    const syncedPath = path.join(profilePath, 'synced_cookies.json');
    if (!fs.existsSync(syncedPath) || !this.fileHasAuthenticatedXSession(syncedPath)) {
      return false;
    }

    try {
      const tempPath = `${protectedPath}.${process.pid}.${Date.now()}.tmp`;
      fs.copyFileSync(syncedPath, tempPath);
      fs.renameSync(tempPath, protectedPath);
      console.log('[CookieSync] Promoted current authenticated cookies to protected snapshot');
      return true;
    } catch (error) {
      console.warn('[CookieSync] Could not protect authenticated snapshot:', error);
      return false;
    }
  }

  private static clearChromeSessionRestore(profilePath: string) {
    const defaultDir = path.join(profilePath, 'Default');
    const sessionTargets = [
      path.join(defaultDir, 'Current Session'),
      path.join(defaultDir, 'Current Tabs'),
      path.join(defaultDir, 'Last Session'),
      path.join(defaultDir, 'Last Tabs'),
      path.join(defaultDir, 'Sessions'),
    ];

    for (const target of sessionTargets) {
      try {
        if (!fs.existsSync(target)) continue;
        const stat = fs.statSync(target);
        if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
        else fs.unlinkSync(target);
      } catch {}
    }
  }

  private static nextVenusRuntimeVersion(profilePath: string, sourceVersion: string): string {
    const statePath = path.join(profilePath, '.spectra-venus-runtime-version.json');
    let previousCounter = 0;

    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      previousCounter = Number(state?.counter || state?.revision || 0);
    } catch {}

    const counter = Math.max(0, previousCounter) + 1;
    const counterHigh = Math.floor(counter / 65535);
    const counterLow = counter % 65535;
    if (counterHigh > 65535) {
      throw new Error(`VenusBot runtime revision exhausted for ${sourceVersion}`);
    }

    // Early development builds used a 2026.x runtime version. Chrome rejects
    // any later 4.x copy as a downgrade and silently keeps the stale worker.
    // Reserve a high Spectra-only namespace and increase it for every mode.
    const runtimeVersion = `60000.1.${counterHigh}.${counterLow}`;
    const nextState = JSON.stringify({ sourceVersion, counter, runtimeVersion });
    const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, nextState);
    fs.renameSync(tempPath, statePath);
    return runtimeVersion;
  }

  private static configureTwitterAutoReplyAutostart(
    extensionPath: string,
    enabled: boolean,
    launchContext: {
      launchId: string;
      profileId: string;
      profileName: string;
      profilePath: string;
    }
  ): boolean {
    const manifestPath = path.join(extensionPath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return false;

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (!this.isTwitterAutoReplyManifest(manifest)) return false;

      const venusVersion = String(manifest.version || 'unknown');
      // Chrome identifies VenusBot by its stable manifest key. Increment the
      // fourth version component for every runtime copy, including manual and
      // OpenPost launches, so a previous autostart worker can never survive in
      // a mode where it is disabled. The first three upstream components stay
      // intact, allowing a future VenusBot release to supersede this runtime.
      manifest.version_name = venusVersion;
      manifest.version = this.nextVenusRuntimeVersion(
        launchContext.profilePath,
        venusVersion
      );
      const contentScripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
      const contentScriptFiles = contentScripts.flatMap((script: any) =>
        Array.isArray(script.js) ? script.js : []
      );
      let contentCompatibilityPrepared = !enabled;
      for (const scriptFile of contentScriptFiles) {
        const scriptPath = path.join(extensionPath, scriptFile);
        if (!fs.existsSync(scriptPath)) continue;
        const source = fs.readFileSync(scriptPath, 'utf8');
        if (!source.includes('pendingAutoStart') || !source.includes('startAutoMode')) {
          continue;
        }
        let patched = source.replace(
          /(\[\s*['"]pendingAutoStart['"]\s*,\s*['"]pendingMode['"]\s*,\s*['"]autonomousPhase['"])((?:\s*,\s*['"](?:autonomousPhaseStartTime|manualPause|spectraPendingLaunchId)['"])*)?(\s*,\s*['"]pendingAutonomousPost['"]\s*\])/,
          (_match, prefix, optionalKeys = '', suffix) => {
            let keys = optionalKeys;
            if (!/autonomousPhaseStartTime/.test(keys)) keys += ",'autonomousPhaseStartTime'";
            if (!/manualPause/.test(keys)) keys += ",'manualPause'";
            if (!/spectraPendingLaunchId/.test(keys)) keys += ",'spectraPendingLaunchId'";
            return `${prefix}${keys}${suffix}`;
          }
        );
        const pendingGuard = 'if(e.pendingAutoStart&&!e.manualPause){';
        patched = patched.replace(
          /if\(e\.pendingAutoStart&&!e\.manualPause&&\(!sessionStorage\.getItem\(["']spectra:autostart-initializing:[^"']+["']\)\|\|e\.spectraPendingLaunchId===["'][^"']+["']\)\)\{/,
          pendingGuard
        );
        patched = patched.replace(
          /if\(e\.pendingAutoStart(?:&&!e\.manualPause)?\)\{/,
          pendingGuard
        );
        patched = patched.replace(
          /chrome\.storage\.local\.remove\(\[\s*['"]pendingAutoStart['"]\s*,\s*['"]pendingMode['"]\s*,\s*['"]autonomousPhase['"](?:\s*,\s*['"]spectraPendingLaunchId['"])?\s*\]\)/,
          "chrome.storage.local.remove(['pendingAutoStart','pendingMode','autonomousPhase','spectraPendingLaunchId'])"
        );
        patched = patched.replace(
          /:this\.isEnabled(?:&&!sessionStorage\.getItem\(["']spectra:autostart-initializing:[^"']+["']\))?&&this\.startAutoMode\(\)/,
          ':this.isEnabled&&this.startAutoMode()'
        );
        if (patched !== source) {
          fs.writeFileSync(scriptPath, patched);
          console.log(`[Spectra AutoStart] Patched cycle resume compatibility in ${scriptFile}`);
        }
        contentCompatibilityPrepared =
          patched.includes('autonomousPhaseStartTime') &&
          patched.includes('manualPause') &&
          patched.includes('spectraPendingLaunchId') &&
          patched.includes(
            "chrome.storage.local.remove(['pendingAutoStart','pendingMode','autonomousPhase','spectraPendingLaunchId'])"
          );
        if (contentCompatibilityPrepared) break;
      }
      if (!contentCompatibilityPrepared) {
        console.error('[Spectra AutoStart] VenusBot content contract is incompatible');
        return false;
      }

      const autostartFile = 'spectra-autostart.js';
      const autostartPath = path.join(extensionPath, autostartFile);
      const stateResolverSource = resolveVenusAutostartState.toString();
      const autostartScript = `
(function () {
  const PROFILE_ID = ${JSON.stringify(launchContext.profileId)};
  const PROFILE_NAME = ${JSON.stringify(launchContext.profileName)};
  const LAUNCH_ID = ${JSON.stringify(launchContext.launchId)};
  const VENUS_VERSION = ${JSON.stringify(venusVersion)};
  const READY_MARKER = 'spectra:startup-tabs-ready:' + LAUNCH_ID;
  const INIT_MARKER = 'spectra:autostart-initializing:' + LAUNCH_ID;
  const COMMAND_MARKER = 'spectra:autostart-command-sent:' + LAUNCH_ID;
  const CONFIRMED_MARKER = 'spectra:autostart-confirmed:' + LAUNCH_ID;
  const resolveVenusAutostartState = ${stateResolverSource};
  let activationInFlight = false;
  sessionStorage.setItem(INIT_MARKER, '1');

  const isRequestsPage = () =>
    /^\\/(?:i\\/chat|messages)\\/requests\\/?$/i.test(window.location.pathname);

  const formatRemaining = (milliseconds) => {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' +
      String(seconds % 60).padStart(2, '0');
  };

  const logHeader = () => {
    console.log('[Spectra AutoStart] Profile ' + PROFILE_ID + ' (' + PROFILE_NAME + ')');
    console.log('[Spectra AutoStart] Launch ID: ' + LAUNCH_ID);
    console.log('[Spectra AutoStart] VenusBot version: ' + VENUS_VERSION);
  };

  const waitForConfirmation = () => {
    if (sessionStorage.getItem(CONFIRMED_MARKER) === '1') return;
    const deadline = Date.now() + 30000;
    const check = () => {
      chrome.storage.local.get(
        ['isEnabled', 'mode', 'autonomousPhase', 'autonomousPhaseStartTime'],
        (state) => {
          const bot = window.twitterAutoReplyBot || window.venusSecurityLabBot;
          const running = Boolean(
            bot && bot.isRunning === true && bot.autonomousCycleRunning === true
          );
          if (state.isEnabled === true && state.mode === 'autonomous' && running) {
            sessionStorage.setItem(CONFIRMED_MARKER, '1');
            sessionStorage.removeItem(INIT_MARKER);
            chrome.storage.local.remove('spectraPendingLaunchId');
            console.log('[Spectra AutoStart] VenusBot confirmed running');
            return;
          }
          if (Date.now() < deadline) {
            window.setTimeout(check, 500);
          } else {
            sessionStorage.removeItem(INIT_MARKER);
            console.warn('[Spectra AutoStart] VenusBot start confirmation timed out');
          }
        }
      );
    };
    check();
  };

  const activate = () => {
    if (activationInFlight) {
      console.log('[Spectra AutoStart] Duplicate start blocked: initialization in progress');
      return;
    }
    if (sessionStorage.getItem(COMMAND_MARKER) === '1') {
      console.log('[Spectra AutoStart] Duplicate start blocked: command already sent');
      waitForConfirmation();
      return;
    }

    activationInFlight = true;
    chrome.storage.local.get([
      'isEnabled',
      'mode',
      'autonomousPhase',
      'autonomousPhaseStartTime',
      'autonomousRequestsTime',
      'autonomousDmsTime',
      'pendingAutoStart',
      'spectraPendingLaunchId',
      'manualPause'
    ], (state) => {
      if (chrome.runtime.lastError) {
        activationInFlight = false;
        sessionStorage.removeItem(INIT_MARKER);
        console.warn('[Spectra AutoStart] State read failed:', chrome.runtime.lastError);
        return;
      }

      if (state.manualPause === true) {
        activationInFlight = false;
        chrome.storage.local.remove(
          ['pendingAutoStart', 'pendingMode', 'spectraPendingLaunchId'],
          () => {
            sessionStorage.setItem('spectra:autostart-manual-pause:' + LAUNCH_ID, '1');
            sessionStorage.removeItem(INIT_MARKER);
            console.log('[Spectra AutoStart] Manual pause preserved; autostart skipped');
          }
        );
        return;
      }

      const bot = window.twitterAutoReplyBot || window.venusSecurityLabBot;
      if (bot && (bot.isRunning || bot.autonomousCycleRunning)) {
        sessionStorage.setItem(COMMAND_MARKER, '1');
        console.log('[Spectra AutoStart] Duplicate start blocked: VenusBot already running');
        waitForConfirmation();
        return;
      }
      if (
        state.pendingAutoStart === true &&
        state.spectraPendingLaunchId === LAUNCH_ID
      ) {
        sessionStorage.setItem(COMMAND_MARKER, '1');
        console.log('[Spectra AutoStart] Duplicate start blocked: current launch command already exists');
        // The background worker may have staged the command just after
        // VenusBot performed its one-time startup read. Reload once so the
        // native pendingAutoStart handler consumes that owned command.
        window.location.reload();
        return;
      }
      if (state.pendingAutoStart === true) {
        console.log('[Spectra AutoStart] Stale pending command replaced');
      }

      const plan = resolveVenusAutostartState(state, Date.now(), LAUNCH_ID);

      if (plan.valid) {
        console.log('[Spectra AutoStart] Existing cycle valid');
        console.log('[Spectra AutoStart] Cycle resumed');
        console.log('[Spectra AutoStart] Saved phase: ' + plan.phase);
        console.log('[Spectra AutoStart] Resuming phase: ' + plan.phase);
        console.log('[Spectra AutoStart] Saved autonomousPhaseStartTime: ' + plan.phaseStartTime);
        if (plan.remainingMilliseconds !== null) {
          console.log('[Spectra AutoStart] Remaining time: ' + formatRemaining(plan.remainingMilliseconds));
          if (plan.remainingMilliseconds === 0) {
            console.log('[Spectra AutoStart] Saved timer expired; VenusBot will perform the normal phase transition');
          }
        }
      } else {
        console.log('[Spectra AutoStart] No valid saved cycle');
        console.log('[Spectra AutoStart] Initializing phase: requests');
        console.log('[Spectra AutoStart] Reason: ' + plan.reason);
      }

      chrome.storage.local.set(plan.updates, () => {
        activationInFlight = false;
        if (chrome.runtime.lastError) {
          sessionStorage.removeItem(INIT_MARKER);
          console.warn('[Spectra AutoStart] Start command failed:', chrome.runtime.lastError);
          return;
        }
        sessionStorage.setItem(COMMAND_MARKER, '1');
        console.log('[Spectra AutoStart] Start command sent once');
        if (window.location.href === plan.targetUrl) {
          window.location.reload();
        } else {
          window.location.href = plan.targetUrl;
        }
      });
    });
  };

  logHeader();
  if (sessionStorage.getItem(COMMAND_MARKER) === '1') {
    waitForConfirmation();
    return;
  }

  const deadline = Date.now() + 60000;
  const startupTabsMarkerDeadline = Date.now() + 5000;
  const waitForReadyRequestsTab = () => {
    try {
      if (!isRequestsPage()) return;
      // The cookie-sync worker stores the retained Chrome tab ID as the marker
      // value. Presence means the single-tab bootstrap has completed. Do not
      // let a delayed MV3 worker prevent VenusBot from starting indefinitely:
      // Open Selected already launches Requests as its only native tab.
      if (!sessionStorage.getItem(READY_MARKER)) {
        if (Date.now() < startupTabsMarkerDeadline) {
          window.setTimeout(waitForReadyRequestsTab, 250);
          return;
        }
        console.warn('[Spectra AutoStart] Single-tab marker delayed; using Requests fallback');
      }
      const authenticatedUi = document.querySelector(
        [
          '[data-testid="AppTabBar_Home_Link"]',
          '[data-testid="SideNav_AccountSwitcher_Button"]',
          '[data-testid="primaryColumn"]',
          '[data-testid="AppTabBar_DirectMessage_Link"]',
          'nav[role="navigation"] a[href="/home"]',
        ].join(', ')
      );
      const loginUi = document.querySelector(
        [
          'input[autocomplete="username"]',
          'input[autocomplete="current-password"]',
          '[data-testid="loginButton"]',
        ].join(', ')
      );
      const completedXApp = document.readyState === 'complete' &&
        Boolean(document.querySelector('#react-root, main[role="main"], #layers'));
      if (!loginUi && (authenticatedUi || completedXApp)) {
        console.log(
          authenticatedUi
            ? '[Spectra AutoStart] Authenticated X interface detected'
            : '[Spectra AutoStart] X application ready in compact layout'
        );
        activate();
        return;
      }
      if (Date.now() < deadline) {
        window.setTimeout(waitForReadyRequestsTab, 500);
      } else {
        sessionStorage.removeItem(INIT_MARKER);
        console.warn('[Spectra AutoStart] Requests page did not become ready before timeout');
      }
    } catch (error) {
      console.warn('[Spectra AutoStart] Initialization failed:', error);
    }
  };

  waitForReadyRequestsTab();
})();
`;
      if (enabled && (!fs.existsSync(autostartPath) || fs.readFileSync(autostartPath, 'utf8') !== autostartScript)) {
        fs.writeFileSync(autostartPath, autostartScript);
      }

      const matches = [
        'https://x.com/*',
        'https://twitter.com/*',
      ];
      const alreadyRegistered = contentScripts.some((script: any) =>
        Array.isArray(script.js) && script.js.includes(autostartFile)
      );

      if (enabled && !alreadyRegistered) {
        manifest.content_scripts = [
          { matches, js: [autostartFile], run_at: 'document_start' },
          ...contentScripts,
        ];
      } else if (!enabled && alreadyRegistered) {
        manifest.content_scripts = contentScripts.filter((script: any) =>
          !(Array.isArray(script.js) && script.js.includes(autostartFile))
        );
      }
      const registeredContentScripts = Array.isArray(manifest.content_scripts)
        ? manifest.content_scripts
        : [];
      const autostartRegistered = registeredContentScripts.some((script: any) =>
        Array.isArray(script.js) && script.js.includes(autostartFile)
      );
      if (enabled !== autostartRegistered) {
        console.error('[Spectra AutoStart] VenusBot manifest registration failed');
        return false;
      }
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      return true;
    } catch (error) {
      console.error('[Extensions] Failed to prepare Twitter Auto Reply autostart:', error);
      return false;
    }
  }

  private static getExtensionName(extensionPath: string): string | null {
    const manifestPath = path.join(extensionPath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return null;

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      return typeof manifest.name === 'string' ? manifest.name : null;
    } catch {
      return null;
    }
  }

  private static isTwitterAutoReplyManifest(manifest: any): boolean {
    const name = typeof manifest?.name === 'string'
      ? manifest.name.trim().toLowerCase()
      : '';

    return name.includes('twitter auto reply dm');
  }

  private static findTwitterAutoReplyExtensionPath(): string | null {
    const extensionRoots = [
      path.join(os.homedir(), '.antidetect-browser', 'extensions'),
      path.join(os.homedir(), 'AppData', 'Local', 'AntidetectBrowser', 'Extensions'),
    ];

    for (const root of extensionRoots) {
      if (!fs.existsSync(root)) continue;
      try {
        const matches = fs.readdirSync(root)
          .map(name => path.join(root, name))
          .filter(extPath => {
            const manifestPath = path.join(extPath, 'manifest.json');
            if (!fs.existsSync(manifestPath)) return false;
            try {
              const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
              return this.isTwitterAutoReplyManifest(manifest);
            } catch {
              return false;
            }
          })
          .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        if (matches[0]) return matches[0];
      } catch {}
    }

    return null;
  }

  private static createRuntimeExtensionCopy(runtimeRoot: string, sourcePath: string, index: number): string {
    const sourceName = path.basename(sourcePath).replace(/[^A-Za-z0-9_-]/g, '_');
    const destination = path.join(runtimeRoot, `${index}-${sourceName}`);
    fs.cpSync(sourcePath, destination, { recursive: true, force: true });
    return destination;
  }

  private static getChromeExtensionId(runtimePath: string): string | null {
    const manifestPath = path.join(runtimePath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return null;

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (typeof manifest.key !== 'string' || !manifest.key.trim()) return null;
      const digest = crypto
        .createHash('sha256')
        .update(Buffer.from(manifest.key, 'base64'))
        .digest()
        .subarray(0, 16);
      return Array.from(digest)
        .map((byte) =>
          String.fromCharCode(97 + (byte >> 4)) +
          String.fromCharCode(97 + (byte & 15))
        )
        .join('');
    } catch (error) {
      console.warn('[Extensions] Could not derive extension ID:', error);
      return null;
    }
  }

  private static enforceWindowPlacement(pid: number | undefined, placement: ReturnType<typeof PuppeteerLauncher.getWindowPlacement>) {
    if (!pid || process.platform !== 'win32') return;

    const ps = `
      Start-Sleep -Milliseconds 900
      Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}
"@
      $p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
      if ($p) {
        $deadline = (Get-Date).AddSeconds(5)
        while ($p.MainWindowHandle -eq 0 -and (Get-Date) -lt $deadline) {
          Start-Sleep -Milliseconds 150
          $p.Refresh()
        }
        if ($p.MainWindowHandle -ne 0) {
          for ($attempt = 0; $attempt -lt 3; $attempt++) {
            [Win32]::SetWindowPos($p.MainWindowHandle, [IntPtr]::Zero, ${placement.left}, ${placement.top}, ${placement.width}, ${placement.height}, 0x0040) | Out-Null
            Start-Sleep -Milliseconds 250
            $p.Refresh()
          }
        }
      }
    `;

    spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  }

  private static async spawnChromeAndVerify(
    chromePath: string,
    args: string[],
    env: Record<string, string | undefined>,
    profilePath: string
  ): Promise<ChildProcess> {
    const chromeProcess = await new Promise<ChildProcess>((resolve, reject) => {
      const chromeProcess = spawn(chromePath, args, {
        detached: false,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: env as any,
      });

      let settled = false;
      let stderr = '';
      let startupTimer: NodeJS.Timeout;
      const onStderr = (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-4000);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(startupTimer);
        chromeProcess.removeListener('error', onError);
        chromeProcess.removeListener('exit', onEarlyExit);
        chromeProcess.stderr?.removeListener('data', onStderr);
        if (error) reject(error);
        else resolve(chromeProcess);
      };
      const onError = (error: Error) => finish(new Error(`Chrome could not start: ${error.message}`));
      const onEarlyExit = (code: number | null, signal: NodeJS.Signals | null) => {
        const detail = stderr.trim().replace(/\s+/g, ' ').slice(-500);
        finish(new Error(`Chrome closed during startup (code ${code ?? 'unknown'}${signal ? `, signal ${signal}` : ''})${detail ? `: ${detail}` : ''}`));
      };
      startupTimer = setTimeout(() => finish(), 1500);

      chromeProcess.stderr?.on('data', onStderr);
      chromeProcess.once('error', onError);
      chromeProcess.once('exit', onEarlyExit);
    });

    if (process.platform === 'win32') {
      try {
        const handle = await this.waitForVisibleWindow(
          profilePath,
          12000,
          chromeProcess.pid
        );
        if (!handle) throw new Error('no visible window');
      } catch (error: any) {
        try { chromeProcess.kill(); } catch {}
        throw new Error(`Chrome started but no visible window appeared: ${error.message}`);
      }
    }

    return chromeProcess;
  }

  /**
   * Clean Chrome-internal state from a profile directory to fix version incompatibility.
   */
  private static cleanProfileState(profilePath: string) {
    const keepFiles = new Set([
      'pending_cookies.json', 'synced_cookies.json', 'authenticated_cookies.json',
      'fingerprint_override.json', 'open_tabs.json',
      'last_url.txt', '__proxy_auth_ext', '__brand_fix_ext',
      '__cookie_sync_ext', '__platform_fix_ext', '__startup_tab_cleaner_ext',
    ]);
    try {
      const entries = fs.readdirSync(profilePath);
      for (const entry of entries) {
        if (keepFiles.has(entry)) continue;
        const fullPath = path.join(profilePath, entry);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            fs.rmSync(fullPath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(fullPath);
          }
        } catch {}
      }
      console.log(`[Profile] Cleaned incompatible Chrome state from ${profilePath}`);
    } catch (e: any) {
      console.error(`[Profile] Error cleaning profile state:`, e.message);
    }
  }

  static async launch(options: PuppeteerLaunchOptions) {
    let autoStartLaunchId = '';
    try {
      this.assertSafeId(options.profileId, 'profile ID');
      this.cancelledProfiles.delete(options.profileId);
      const targetTweetUrl = options.targetTweetUrl
        ? normalizeTweetUrl(options.targetTweetUrl)
        : null;
      if (options.targetTweetUrl && !targetTweetUrl) {
        throw new Error('Invalid X post URL');
      }
      const sessionImportAttemptId = options.sessionImport?.attemptId || '';
      if (sessionImportAttemptId && !/^[A-Fa-f0-9-]{16,64}$/.test(sessionImportAttemptId)) {
        throw new Error('Invalid session import attempt');
      }
      const launchMode = resolveLaunchMode({
        launchMode: options.launchMode,
        sessionImportAttemptId,
        targetTweetUrl,
        autoStartTwitterBot: options.autoStartTwitterBot,
      });
      const managedLaunch = isManagedLaunch(launchMode);

      // Get user data directory path
      const userDataDir = process.platform === 'win32'
        ? path.join(os.homedir(), 'AppData', 'Local', 'AntidetectBrowser', 'Profiles')
        : path.join(os.homedir(), '.antidetect-browser', 'profiles');

      const profilePath = path.join(userDataDir, options.profileId);
      if (!fs.existsSync(profilePath)) {
        fs.mkdirSync(profilePath, { recursive: true });
      }
      this.appendLifecycleEvent(options.profileId, 'launch-requested', {
        launchMode,
        autoStartTwitterBot: options.autoStartTwitterBot === true,
        hasTargetTweet: Boolean(targetTweetUrl),
        hasSessionImport: sessionImportAttemptId.length > 0,
      });

      const existingProfileProcesses = await this.getProfileProcessIds(profilePath);
      if (existingProfileProcesses.length > 0) {
        let visibleWindowExists = process.platform !== 'win32';
        if (process.platform === 'win32') {
          try {
            visibleWindowExists = Boolean(await this.waitForVisibleWindow(profilePath, 1500));
          } catch {
            visibleWindowExists = false;
          }
        }

        if (visibleWindowExists) {
          this.focusProfileWindow(options.profileId);
          return { success: false, error: 'Profile already running', alreadyRunning: true };
        }

        console.warn(
          `[Chrome] Found ${existingProfileProcesses.length} stale process(es) without a visible window for ${options.profileId}`
        );
        await this.terminateProfileProcesses(profilePath);
        this.activeProfiles.delete(options.profileId);
      }
      this.clearStaleSingletonFiles(profilePath);

      // Prepare Default directory and Preferences
      const defaultDir = path.join(profilePath, 'Default');
      if (!fs.existsSync(defaultDir)) {
        fs.mkdirSync(defaultDir, { recursive: true });
      }
      const prefsPath = path.join(defaultDir, 'Preferences');
      let prefs: any = {};
      if (fs.existsSync(prefsPath)) {
        try { prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8')); } catch {}
      }
      const placement = this.getWindowPlacement(options.windowLayout, launchMode);
      const hasRestorableSession = this.hasChromeSessionRestore(profilePath);
      let manualPlacementCorrection: ReturnType<typeof fitWindowToWorkArea> = null;
      if (managedLaunch) {
        this.applyCleanLaunchState(profilePath, prefs);
        this.clearChromeSessionRestore(profilePath);
        prefs.browser = {
          ...(prefs.browser || {}),
          window_placement: {
            left: placement.left,
            top: placement.top,
            right: placement.right,
            bottom: placement.bottom,
            maximized: false,
            work_area_left: placement.workArea.x,
            work_area_top: placement.workArea.y,
            work_area_right: placement.workArea.x + placement.workArea.width,
            work_area_bottom: placement.workArea.y + placement.workArea.height,
          },
        };
      } else {
        // A normal launch must retain Chrome's tabs and the user's own window
        // placement. OpenPost and other managed workflows stay deterministic.
        this.applyManualLaunchState(profilePath, prefs);
        const storedPlacement = prefs.browser?.window_placement;
        if (storedPlacement) {
          manualPlacementCorrection = fitWindowToWorkArea(
            {
              left: Number(storedPlacement.left),
              top: Number(storedPlacement.top),
              right: Number(storedPlacement.right),
              bottom: Number(storedPlacement.bottom),
            },
            placement.workArea
          );
          if (manualPlacementCorrection) {
            prefs.browser = {
              ...(prefs.browser || {}),
              window_placement: {
                ...storedPlacement,
                ...manualPlacementCorrection,
                maximized: false,
                work_area_left: placement.workArea.x,
                work_area_top: placement.workArea.y,
                work_area_right: placement.workArea.x + placement.workArea.width,
                work_area_bottom: placement.workArea.y + placement.workArea.height,
              },
            };
            console.log('[Chrome] Manual window fitted to the active display');
          }
        }
      }
      // Enable developer mode for extensions loading
      if (!prefs.extensions) prefs.extensions = {};
      prefs.extensions.developer_mode = true;
      // Suppress "disable developer mode extensions" dialog
      if (!prefs.extensions.alerts) prefs.extensions.alerts = {};
      prefs.extensions.alerts.initialized = true;
      fs.writeFileSync(prefsPath, JSON.stringify(prefs));

      // Proxy config
      let proxy: any = null;
      if (options.proxy?.host) {
        proxy = options.proxy;
      }

      const cacheDir = path.join(profilePath, 'Cache');
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }

      // Get Chrome for Testing (supports --load-extension for unpacked extensions)
      let chromePath: string;
      try {
        chromePath = await this.downloadChromeForTesting();
      } catch (downloadError: any) {
        // Stable Google Chrome refuses --load-extension ("--load-extension is not allowed
        // in Google Chrome, ignoring"), so falling back to it would start the profile with
        // the entire fingerprint runtime silently dropped: user agent, platform, client
        // hints, WebGL and canvas. An unprotected launch is worse than no launch, so this
        // now fails loudly instead of degrading without telling anyone.
        throw new Error(
          `Managed browser unavailable: ${downloadError.message}. `
          + 'System Chrome cannot replace it because it ignores --load-extension, which '
          + 'would disable fingerprint protection for this profile.'
        );
      }

      // Build Chrome args — MINIMAL flags only
      const compactWindowSize = `${placement.width},${placement.height}`;
      const compactWindowPosition = `${placement.left},${placement.top}`;
      const browserVersion = await this.getBrowserVersion(chromePath);
      let effectiveFingerprint = { ...(options.fingerprint || {}) };
      const fingerprintOverridePath = path.join(profilePath, 'fingerprint_override.json');
      if (fs.existsSync(fingerprintOverridePath)) {
        try {
          const stat = fs.statSync(fingerprintOverridePath);
          if (stat.size > 64 * 1024) throw new Error('override is too large');
          const override = JSON.parse(fs.readFileSync(fingerprintOverridePath, 'utf8'));
          if (!override || typeof override !== 'object' || Array.isArray(override)) {
            throw new Error('override must be an object');
          }
          effectiveFingerprint = { ...effectiveFingerprint, ...override };
          console.log(`[Fingerprint] Applied profile override for ${options.profileId}`);
        } catch (error: any) {
          console.warn(`[Fingerprint] Invalid profile override ignored: ${error.message}`);
        }
      }
      const configuredUserAgent = options.userAgent || effectiveFingerprint.userAgent || '';
      const userAgent = this.alignUserAgentToBrowser(configuredUserAgent, browserVersion);
      console.log(`[Browser] Executable version: ${browserVersion || 'unknown'}`);
      const args = [
        `--user-data-dir=${profilePath}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-infobars',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        `--lang=${effectiveFingerprint.language || effectiveFingerprint.languages?.[0] || 'en-US'}`,
        '--disable-features=CalculateNativeWinOcclusion',
      ];
      if (managedLaunch) {
        args.push(`--window-size=${compactWindowSize}`);
        args.push(`--window-position=${compactWindowPosition}`);
      } else if (manualPlacementCorrection) {
        args.push(
          `--window-size=${manualPlacementCorrection.right - manualPlacementCorrection.left},` +
          `${manualPlacementCorrection.bottom - manualPlacementCorrection.top}`
        );
        args.push(
          `--window-position=${manualPlacementCorrection.left},${manualPlacementCorrection.top}`
        );
      }
      // Force User-Agent to match fingerprint (consistent across Mac/Windows)
      if (userAgent) {
        args.push(`--user-agent=${userAgent}`);
        console.log(`[UA] Forced: ${userAgent.substring(0, 80)}...`);
      }

      // WebRTC leak protection when using proxy
      if (proxy && proxy.host) {
        args.push('--webrtc-ip-handling-policy=disable_non_proxied_udp');
        args.push('--enforce-webrtc-ip-permission-check');
      }

      // Proxy — local relay server handles auth transparently
      let localProxyServer: http.Server | null = null;
      if (proxy && proxy.host) {
        const proxyType = (proxy.type || 'http').toLowerCase();

        if (proxy.username && proxy.password && (proxyType === 'http' || proxyType === 'https')) {
          // Spawn a local proxy that relays to remote proxy with auth
          const localProxy = await this.createLocalProxy(proxy);
          localProxyServer = localProxy.server;
          args.push(`--proxy-server=http://127.0.0.1:${localProxy.port}`);
          console.log(`[Proxy] Local relay on port ${localProxy.port} → ${proxy.host}:${proxy.port}`);
        } else if (proxyType === 'socks5' || proxyType === 'socks4') {
          args.push(`--proxy-server=${proxyType}://${proxy.host}:${proxy.port}`);
        } else {
          args.push(`--proxy-server=http://${proxy.host}:${proxy.port}`);
        }
      }

      // Apply the stored fingerprint before page scripts execute.
      let platformFixPath: string | null = null;
      if (userAgent) {
        const isWindows = userAgent.includes('Windows');
        const isMac = userAgent.includes('Macintosh');
        const platform = isWindows ? 'Win32' : isMac ? 'MacIntel' : 'Linux x86_64';
        // Client Hints travel as HTTP headers built from the real OS, so --user-agent
        // alone leaves them contradicting the fingerprint when a profile moves machines.
        const clientHintsPlatform = isWindows ? 'Windows' : isMac ? 'macOS' : 'Linux';

        platformFixPath = path.join(profilePath, '__platform_fix_ext');
        if (fs.existsSync(platformFixPath)) {
          fs.rmSync(platformFixPath, { recursive: true, force: true });
        }
        fs.mkdirSync(platformFixPath, { recursive: true });

        fs.writeFileSync(path.join(platformFixPath, 'manifest.json'), JSON.stringify({
          manifest_version: 3,
          name: 'Spectra Fingerprint Runtime',
          version: '2.2',
          permissions: ['declarativeNetRequest'],
          host_permissions: ['<all_urls>'],
          declarative_net_request: {
            rule_resources: [
              {
                id: 'spectra_client_hints',
                enabled: true,
                path: 'client-hints-rules.json',
              },
            ],
          },
          content_scripts: [
            {
              matches: ['<all_urls>'],
              js: ['fingerprint.js'],
              run_at: 'document_start',
              all_frames: true,
              world: 'MAIN',
            },
            ...(managedLaunch ? [{
              matches: [
                'https://x.com/*',
                'https://www.x.com/*',
                'https://twitter.com/*',
                'https://www.twitter.com/*',
              ],
              js: ['x-cookie-consent.js'],
              run_at: 'document_idle',
            }] : []),
          ],
        }));

        fs.writeFileSync(
          path.join(platformFixPath, 'client-hints-rules.json'),
          JSON.stringify(
            this.buildClientHintsRules(
              clientHintsPlatform,
              this.buildAcceptLanguage(effectiveFingerprint)
            ),
            null,
            2
          )
        );

        const fp = { ...effectiveFingerprint, userAgent, platform };
        fs.writeFileSync(path.join(platformFixPath, 'fingerprint.js'), `
(() => {
  const fp = ${JSON.stringify(fp)};
  const define = (target, property, value) => {
    if (value === undefined || value === null) return;
    try { Object.defineProperty(target, property, { configurable: true, get: () => value }); } catch {}
  };

  define(Navigator.prototype, 'platform', fp.platform);
  define(Navigator.prototype, 'language', fp.language);
  define(Navigator.prototype, 'languages', Object.freeze([...(fp.languages || [fp.language])]));
  define(Navigator.prototype, 'hardwareConcurrency', fp.hardwareConcurrency);
  define(Navigator.prototype, 'deviceMemory', fp.deviceMemory);
  define(Navigator.prototype, 'maxTouchPoints', fp.maxTouchPoints);
  define(Navigator.prototype, 'vendor', fp.vendor || 'Google Inc.');
  define(Navigator.prototype, 'doNotTrack', fp.doNotTrack ? '1' : null);

  if (navigator.userAgentData) {
    const uaDataProto = Object.getPrototypeOf(navigator.userAgentData);
    const hintPlatform =
      fp.platform === 'Win32' ? 'Windows' : fp.platform === 'MacIntel' ? 'macOS' : 'Linux';
    define(uaDataProto, 'platform', hintPlatform);

    const originalHighEntropy = uaDataProto.getHighEntropyValues;
    if (typeof originalHighEntropy === 'function') {
      const spoofedHints = {
        platform: hintPlatform,
        platformVersion:
          fp.platform === 'Win32' ? '10.0.0' : fp.platform === 'MacIntel' ? '14.6.1' : '',
        architecture: 'x86',
        bitness: '64',
        model: '',
        wow64: false,
      };
      uaDataProto.getHighEntropyValues = function(hints) {
        return originalHighEntropy.call(this, hints).then((values) => {
          const merged = Object.assign({}, values);
          for (const hint of (hints || [])) {
            if (Object.prototype.hasOwnProperty.call(spoofedHints, hint)) {
              merged[hint] = spoofedHints[hint];
            }
          }
          return merged;
        });
      };
    }
  }

  const screenValues = {
    width: fp.screenWidth,
    height: fp.screenHeight,
    availWidth: fp.availWidth,
    availHeight: fp.availHeight,
    colorDepth: fp.colorDepth,
    pixelDepth: fp.pixelDepth,
  };
  for (const [key, value] of Object.entries(screenValues)) define(Screen.prototype, key, value);
  define(window, 'devicePixelRatio', fp.devicePixelRatio);

  const originalGetParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(parameter) {
    if (parameter === 37445 && fp.webglVendor) return fp.webglVendor;
    if (parameter === 37446 && fp.webglRenderer) return fp.webglRenderer;
    return originalGetParameter.call(this, parameter);
  };
  if (typeof WebGL2RenderingContext !== 'undefined') {
    const originalWebGL2GetParameter = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445 && fp.webglVendor) return fp.webglVendor;
      if (parameter === 37446 && fp.webglRenderer) return fp.webglRenderer;
      return originalWebGL2GetParameter.call(this, parameter);
    };
  }

  if (fp.canvasNoise && fp.canvasNoiseSeed) {
    const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function(...args) {
      const image = originalGetImageData.apply(this, args);
      const seed = Number(fp.canvasNoiseSeed) || 1;
      for (let index = 0; index < image.data.length; index += 4096) {
        image.data[index] = (image.data[index] + ((seed + index) % 3) - 1) & 255;
      }
      return image;
    };
  }

  if (fp.audioNoise && fp.audioNoiseSeed && typeof AudioBuffer !== 'undefined') {
    const originalGetChannelData = AudioBuffer.prototype.getChannelData;
    const processed = new WeakSet();
    AudioBuffer.prototype.getChannelData = function(channel) {
      const data = originalGetChannelData.call(this, channel);
      if (!processed.has(data)) {
        const seed = Number(fp.audioNoiseSeed) || 1;
        for (let index = 0; index < data.length; index += 500) {
          data[index] += (((seed + index) % 5) - 2) * 1e-8;
        }
        processed.add(data);
      }
      return data;
    };
  }
})();
`);
        fs.writeFileSync(path.join(platformFixPath, 'x-cookie-consent.js'), `
(() => {
  const rejectPattern =
    /refuse|reject|non[- ]?essential|non n[eé]cessaires|rechazar|recusar|rifiuta|ablehnen/i;
  let observer = null;

  const dismissBlockingConsent = () => {
    const bottomBar = document.querySelector('[data-testid="BottomBar"]');
    if (!bottomBar) return false;

    const controls = Array.from(
      bottomBar.querySelectorAll('button, [role="button"]')
    );
    const rejectButton = controls.find((control) =>
      rejectPattern.test(String(control.innerText || control.textContent || '').trim())
    );
    if (!rejectButton) return false;

    rejectButton.click();
    observer?.disconnect();
    return true;
  };

  if (!dismissBlockingConsent()) {
    observer = new MutationObserver(() => dismissBlockingConsent());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.setTimeout(() => observer?.disconnect(), 30000);
  }
})();
`);
        console.log(`[Fingerprint] Runtime applied for ${platform}`);
      }

      autoStartLaunchId = options.autoStartTwitterBot
        ? require('crypto').randomUUID()
        : '';
      if (autoStartLaunchId) {
        this.pendingProfiles.add(options.profileId);
        console.log(`[Spectra AutoStart] Profile ${options.profileId} (${options.profileName})`);
        console.log(`[Spectra AutoStart] Launch ID: ${autoStartLaunchId}`);
      }

      // Create cookie-sync extension (export/import cookies for cloud sync)
      const cookieSyncPath = path.join(profilePath, '__cookie_sync_ext');
      if (fs.existsSync(cookieSyncPath)) {
        fs.rmSync(cookieSyncPath, { recursive: true, force: true });
      }
      fs.mkdirSync(cookieSyncPath, { recursive: true });

      // The generated worker contains launch-specific state (server token,
      // launch ID and OpenPost mode). Change its manifest version on every
      // launch so Chrome cannot reuse a worker created for another mode.
      const extensionVersionTime = new Date();
      const extensionVersionYear = extensionVersionTime.getUTCFullYear();
      const extensionVersionDay = Math.floor(
        (
          Date.UTC(
            extensionVersionYear,
            extensionVersionTime.getUTCMonth(),
            extensionVersionTime.getUTCDate()
          ) - Date.UTC(extensionVersionYear, 0, 0)
        ) / 86400000
      );
      const cookieSyncExtensionVersion = [
        extensionVersionYear,
        extensionVersionDay,
        extensionVersionTime.getUTCHours() * 60 + extensionVersionTime.getUTCMinutes(),
        extensionVersionTime.getUTCSeconds(),
      ].join('.');
      // A valid, fixed DER SubjectPublicKeyInfo keeps the unpacked runtime
      // extension ID stable across profiles and launches. Chrome may reject an
      // arbitrary byte string in manifest.key, which would leave Open Post on
      // X without ever loading the action controller.
      const cookieSyncManifestKey =
        'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAn1QtjQdz50DefJpeLaEMjPiR+NR/bpRV405aDQlabU0Rn7MNQAIb9QLUYFf5l5OF7z6GDlXcwnXjPGA3+EBUeJfvr7ETNsObyEa8t+8U8hC5znQZn/Q9aork0YMhhRI978yB759gT2DObLeu616XVzq/nvu0XOO/n0dUPqnhfMh6FcUy9241MxJGuyH0HiW5aOUTs2ewdiv+HfA8iybEmDn0kBCPB0vuveQxQsfduyteVd67IIet2JiyvoCbmh2Wbz7piYdfVM1cHtPnacGwFHVFwDfchxYiZ5CC35fCeSfMshUj/sNg8zVwjbsaLdnqJScpsZzdftZWkNT1duhXKwIDAQAB';

      fs.writeFileSync(path.join(cookieSyncPath, 'manifest.json'), JSON.stringify({
        manifest_version: 3,
        name: 'Cookie Sync',
        version: cookieSyncExtensionVersion,
        key: cookieSyncManifestKey,
        permissions: ['cookies', 'tabs', 'scripting', 'alarms'],
        host_permissions: ['<all_urls>'],
        background: { service_worker: 'background.js' },
        ...(sessionImportAttemptId ? {
          content_scripts: [{
            matches: [
              'https://x.com/*',
              'https://www.x.com/*',
              'https://twitter.com/*',
              'https://www.twitter.com/*',
            ],
            js: ['session-import-login.js'],
            run_at: 'document_idle',
          }],
        } : {}),
      }));
      const cookieSyncExtensionId = this.getChromeExtensionId(cookieSyncPath);
      if (!cookieSyncExtensionId) {
        throw new Error('Cookie Sync extension ID could not be derived');
      }
      const openPostBootstrapUrl = `chrome-extension://${cookieSyncExtensionId}/bootstrap.html`;

      if (targetTweetUrl) {
        fs.writeFileSync(path.join(cookieSyncPath, 'bootstrap.html'),
          '<!doctype html><meta charset="utf-8"><title>Spectra Open Post</title>' +
          '<body style="margin:0;background:#0b0d12;color:#e5e7eb;font:16px system-ui;display:grid;' +
          'place-items:center;min-height:100vh">Preparing authenticated session…' +
          '<script src="bootstrap.js"></script></body>'
        );
        fs.writeFileSync(path.join(cookieSyncPath, 'bootstrap.js'),
          `chrome.runtime.sendMessage({ type: 'spectra:open-post-bootstrap-page' }, () => {\n` +
          `  void chrome.runtime.lastError;\n` +
          `});\n`
        );
        const targetStatusId = new URL(targetTweetUrl).pathname.match(/\/status\/(\d+)/)?.[1] || '';
        const closeFallbackUrl =
          `http://127.0.0.1:${this.localServerConfig?.port || 0}/api/close-profile` +
          `?profileId=${encodeURIComponent(options.profileId)}` +
          `&token=${encodeURIComponent(this.localServerConfig?.token || '')}`;
        fs.writeFileSync(path.join(cookieSyncPath, 'open-post-actions.js'),
`(() => {
  if (window.__spectraOpenPostActionsStarted) return;
  window.__spectraOpenPostActionsStarted = true;

  const TARGET_STATUS_ID = ${JSON.stringify(targetStatusId)};
  const CLOSE_FALLBACK_URL = ${JSON.stringify(closeFallbackUrl)};
  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  function reportStage(stage, details = {}) {
    try {
      chrome.runtime.sendMessage({
        type: 'spectra:open-post-telemetry',
        stage,
        details,
      }, () => { void chrome.runtime.lastError; });
    } catch {}
  }

  function findTargetArticle() {
    const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    const exactArticle = articles.find((article) =>
      Array.from(article.querySelectorAll('a[href]')).some((link) => {
        try {
          return new URL(link.href).pathname.includes('/status/' + TARGET_STATUS_ID);
        } catch {
          return false;
        }
      })
    );
    if (exactArticle) return exactArticle;
    return location.pathname.includes('/status/' + TARGET_STATUS_ID) ? articles[0] || null : null;
  }

  async function waitForTargetArticle(timeout = 45000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const article = findTargetArticle();
      if (article) return article;
      await wait(100);
    }
    return null;
  }

  async function waitForElement(selector, root = document, timeout = 2000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const element = root.querySelector(selector);
      if (element instanceof HTMLElement) return element;
      await wait(50);
    }
    return null;
  }

  async function showResultOverlay(success, likeConfirmed, repostConfirmed) {
    document.getElementById('spectra-open-post-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'spectra-open-post-overlay';
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');
    Object.assign(overlay.style, {
      position: 'fixed',
      zIndex: '2147483647',
      top: '18px',
      left: '50%',
      width: 'min(340px, calc(100vw - 28px))',
      padding: '16px',
      borderRadius: '18px',
      border: '1px solid rgba(255,255,255,0.14)',
      background: 'linear-gradient(145deg, rgba(17,24,39,0.97), rgba(8,12,20,0.96))',
      boxShadow: '0 18px 55px rgba(0,0,0,0.48), inset 0 1px 0 rgba(255,255,255,0.08)',
      backdropFilter: 'blur(18px)',
      color: '#f8fafc',
      fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      opacity: '0',
      transform: 'translate(-50%, -12px) scale(0.96)',
      transition: 'opacity 220ms ease, transform 220ms cubic-bezier(.2,.8,.2,1)',
      pointerEvents: 'none',
    });

    const header = document.createElement('div');
    Object.assign(header.style, { display: 'flex', alignItems: 'center', gap: '12px' });

    const check = document.createElement('div');
    check.textContent = success ? '✓' : '!';
    Object.assign(check.style, {
      display: 'grid',
      placeItems: 'center',
      width: '38px',
      height: '38px',
      flex: '0 0 38px',
      borderRadius: '12px',
      background: success
        ? 'linear-gradient(135deg, #34d399, #10b981)'
        : 'linear-gradient(135deg, #fbbf24, #f97316)',
      boxShadow: success
        ? '0 8px 24px rgba(16,185,129,0.32)'
        : '0 8px 24px rgba(249,115,22,0.32)',
      color: success ? '#03291d' : '#431407',
      fontSize: '23px',
      fontWeight: '900',
    });

    const titles = document.createElement('div');
    const title = document.createElement('div');
    title.textContent = success ? 'Actions terminées' : 'Instance ignorée';
    Object.assign(title.style, { fontSize: '15px', fontWeight: '800', letterSpacing: '-0.01em' });
    const subtitle = document.createElement('div');
    subtitle.textContent = success
      ? 'Le post a bien été traité'
      : 'Une action n’a pas pu être confirmée';
    Object.assign(subtitle.style, { marginTop: '2px', color: '#94a3b8', fontSize: '12px' });
    titles.append(title, subtitle);
    header.append(check, titles);

    const actions = document.createElement('div');
    Object.assign(actions.style, {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: '8px',
      marginTop: '14px',
    });

    const createAction = (icon, label, color, background) => {
      const item = document.createElement('div');
      Object.assign(item.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '9px 10px',
        borderRadius: '11px',
        background,
        border: '1px solid rgba(255,255,255,0.07)',
        fontSize: '12px',
        fontWeight: '700',
      });
      const glyph = document.createElement('span');
      glyph.textContent = icon;
      Object.assign(glyph.style, { color, fontSize: '16px', lineHeight: '1' });
      const text = document.createElement('span');
      text.textContent = label;
      item.append(glyph, text);
      return item;
    };

    actions.append(
      createAction(
        likeConfirmed ? '♥' : '!',
        likeConfirmed ? 'Like confirmé' : 'Like non confirmé',
        likeConfirmed ? '#fb7185' : '#fbbf24',
        likeConfirmed ? 'rgba(244,63,94,0.10)' : 'rgba(245,158,11,0.10)'
      ),
      createAction(
        repostConfirmed ? '↻' : '!',
        repostConfirmed ? 'Repost confirmé' : 'Repost non confirmé',
        repostConfirmed ? '#34d399' : '#fbbf24',
        repostConfirmed ? 'rgba(16,185,129,0.10)' : 'rgba(245,158,11,0.10)'
      )
    );

    const footer = document.createElement('div');
    Object.assign(footer.style, { marginTop: '13px' });
    const closingText = document.createElement('div');
    closingText.id = 'spectra-open-post-closing-status';
    closingText.textContent = success
      ? 'Fermeture de l’instance…'
      : 'Passage à l’instance suivante…';
    Object.assign(closingText.style, {
      marginBottom: '7px',
      color: '#cbd5e1',
      fontSize: '11px',
      fontWeight: '600',
    });
    const track = document.createElement('div');
    Object.assign(track.style, {
      height: '3px',
      overflow: 'hidden',
      borderRadius: '999px',
      background: 'rgba(148,163,184,0.18)',
    });
    const progress = document.createElement('div');
    Object.assign(progress.style, {
      width: '0%',
      height: '100%',
      borderRadius: '999px',
      background: 'linear-gradient(90deg, #38bdf8, #34d399)',
      boxShadow: '0 0 12px rgba(52,211,153,0.55)',
      transition: 'width 800ms linear',
    });
    track.append(progress);
    footer.append(closingText, track);
    overlay.append(header, actions, footer);
    document.body.append(overlay);

    requestAnimationFrame(() => {
      overlay.style.opacity = '1';
      overlay.style.transform = 'translate(-50%, 0) scale(1)';
      progress.style.width = '100%';
    });
    await wait(800);
  }

  async function finishInstance(success, likeConfirmed, repostConfirmed) {
    await showResultOverlay(success, likeConfirmed, repostConfirmed);
    document.documentElement.dataset.spectraOpenPostComplete = '1';
    for (let attempt = 0; attempt < 5; attempt++) {
      const accepted = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({
            type: 'spectra:open-post-actions-complete',
            success,
          }, (response) => {
            const failed = Boolean(chrome.runtime.lastError);
            resolve(!failed && response?.accepted === true);
          });
        } catch {
          resolve(false);
        }
      });
      if (accepted) {
        const status = document.getElementById('spectra-open-post-closing-status');
        if (status) status.textContent = 'Signal de fermeture reçu…';
        window.setTimeout(() => window.location.replace(CLOSE_FALLBACK_URL), 600);
        return;
      }
      await wait(200);
    }
    const status = document.getElementById('spectra-open-post-closing-status');
    if (status) {
      status.textContent = 'Fermeture forcée…';
      status.style.color = '#fbbf24';
    }
    console.warn('[Spectra OpenPost] Completion signal was not acknowledged');
    window.location.replace(CLOSE_FALLBACK_URL);
  }

  async function run() {
    reportStage('content-loaded', { path: location.pathname });
    reportStage('actions-started');

    const article = await waitForTargetArticle();
    if (!article) {
      reportStage('target-not-found');
      console.warn('[Spectra OpenPost] Target post was not found');
      await finishInstance(false, false, false);
      return;
    }
    reportStage('target-found');

    article.scrollIntoView({ block: 'center', inline: 'nearest' });
    await wait(100);

    let likeStatus = 'already-liked';
    if (!article.querySelector('[data-testid="unlike"]')) {
      const likeButton = await waitForElement('[data-testid="like"]', article);
      if (likeButton) {
        const hasPhoto = Boolean(
          article.querySelector('[data-testid="tweetPhoto"], img[src*="/media/"]')
        );
        const likeBounds = likeButton.getBoundingClientRect();
        const actionBarOutsideViewport =
          likeBounds.top < 0 || likeBounds.bottom > window.innerHeight;
        if (hasPhoto || actionBarOutsideViewport) {
          console.log('[Spectra OpenPost] Media post detected; scrolling to actions');
          likeButton.scrollIntoView({ block: 'center', inline: 'nearest' });
          await wait(300);
        }
        likeButton.click();
        likeStatus = await waitForElement('[data-testid="unlike"]', article, 4000)
          ? 'liked'
          : 'unconfirmed';
      } else {
        likeStatus = 'button-not-found';
      }
    }
    console.log('[Spectra OpenPost] like: ' + likeStatus);
    reportStage('like-result', { status: likeStatus });

    await wait(200);

    let repostStatus = 'already-reposted';
    if (!article.querySelector('[data-testid="unretweet"]')) {
      const repostButton = await waitForElement('[data-testid="retweet"]', article);
      if (repostButton) {
        repostButton.click();
        const confirmButton = await waitForElement('[data-testid="retweetConfirm"]');
        if (confirmButton) {
          confirmButton.click();
          repostStatus = await waitForElement('[data-testid="unretweet"]', article, 4000)
            ? 'reposted'
            : 'unconfirmed';
        } else {
          repostStatus = 'confirmation-not-found';
        }
      } else {
        repostStatus = 'button-not-found';
      }
    }
    console.log('[Spectra OpenPost] repost: ' + repostStatus);
    reportStage('repost-result', { status: repostStatus });

    const likeConfirmed = likeStatus === 'liked' || likeStatus === 'already-liked';
    const repostConfirmed = repostStatus === 'reposted' || repostStatus === 'already-reposted';
    const success = likeConfirmed && repostConfirmed;
    await finishInstance(success, likeConfirmed, repostConfirmed);
  }

  run().catch(async (error) => {
    console.error('[Spectra OpenPost] Actions failed:', error);
    await finishInstance(false, false, false);
  });
})();`
        );
      }

      if (sessionImportAttemptId) {
        fs.writeFileSync(path.join(cookieSyncPath, 'session-import-login.js'),
`(() => {
  if (window.__spectraSessionImportInstalled) return;
  window.__spectraSessionImportInstalled = true;
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const visible = (element) => element instanceof HTMLElement &&
    element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
  const findVisible = (selectors) => {
    for (const selector of selectors) {
      const match = Array.from(document.querySelectorAll(selector)).find(visible);
      if (match) return match;
    }
    return null;
  };
  const pageText = () => String(document.body?.innerText || '').toLowerCase();
  const isHome = () => /\\/(home|compose\\/post)(?:[/?#]|$)/.test(location.pathname) ||
    Boolean(document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]'));
  const isManualChallenge = () => {
    const text = pageText();
    return Boolean(
      document.querySelector('iframe[src*="captcha"], [data-testid*="captcha"]') ||
      /captcha|arkose|verify your identity|check your email|email address|phone number|text message|sms|security key|backup code/.test(text)
    );
  };
  async function waitFor(predicate, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = predicate();
      if (result) return result;
      await wait(150);
    }
    return null;
  }
  function setInputValue(input, value) {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function clickButton(labels) {
    const wanted = labels.map(label => label.toLowerCase());
    const button = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(visible)
      .find(candidate => wanted.includes(String(candidate.textContent || '').trim().toLowerCase()));
    if (!button) return false;
    button.click();
    return true;
  }
  function pressEnter(input) {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  }
  function decodeBase32(secret) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const character of secret.replace(/=+$/g, '')) {
      const value = alphabet.indexOf(character);
      if (value < 0) throw new Error('invalid-totp-secret');
      bits += value.toString(2).padStart(5, '0');
    }
    const bytes = [];
    for (let index = 0; index + 8 <= bits.length; index += 8) {
      bytes.push(parseInt(bits.slice(index, index + 8), 2));
    }
    return new Uint8Array(bytes);
  }
  async function totpCode(secret) {
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setUint32(4, Math.floor(Date.now() / 30000), false);
    const key = await crypto.subtle.importKey(
      'raw', decodeBase32(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
    );
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, buffer));
    const offset = signature[signature.length - 1] & 15;
    const value = (
      ((signature[offset] & 127) << 24) |
      ((signature[offset + 1] & 255) << 16) |
      ((signature[offset + 2] & 255) << 8) |
      (signature[offset + 3] & 255)
    ) % 1000000;
    return String(value).padStart(6, '0');
  }
  async function report(status, message = '') {
    await chrome.runtime.sendMessage({ type: 'spectra:session-import-status', status, message })
      .catch(() => {});
  }
  async function run(credentials) {
    if (window.__spectraSessionImportRunning) return;
    window.__spectraSessionImportRunning = true;
    try {
      if (isHome()) {
        await report('success', 'Session X déjà connectée');
        return;
      }
      await report('entering-username', 'Saisie de l’identifiant X');
      const username = await waitFor(() => findVisible([
        'input[autocomplete="username"]', 'input[name="text"]'
      ]), 45000);
      if (!username) {
        await report(isManualChallenge() ? 'manual' : 'failed',
          isManualChallenge() ? 'Vérification manuelle requise' : 'Champ identifiant introuvable');
        return;
      }
      setInputValue(username, credentials.username);
      if (!clickButton(['next', 'suivant'])) pressEnter(username);

      await report('entering-password', 'Attente du champ mot de passe');
      const passwordState = await waitFor(() => {
        const password = findVisible(['input[name="password"]', 'input[autocomplete="current-password"]']);
        if (password) return { password };
        if (isManualChallenge()) return { manual: true };
        return null;
      }, 30000);
      if (!passwordState || passwordState.manual) {
        await report(passwordState?.manual ? 'manual' : 'failed',
          passwordState?.manual ? 'Vérification manuelle requise' : 'Champ mot de passe introuvable');
        return;
      }
      setInputValue(passwordState.password, credentials.password);
      if (!clickButton(['log in', 'sign in', 'se connecter', 'connexion'])) {
        pressEnter(passwordState.password);
      }

      await report('waiting', 'Vérification de la connexion');
      const afterPassword = await waitFor(() => {
        if (isHome()) return { success: true };
        const otp = findVisible([
          'input[data-testid="ocfEnterTextTextInput"]',
          'input[autocomplete="one-time-code"]',
          'input[inputmode="numeric"]'
        ]);
        if (otp && /authentication code|code generator|authentification|application d.authentification/.test(pageText())) {
          return { otp };
        }
        if (isManualChallenge()) return { manual: true };
        if (/wrong password|incorrect password|could not log you in|mot de passe incorrect/.test(pageText())) {
          return { failed: true };
        }
        return null;
      }, 45000);
      if (afterPassword?.success) {
        await report('success', 'Connexion X confirmée');
        return;
      }
      if (!afterPassword || afterPassword.manual || afterPassword.failed || !afterPassword.otp) {
        await report(afterPassword?.manual ? 'manual' : 'failed',
          afterPassword?.manual ? 'Vérification manuelle requise' : 'Connexion X non confirmée');
        return;
      }

      await report('entering-totp', 'Génération et saisie du code 2FA');
      setInputValue(afterPassword.otp, await totpCode(credentials.totpSecret));
      if (!clickButton(['next', 'suivant', 'verify', 'vérifier'])) pressEnter(afterPassword.otp);
      const finalState = await waitFor(() => {
        if (isHome()) return 'success';
        if (isManualChallenge()) return 'manual';
        if (/incorrect|invalid|expired|wrong code|code erroné/.test(pageText())) return 'failed';
        return null;
      }, 45000);
      await report(
        finalState || 'failed',
        finalState === 'success'
          ? 'Connexion X et cookies confirmés'
          : finalState === 'manual'
            ? 'Vérification manuelle requise'
            : 'Code 2FA ou connexion non confirmé'
      );
    } catch {
      await report('failed', 'Échec inattendu de la connexion X');
    } finally {
      credentials.password = '';
      credentials.totpSecret = '';
      window.__spectraSessionImportRunning = false;
    }
  }
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'spectra:session-import-credentials' && message.credentials) {
      run(message.credentials);
    }
  });
})();`
        );
      }

      // Prefer the last positively authenticated X snapshot. A current snapshot
      // without auth may come from a transient logout or another stale PC.
      const syncedCookiesPath = path.join(profilePath, 'synced_cookies.json');
      const authenticatedCookiesPath = path.join(profilePath, 'authenticated_cookies.json');
      let hasStagedCookies = false;
      const syncedIsAuthenticated = fs.existsSync(syncedCookiesPath) &&
        this.fileHasAuthenticatedXSession(syncedCookiesPath);
      const protectedIsAuthenticated = fs.existsSync(authenticatedCookiesPath) &&
        this.fileHasAuthenticatedXSession(authenticatedCookiesPath);
      const syncedIsNewer = syncedIsAuthenticated && protectedIsAuthenticated &&
        fs.statSync(syncedCookiesPath).mtimeMs >= fs.statSync(authenticatedCookiesPath).mtimeMs;
      const cookieImportPath = syncedIsAuthenticated && (!protectedIsAuthenticated || syncedIsNewer)
        ? syncedCookiesPath
        : protectedIsAuthenticated
          ? authenticatedCookiesPath
          : syncedCookiesPath;
      if (fs.existsSync(cookieImportPath)) {
        try {
          const cookies = fs.readFileSync(cookieImportPath, 'utf8');
          const parsedCookies = JSON.parse(cookies);
          hasStagedCookies = Array.isArray(parsedCookies) && parsedCookies.length > 0;
          fs.writeFileSync(path.join(cookieSyncPath, 'cookies.json'), cookies);
          console.log(
            `[CookieSync] Loaded ${cookieImportPath === authenticatedCookiesPath ? 'protected authenticated' : 'current'} cookies for import`
          );
        } catch {}
      } else {
        fs.writeFileSync(path.join(cookieSyncPath, 'cookies.json'), '[]');
      }

      fs.writeFileSync(path.join(cookieSyncPath, 'background.js'),
`const PROFILE_ID = ${JSON.stringify(options.profileId)};
const PROFILE_NAME = ${JSON.stringify(options.profileName)};
const LAUNCH_ID = ${JSON.stringify(autoStartLaunchId)};
const OPEN_POST_MODE = ${JSON.stringify(Boolean(targetTweetUrl))};
const HAS_STAGED_COOKIES = ${JSON.stringify(hasStagedCookies)};
const SESSION_IMPORT_ATTEMPT_ID = ${JSON.stringify(sessionImportAttemptId)};
const SESSION_IMPORT_MODE = Boolean(SESSION_IMPORT_ATTEMPT_ID);
const MANAGED_STARTUP_MODE = OPEN_POST_MODE || Boolean(LAUNCH_ID) || SESSION_IMPORT_MODE;
const ENFORCE_SINGLE_TAB = OPEN_POST_MODE || Boolean(LAUNCH_ID);
const SERVER = 'http://127.0.0.1:${this.localServerConfig?.port || 0}';
const SERVER_TOKEN = ${JSON.stringify(this.localServerConfig?.token || '')};
let bootstrapPromise = null;
let bootstrapComplete = false;
let exportInProgress = false;
let exportAgain = false;
let exportTimer = null;
let authenticationRetryTimer = null;
let authenticatedSnapshotConfirmed = false;
let retainedTabId = null;
let cookiesImported = false;
let cookieImportPromise = null;
let venusConfirmationReported = false;
let openPostCompleted = false;
let sessionImportStarted = false;
const BOOTSTRAP_ATTEMPTS = 5;
const RETRY_DELAYS = [1000, 2000, 4000, 8000, 12000];
const WATCHDOG_DEADLINE = Date.now() + (OPEN_POST_MODE ? 120000 : 60000);

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const tabUrl = (tab) => String(tab?.pendingUrl || tab?.url || '');
const isXTab = (tab) => /^https:\\/\\/(?:www\\.)?(?:x|twitter)\\.com\\//i.test(tabUrl(tab));
const isStartupJunkTab = (tab) => {
  const url = tabUrl(tab);
  return url === 'about:blank' ||
    /^chrome-extension:\\/\\/[^/]+\\/html\\/initialSetup\\.html(?:[?#]|$)/i.test(url);
};

async function reportLaunchStatus(status, details = {}) {
  const response = await fetch(SERVER + '/api/launch-status', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + SERVER_TOKEN
    },
    body: JSON.stringify({ profileId: PROFILE_ID, launchId: LAUNCH_ID, status, details }),
  });
  if (!response.ok) throw new Error('Launch status server returned ' + response.status);
}

async function reportLifecycleEvent(event, details = {}) {
  try {
    await fetch(SERVER + '/api/lifecycle-event', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + SERVER_TOKEN
      },
      body: JSON.stringify({
        profileId: PROFILE_ID,
        launchId: LAUNCH_ID,
        event,
        details,
      }),
    });
  } catch {}
}

if (chrome.tabs.onRemoved?.addListener) {
  chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    reportLifecycleEvent('tab-removed', {
      tabId,
      windowId: removeInfo?.windowId,
      isWindowClosing: removeInfo?.isWindowClosing === true,
    });
  });
}

if (chrome.windows?.onRemoved?.addListener) {
  chrome.windows.onRemoved.addListener((windowId) => {
    reportLifecycleEvent('window-removed', { windowId });
  });
}

async function reportSessionImportStatus(status, message = '') {
  const response = await fetch(SERVER + '/api/session-import-status', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + SERVER_TOKEN
    },
    body: JSON.stringify({
      profileId: PROFILE_ID,
      attemptId: SESSION_IMPORT_ATTEMPT_ID,
      status,
      message,
    }),
  });
  if (!response.ok) throw new Error('Session import status server returned ' + response.status);
}

async function startSessionImport(tabId) {
  if (!SESSION_IMPORT_MODE || sessionImportStarted) return;
  sessionImportStarted = true;
  try {
    const response = await fetch(
      SERVER + '/api/session-import-credentials?attemptId=' +
      encodeURIComponent(SESSION_IMPORT_ATTEMPT_ID) +
      '&profileId=' + encodeURIComponent(PROFILE_ID),
      { headers: { 'Authorization': 'Bearer ' + SERVER_TOKEN } }
    );
    if (!response.ok) throw new Error('Credentials are unavailable');
    const credentials = await response.json();
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: 'spectra:session-import-credentials',
          credentials,
        });
        credentials.password = '';
        credentials.totpSecret = '';
        return;
      } catch {
        await wait(500);
      }
    }
    throw new Error('Login page did not accept credentials');
  } catch {
    await reportSessionImportStatus('failed', 'Impossible de démarrer la connexion X').catch(() => {});
  }
}

async function requestProfileClose(source) {
  if (!OPEN_POST_MODE) {
    throw new Error('Profile close is only available in OpenPost mode');
  }
  await flushCookiesBeforeClose();
  const response = await fetch(SERVER + '/api/close-profile', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + SERVER_TOKEN
    },
    body: JSON.stringify({ profileId: PROFILE_ID }),
  });
  if (!response.ok) throw new Error('Close-profile server returned ' + response.status);
  openPostCompleted = true;
  chrome.alarms.clear('spectra-startup-watchdog').catch(() => {});
  console.log('[Spectra OpenPost] Main-process close requested via ' + source);
}

// Import cookies from cookies.json at startup
async function importCookies() {
  try {
    const response = await fetch(chrome.runtime.getURL('cookies.json'));
    if (!response.ok) return;
    const cookies = await response.json();
    if (!Array.isArray(cookies) || cookies.length === 0) return;
    let imported = 0;
    for (const c of cookies) {
      try {
        const details = {
          url: 'http' + (c.secure ? 's' : '') + '://' + (c.domain || '').replace(/^\\./, '') + (c.path || '/'),
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          secure: c.secure || false,
          httpOnly: c.httpOnly || false,
          sameSite: c.sameSite === 'None' ? 'no_restriction' : (c.sameSite || 'lax').toLowerCase(),
        };
        if (c.expires && c.expires > 0) details.expirationDate = c.expires;
        else if (c.expirationDate && c.expirationDate > 0) details.expirationDate = c.expirationDate;
        await Promise.race([
          chrome.cookies.set(details),
          wait(1500).then(() => {
            throw new Error('Cookie import timed out: ' + c.name);
          }),
        ]);
        imported++;
      } catch (e) {}
    }
    console.log('[CookieSync] Imported ' + imported + '/' + cookies.length + ' cookies');
  } catch (e) {}
}

async function ensureCookiesImported() {
  if (cookiesImported) return;
  if (!cookieImportPromise) {
    cookieImportPromise = importCookies()
      .then(() => {
        cookiesImported = true;
      })
      .finally(() => {
        cookieImportPromise = null;
      });
  }
  await cookieImportPromise;
}

async function openStartUrl() {
  try {
    const response = await fetch(chrome.runtime.getURL('start_url.json'));
    if (!response.ok) throw new Error('start_url.json returned ' + response.status);
    const { startUrl, closeOtherTabs, likeTargetPost } = await response.json();
    if (!/^https?:\\/\\//i.test(startUrl || '')) throw new Error('Invalid startup URL');

    const initialTabs = await chrome.tabs.query({});
    let target = closeOtherTabs && LAUNCH_ID
      ? initialTabs.find((tab) => tab.id && isXTab(tab))
      : initialTabs.find((tab) => tab.id && tabUrl(tab).startsWith(startUrl));

    if (!target?.id) {
      target = await chrome.tabs.create({ url: startUrl, active: true });
      if (!target?.id) throw new Error('Dedicated startup tab was not created');
      console.log('[Spectra AutoStart] X tab created: ' + target.id);
    } else {
      await chrome.tabs.update(target.id, { url: startUrl, active: true });
      console.log('[Spectra AutoStart] Existing X tab retained: ' + target.id);
    }

    retainedTabId = target.id;
    console.log('[Spectra AutoStart] Profile ' + PROFILE_ID + ' (' + PROFILE_NAME + ')');

    const closeOtherProfileTabs = async () => {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (!tab.id || tab.id === retainedTabId) continue;
        try {
          await chrome.tabs.remove(tab.id);
          console.log('[Spectra AutoStart] Extra tab closed: ' + tab.id + ' ' + tabUrl(tab));
        } catch (error) {
          const stillExists = await chrome.tabs.get(tab.id).catch(() => null);
          if (stillExists) throw error;
        }
      }
      const remaining = await chrome.tabs.query({});
      const extras = remaining.filter((tab) => tab.id && tab.id !== retainedTabId);
      if (extras.length > 0) {
        throw new Error('Extra tabs remain after cleanup: ' + extras.map((tab) => tab.id).join(','));
      }
    };

    if (closeOtherTabs) await closeOtherProfileTabs();

    const loadDeadline = Date.now() + 30000;
    let retained = null;
    while (Date.now() < loadDeadline) {
      retained = await chrome.tabs.get(retainedTabId).catch(() => null);
      if (!retained) throw new Error('Retained startup tab disappeared');
      if (retained.status === 'complete' && isXTab(retained)) break;
      await wait(250);
    }
    if (!retained || retained.status !== 'complete' || !isXTab(retained)) {
      throw new Error('Retained X tab did not finish loading');
    }
    console.log('[Spectra AutoStart] X tab loaded: ' + retainedTabId);

    await wait(500);
    if (closeOtherTabs) await closeOtherProfileTabs();

    await chrome.scripting.executeScript({
      target: { tabId: retainedTabId },
      world: 'MAIN',
      func: (launchId, tabId) => {
        sessionStorage.setItem('spectra:startup-tabs-ready:' + launchId, String(tabId));
      },
      args: [LAUNCH_ID, retainedTabId],
    });
    console.log('[Spectra AutoStart] startup-tabs-ready written for tab: ' + retainedTabId);

    const confirmedTab = await chrome.tabs.get(retainedTabId).catch(() => null);
    const finalTabs = await chrome.tabs.query({});
    if (
      !confirmedTab ||
      confirmedTab.status !== 'complete' ||
      !isXTab(confirmedTab) ||
      (closeOtherTabs && finalTabs.some((tab) => tab.id !== retainedTabId))
    ) {
      throw new Error('Startup tab confirmation failed');
    }

    return retainedTabId;
  } catch (error) {
    console.error('[Spectra AutoStart] Bootstrap failed: ' + (error?.message || error));
    throw error;
  }
}

async function resumeManualStartupAfterCookieImport() {
  if (!HAS_STAGED_COOKIES || MANAGED_STARTUP_MODE) return null;

  const response = await fetch(chrome.runtime.getURL('start_url.json'));
  if (!response.ok) throw new Error('start_url.json returned ' + response.status);
  const { startUrl } = await response.json();
  if (!/^https?:\\/\\//i.test(startUrl || '')) throw new Error('Invalid startup URL');

  // A manual launch may restore several user tabs. Only reuse Spectra's
  // temporary blank/setup tab and never close or replace an existing user tab.
  const tabs = await chrome.tabs.query({});
  const temporaryTab = tabs.find((tab) => tab.id && isStartupJunkTab(tab));
  if (!temporaryTab?.id) {
    console.log('[Spectra FastStart] Existing manual session retained');
    return null;
  }

  await chrome.tabs.update(temporaryTab.id, { url: startUrl, active: true });
  console.log('[Spectra FastStart] Temporary tab resumed immediately: ' + temporaryTab.id);
  return temporaryTab.id;
}

function bootstrap() {
  if (bootstrapComplete && retainedTabId) return Promise.resolve(retainedTabId);
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      let lastError = null;
      for (let attempt = 1; attempt <= BOOTSTRAP_ATTEMPTS; attempt++) {
        console.log('[Spectra AutoStart] Bootstrap attempt ' + attempt + '/' + BOOTSTRAP_ATTEMPTS);
        try {
          await ensureCookiesImported();
          const tabId = await openStartUrl();
          if (!tabId) throw new Error('openStartUrl returned no retainedTabId');
          retainedTabId = tabId;
          if (LAUNCH_ID) await reportLaunchStatus('bootstrap-confirmed', { tabId });
          bootstrapComplete = true;
          console.log('[Spectra AutoStart] Bootstrap confirmed: ' + tabId);
          return tabId;
        } catch (error) {
          bootstrapComplete = false;
          lastError = error;
          console.error('[Spectra AutoStart] Bootstrap failed: ' + (error?.message || error));
          if (attempt < BOOTSTRAP_ATTEMPTS || Date.now() <= WATCHDOG_DEADLINE) {
            const delay = RETRY_DELAYS[attempt - 1] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
            console.log('[Spectra AutoStart] Bootstrap retry scheduled in ' + delay + 'ms');
            await wait(delay);
          }
        }
      }
      throw lastError || new Error('Bootstrap exhausted');
    })().finally(() => {
      bootstrapPromise = null;
    });
  }
  return bootstrapPromise;
}

async function startOpenPostActions(tabId) {
  if (!OPEN_POST_MODE || !tabId) return;
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['open-post-actions.js'],
  });
  await reportLifecycleEvent('open-post-actions-injected', { tabId });
  console.log('[Spectra OpenPost] Action script injected explicitly into tab: ' + tabId);
}

async function runStartupWatchdog() {
  if (openPostCompleted || Date.now() > WATCHDOG_DEADLINE) {
    chrome.alarms.clear('spectra-startup-watchdog').catch(() => {});
    return;
  }
  try {
    if (ENFORCE_SINGLE_TAB) {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (
          !retainedTabId ||
          !tab.id ||
          tab.id === retainedTabId ||
          (!bootstrapComplete && !isStartupJunkTab(tab))
        ) continue;
        await chrome.tabs.remove(tab.id).catch(() => {});
        console.log('[Spectra AutoStart] Extra tab closed: ' + tab.id + ' ' + tabUrl(tab));
      }
    }

    if (bootstrapComplete) {
      const retained = retainedTabId
        ? await chrome.tabs.get(retainedTabId).catch(() => null)
        : null;
      if (!retained || !isXTab(retained)) {
        bootstrapComplete = false;
        retainedTabId = null;
        console.warn('[Spectra AutoStart] Watchdog found no retained X tab');
      } else if (OPEN_POST_MODE) {
        const results = await chrome.scripting.executeScript({
          target: { tabId: retainedTabId },
          func: () => document.documentElement.dataset.spectraOpenPostComplete === '1',
        }).catch(() => []);
        if (results[0]?.result === true) {
          console.log('[Spectra OpenPost] Completion marker detected');
          await requestProfileClose('watchdog');
          return;
        }
      } else if (LAUNCH_ID && !venusConfirmationReported) {
        const results = await chrome.scripting.executeScript({
          target: { tabId: retainedTabId },
          world: 'MAIN',
          func: (launchId) => ({
            confirmed: sessionStorage.getItem('spectra:autostart-confirmed:' + launchId) === '1',
            manualPause: sessionStorage.getItem('spectra:autostart-manual-pause:' + launchId) === '1',
          }),
          args: [LAUNCH_ID],
        }).catch(() => []);
        const status = results[0]?.result;
        if (status?.confirmed) {
          await reportLaunchStatus('venus-confirmed', { tabId: retainedTabId });
          venusConfirmationReported = true;
          console.log('[Spectra AutoStart] VenusBot confirmation forwarded');
        } else if (status?.manualPause) {
          await reportLaunchStatus('manual-pause-preserved', { tabId: retainedTabId });
          venusConfirmationReported = true;
        }
      }
    }

    if (!openPostCompleted && !bootstrapComplete && !bootstrapPromise) {
      bootstrap().catch((error) => {
        console.error('[Spectra AutoStart] Watchdog bootstrap failed:', error);
      });
    }
  } catch (error) {
    console.warn('[Spectra AutoStart] Watchdog error:', error);
  } finally {
    if (Date.now() <= WATCHDOG_DEADLINE) setTimeout(runStartupWatchdog, 1000);
  }
}

chrome.tabs.onCreated.addListener((tab) => {
  if (
    ENFORCE_SINGLE_TAB &&
    Date.now() <= WATCHDOG_DEADLINE &&
    retainedTabId &&
    tab?.id &&
    tab.id !== retainedTabId
  ) {
    chrome.tabs.remove(tab.id).then(() => {
      console.log('[Spectra AutoStart] Extra tab closed: ' + tab.id + ' ' + tabUrl(tab));
    }).catch(() => {});
  }
});

chrome.runtime.onMessage?.addListener((message, sender, sendResponse) => {
  if (OPEN_POST_MODE && message?.type === 'spectra:open-post-telemetry') {
    const stage = typeof message.stage === 'string'
      ? message.stage.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48)
      : '';
    if (stage) {
      reportLifecycleEvent('open-post-' + stage, {
        tabId: sender.tab?.id,
        ...(message.details && typeof message.details === 'object' ? message.details : {}),
      });
    }
    sendResponse({ accepted: Boolean(stage) });
    return;
  }
  if (OPEN_POST_MODE && message?.type === 'spectra:open-post-bootstrap-page') {
    reportLifecycleEvent('open-post-bootstrap-page', { tabId: sender.tab?.id });
    sendResponse({ accepted: true });
    bootstrap()
      .then((tabId) => startOpenPostActions(tabId))
      .catch((error) => {
        reportLifecycleEvent('open-post-bootstrap-page-failed', {
          error: String(error?.message || error).slice(0, 240),
        });
        console.error('[Spectra OpenPost] Explicit bootstrap failed:', error);
      });
    return;
  }
  if (message?.type === 'spectra:session-import-status' && SESSION_IMPORT_MODE) {
    reportSessionImportStatus(message.status, message.message)
      .then(() => sendResponse({ accepted: true }))
      .catch(() => sendResponse({ accepted: false }));
    return true;
  }
  if (
    !OPEN_POST_MODE ||
    message?.type !== 'spectra:open-post-actions-complete' ||
    !sender.tab?.id
  ) return;
  sendResponse({ accepted: true });
  (async () => {
    openPostCompleted = true;
    chrome.alarms.clear('spectra-startup-watchdog').catch(() => {});
    console.log('[Spectra OpenPost] Actions finished; saving session before closing instance');
    try {
      await requestProfileClose('message');
    } catch (error) {
      if (typeof sender.tab.windowId === 'number') {
        await chrome.windows.remove(sender.tab.windowId);
      } else {
        throw error;
      }
    }
  })().catch((error) => {
    console.warn('[Spectra OpenPost] Could not close completed instance:', error);
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (MANAGED_STARTUP_MODE && alarm.name === 'spectra-startup-watchdog') runStartupWatchdog();
});

// Export all cookies to local server
async function exportCookies() {
  if (exportInProgress) {
    exportAgain = true;
    return;
  }
  exportInProgress = true;
  try {
    const cookies = await chrome.cookies.getAll({});
    const response = await fetch(SERVER + '/api/save-cookies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SERVER_TOKEN },
      body: JSON.stringify({ profileId: PROFILE_ID, cookies }),
    });
    if (!response.ok) throw new Error('Cookie sync server returned ' + response.status);
    const result = typeof response.json === 'function'
      ? await response.json().catch(() => ({}))
      : {};
    if (result.authenticated === true) {
      authenticatedSnapshotConfirmed = true;
      if (authenticationRetryTimer) {
        clearTimeout(authenticationRetryTimer);
        authenticationRetryTimer = null;
      }
      console.log('[CookieSync] Authenticated X snapshot acknowledged by Spectra');
      if (result.notificationRequired === true) {
        await showAuthenticatedSnapshotConfirmation();
      }
    }
    console.log('[CookieSync] Exported ' + cookies.length + ' cookies');
  } catch (e) {
    console.warn('[CookieSync] Export failed', e);
    if (!authenticatedSnapshotConfirmed && !authenticationRetryTimer) {
      authenticationRetryTimer = setTimeout(() => {
        authenticationRetryTimer = null;
        exportCookies();
      }, 500);
    }
  } finally {
    exportInProgress = false;
    if (exportAgain) {
      exportAgain = false;
      scheduleExport(100);
    }
  }
}

async function flushCookiesBeforeClose() {
  if (exportTimer) {
    clearTimeout(exportTimer);
    exportTimer = null;
  }
  const deadline = Date.now() + 2000;
  while (exportInProgress && Date.now() < deadline) {
    await wait(25);
  }
  await exportCookies();
}

function scheduleExport(delay = 150) {
  if (exportTimer) clearTimeout(exportTimer);
  exportTimer = setTimeout(() => {
    exportTimer = null;
    exportCookies();
  }, delay);
}

async function showAuthenticatedSnapshotConfirmation() {
  if (OPEN_POST_MODE) return;
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs.filter((candidate) => candidate.id && isXTab(candidate))) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const existing = document.getElementById('spectra-session-saved-toast');
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.id = 'spectra-session-saved-toast';
        toast.textContent = '✓ Session X enregistrée';
        Object.assign(toast.style, {
          position: 'fixed',
          top: '20px',
          right: '20px',
          zIndex: '2147483647',
          padding: '12px 18px',
          borderRadius: '12px',
          background: 'rgba(15, 23, 42, 0.96)',
          border: '1px solid rgba(74, 222, 128, 0.55)',
          boxShadow: '0 12px 35px rgba(0, 0, 0, 0.35)',
          color: '#86efac',
          font: '600 14px/1.2 system-ui, sans-serif',
        });
        document.documentElement.appendChild(toast);
        window.setTimeout(() => toast.remove(), 4500);
      },
    }).catch(() => {});
  }
}

if (MANAGED_STARTUP_MODE) {
  chrome.alarms.create('spectra-startup-watchdog', {
    delayInMinutes: 0.5,
    periodInMinutes: 0.5,
  });
  bootstrap().then(async (tabId) => {
    await startSessionImport(tabId);
    await startOpenPostActions(tabId);
  }).catch((error) => {
    console.error('[Spectra AutoStart] Initial bootstrap exhausted:', error);
  });
  runStartupWatchdog();
} else {
  importCookies()
    .then(async () => {
      cookiesImported = true;
      await resumeManualStartupAfterCookieImport();
    })
    .catch((error) => {
      console.warn('[Spectra FastStart] Cookie restore failed:', error);
    });
}
chrome.runtime.onStartup.addListener(() => {
  if (MANAGED_STARTUP_MODE) {
    bootstrap().catch((error) => console.error('[Spectra AutoStart] Startup bootstrap exhausted:', error));
  }
});
chrome.runtime.onInstalled.addListener(() => {
  if (MANAGED_STARTUP_MODE) {
    bootstrap().catch((error) => console.error('[Spectra AutoStart] Install bootstrap exhausted:', error));
  }
});
chrome.cookies.onChanged.addListener((changeInfo) => {
  const authenticationCookieChanged =
    changeInfo?.cookie?.name === 'auth_token' || changeInfo?.cookie?.name === 'ct0';
  if (authenticationCookieChanged) {
    exportCookies();
  } else {
    scheduleExport(150);
  }
});
chrome.windows?.onRemoved?.addListener(() => {
  flushCookiesBeforeClose().catch((error) => {
    console.warn('[CookieSync] Final window-close snapshot failed:', error);
  });
});
chrome.runtime.onSuspend.addListener(() => exportCookies());

// Frequent safety snapshot so every launch mode has a fresh portable session.
setInterval(exportCookies, 1000);

// Capture the initial imported/native state immediately after startup settles.
setTimeout(exportCookies, 1000);
`
      );
      console.log(`[CookieSync] Created cookie sync extension`);

      // Use per-profile immutable copies so an update or autostart change cannot
      // alter extension files used by another running profile.
      const runtimeExtensionsRoot = path.join(profilePath, '__runtime_extensions');
      fs.rmSync(runtimeExtensionsRoot, { recursive: true, force: true });
      fs.mkdirSync(runtimeExtensionsRoot, { recursive: true });

      // Collect extensions
      const extPaths: string[] = [cookieSyncPath];
      let shouldAutoStartTwitterBot = false;
      let shadowbanSetupUrl: string | null = null;
      if (platformFixPath) extPaths.push(platformFixPath);
      if (options.extensionPaths && options.extensionPaths.length > 0) {
        const validPaths = options.extensionPaths.flatMap((p, index) => {
          const manifestPath = path.join(p, 'manifest.json');
          const exists = fs.existsSync(manifestPath);
          console.log(`[Extensions] ${p} — manifest exists: ${exists}`);
          if (!exists) return [];
          let extensionName = '';
          try {
            const extensionManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            extensionName = String(extensionManifest.name || '').toLowerCase();
          } catch (error) {
            console.warn(`[Extensions] Could not inspect extension: ${p}`, error);
          }
          if (
            (targetTweetUrl || options.autoStartTwitterBot === true) &&
            extensionName.includes('shadowban scanner')
          ) {
            console.log(
              targetTweetUrl
                ? '[Extensions] Shadowban Scanner skipped for Open post'
                : '[Extensions] Shadowban Scanner skipped for Open Selected'
            );
            return [];
          }
          const runtimePath = this.createRuntimeExtensionCopy(runtimeExtensionsRoot, p, index);
          if (extensionName.includes('shadowban scanner')) {
            const extensionId = this.getChromeExtensionId(runtimePath);
            if (extensionId) {
              shadowbanSetupUrl =
                `chrome-extension://${extensionId}/html/initialSetup.html`;
            }
          }
          if (this.configureTwitterAutoReplyAutostart(
            runtimePath,
            options.autoStartTwitterBot === true,
            {
              launchId: autoStartLaunchId,
              profileId: options.profileId,
              profileName: options.profileName,
              profilePath,
            }
          )) {
            shouldAutoStartTwitterBot = options.autoStartTwitterBot === true;
          }
          return [runtimePath];
        });
        extPaths.push(...validPaths);
      }
      if (options.autoStartTwitterBot && !shouldAutoStartTwitterBot) {
        const twitterAutoReplyPath = this.findTwitterAutoReplyExtensionPath();
        if (twitterAutoReplyPath) {
          const runtimePath = this.createRuntimeExtensionCopy(runtimeExtensionsRoot, twitterAutoReplyPath, extPaths.length);
          const configured = this.configureTwitterAutoReplyAutostart(runtimePath, true, {
            launchId: autoStartLaunchId,
            profileId: options.profileId,
            profileName: options.profileName,
            profilePath,
          });
          if (configured) {
            shouldAutoStartTwitterBot = true;
            extPaths.push(runtimePath);
            console.log(`[Extensions] Auto-start extension added: ${runtimePath}`);
          }
        }
      }
      if (options.autoStartTwitterBot && !shouldAutoStartTwitterBot) {
        throw new Error(
          'VenusBot is unavailable or incompatible; Open Selected cannot start this profile'
        );
      }
      // Determine start URL
      const isValidUrl = (url: string) => url && (url.startsWith('https://') || url.startsWith('http://'));
      const isLegacyGoogleStartUrl = (url: string) =>
        /^https?:\/\/(?:www\.)?google\.[^/]+\/?$/i.test(url.trim());
      const configuredLastUrl = options.lastUrl || '';
      let startUrl = sessionImportAttemptId
        ? 'https://x.com/i/flow/login'
        : targetTweetUrl ||
          (
            isValidUrl(configuredLastUrl) && !isLegacyGoogleStartUrl(configuredLastUrl)
              ? configuredLastUrl
              : 'https://x.com/home'
          );
      const lastUrlPath = path.join(profilePath, 'last_url.txt');
      if (!options.autoStartTwitterBot && !targetTweetUrl && !sessionImportAttemptId && fs.existsSync(lastUrlPath)) {
        try {
          const savedUrl = fs.readFileSync(lastUrlPath, 'utf8').trim();
          if (isValidUrl(savedUrl) && !isLegacyGoogleStartUrl(savedUrl)) {
            startUrl = savedUrl;
          }
        } catch {}
      }
      if (shouldAutoStartTwitterBot) {
        startUrl = 'https://x.com/i/chat/requests';
      }
      fs.writeFileSync(
        path.join(cookieSyncPath, 'start_url.json'),
        JSON.stringify({
          startUrl,
          closeOtherTabs: options.autoStartTwitterBot === true || Boolean(targetTweetUrl),
          likeTargetPost: Boolean(targetTweetUrl),
          launchId: autoStartLaunchId,
        })
      );

      if (extPaths.length > 0) {
        const uniqueExtPaths = Array.from(new Set(extPaths));
        args.push(`--load-extension=${uniqueExtPaths.join(',')}`);
        args.push(`--disable-extensions-except=${uniqueExtPaths.join(',')}`);
        console.log(`[Extensions] Loading ${uniqueExtPaths.length} extension(s)`);
      }

      // Native Chrome cookies are encrypted for their source Windows account.
      // On another PC, import the portable JSON cookies before navigating to X.
      const regularLaunchUrl = options.autoStartTwitterBot
        ? startUrl
        : targetTweetUrl
          ? openPostBootstrapUrl
          : (hasStagedCookies ? 'about:blank' : startUrl);
      const launchUrl = sessionImportAttemptId ? startUrl : regularLaunchUrl;
      if (shouldAppendLaunchUrl(launchMode, hasRestorableSession)) {
        args.push(launchUrl);
      } else {
        console.log('[Chrome] Manual launch: restoring the existing Chrome session');
      }
      if (
        shadowbanSetupUrl &&
        !options.autoStartTwitterBot &&
        !targetTweetUrl &&
        !sessionImportAttemptId &&
        shouldOpenSetupTab(launchMode, hasRestorableSession)
      ) {
        args.push(shadowbanSetupUrl);
        console.log('[Extensions] Opening the standard Shadowban setup tab');
      }
      const launchConfirmationPromise = autoStartLaunchId
        ? this.waitForLaunchConfirmation(options.profileId, autoStartLaunchId)
        : null;

      console.log(`Launching Chrome: ${chromePath}`);
      console.log(`Start URL: ${startUrl}${hasStagedCookies ? ' (after cookie import)' : ''}`);
      console.log(`Mode: ZERO CDP (no debug port, no WebSocket, fully clean)`);

      // Clean environment
      const cleanEnv: Record<string, string | undefined> = {};
      for (const [key, val] of Object.entries(process.env)) {
        if (!key.startsWith('ELECTRON') && key !== 'NODE_OPTIONS') {
          cleanEnv[key] = val;
        }
      }
      // Set timezone to match fingerprint/proxy location
      if (effectiveFingerprint.timezone) {
        cleanEnv['TZ'] = effectiveFingerprint.timezone;
        console.log(`[Timezone] Set to ${effectiveFingerprint.timezone}`);
      }

      // === SPAWN Chrome — no Puppeteer, no CDP, no debug port ===
      // Verify that the process survives startup. Some VPS/RDP machines reject
      // normal GPU initialization and previously looked like a successful launch.
      this.pendingLaunchModes.set(options.profileId, launchMode);
      let chromeProcess: ChildProcess;
      try {
        chromeProcess = await this.spawnChromeAndVerify(chromePath, args, cleanEnv, profilePath);
      } catch (firstError: any) {
        if (process.platform !== 'win32') throw firstError;
        console.warn(`[Chrome] Standard startup failed, retrying in VPS compatibility mode: ${firstError.message}`);
        chromeProcess = await this.spawnChromeAndVerify(chromePath, [...args, '--disable-gpu'], cleanEnv, profilePath);
      }
      if (this.cancelledProfiles.has(options.profileId)) {
        await this.terminateProfileProcesses(profilePath);
        throw new Error('Launch cancelled');
      }
      if (managedLaunch) {
        this.enforceWindowPlacement(chromeProcess.pid, placement);
      } else if (manualPlacementCorrection) {
        this.enforceWindowPlacement(chromeProcess.pid, {
          ...manualPlacementCorrection,
          width: manualPlacementCorrection.right - manualPlacementCorrection.left,
          height: manualPlacementCorrection.bottom - manualPlacementCorrection.top,
          workArea: placement.workArea,
        });
      }

      console.log(`[Chrome] Process spawned (PID: ${chromeProcess.pid}) — CDP-free`);
      this.appendLifecycleEvent(options.profileId, 'process-spawned', {
        launchMode,
        pid: chromeProcess.pid || null,
        launchId: autoStartLaunchId,
      });

      const profileInstance = {
        chromeProcess,
        profilePath,
        profileId: options.profileId,
        localProxyServer,
        launchMode,
        processMonitorTimer: null as NodeJS.Timeout | null,
        requiresPortableAuth: options.platform === 'twitter' ||
          Boolean(targetTweetUrl) ||
          options.autoStartTwitterBot === true ||
          sessionImportAttemptId.length > 0 ||
          /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(options.lastUrl || ''),
        syncEligible: false,
        closeNotified: false,
        closeIntent: null as null | { source: string; timestamp: string },
      };

      let processCleanedUp = false;
      const cleanupChromeProcess = (
        source: string,
        details: Record<string, unknown> = {}
      ) => {
        if (processCleanedUp) return;
        processCleanedUp = true;
        this.appendLifecycleEvent(options.profileId, 'profile-processes-gone', {
          source,
          launchMode,
          launchId: autoStartLaunchId,
          closeIntent: profileInstance.closeIntent,
          ...details,
        });
        if (profileInstance.processMonitorTimer) {
          clearTimeout(profileInstance.processMonitorTimer);
          profileInstance.processMonitorTimer = null;
        }

        if (localProxyServer) {
          localProxyServer.close();
          console.log(`[Proxy] Local relay closed for profile: ${options.profileId}`);
        }

        this.pendingProfiles.delete(options.profileId);
        if (autoStartLaunchId) {
          this.cancelLaunchConfirmation(options.profileId, autoStartLaunchId);
        }
        this.activeProfiles.delete(options.profileId);
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('profiles:activeUpdate', Array.from(this.activeProfiles.keys()));
          if (profileInstance.syncEligible && !profileInstance.closeNotified) {
            profileInstance.closeNotified = true;
            const emitClosedProfile = () => {
              if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
              const portableAuthReady = !profileInstance.requiresPortableAuth ||
                this.ensureAuthenticatedXSnapshot(profileInstance.profilePath);
              this.mainWindow.webContents.send('profile:closed', options.profileId, {
                syncEligible: portableAuthReady,
                launchMode: profileInstance.launchMode,
                requiresPortableAuth: profileInstance.requiresPortableAuth,
                reason: portableAuthReady ? 'chrome-exit' : 'missing-authenticated-x-snapshot',
              });
            };

            const portableAuthAlreadyReady = !profileInstance.requiresPortableAuth ||
              this.ensureAuthenticatedXSnapshot(profileInstance.profilePath);
            if (portableAuthAlreadyReady) {
              emitClosedProfile();
            } else {
              // The extension's final localhost POST can finish just after the
              // Chrome process exits. Give that atomic write a short grace period.
              setTimeout(emitClosedProfile, 1500);
            }
          }
        }
      };

      const monitorHandedOffBrowser = () => {
        if (processCleanedUp || process.platform !== 'win32') return;
        profileInstance.processMonitorTimer = setTimeout(async () => {
          profileInstance.processMonitorTimer = null;
          try {
            const remainingProcessIds = await this.getProfileProcessIds(profilePath);
            if (remainingProcessIds.length === 0) {
              cleanupChromeProcess('handoff-monitor', {
                rootPid: chromeProcess.pid || null,
                rootExitCode: chromeProcess.exitCode,
                rootSignalCode: chromeProcess.signalCode,
              });
              return;
            }
            monitorHandedOffBrowser();
          } catch (error) {
            console.warn(
              `[Chrome] Could not monitor handed-off browser for ${options.profileId}:`,
              error
            );
            monitorHandedOffBrowser();
          }
        }, 1000);
      };

      chromeProcess.on('error', (error) => {
        console.error(`[Chrome] Process error for profile ${options.profileId}:`, error);
        this.appendLifecycleEvent(options.profileId, 'root-process-error', {
          pid: chromeProcess.pid || null,
          name: error.name,
          message: error.message,
        });
        cleanupChromeProcess('root-process-error', {
          pid: chromeProcess.pid || null,
          message: error.message,
        });
      });

      // Monitor Chrome process exit
      chromeProcess.on('exit', async (code, signal) => {
        console.log(`[Chrome] Process exited (code: ${code}) for profile: ${options.profileId}`);
        this.appendLifecycleEvent(options.profileId, 'root-process-exit', {
          pid: chromeProcess.pid || null,
          code,
          signal,
          launchMode,
          closeIntent: profileInstance.closeIntent,
        });

        // On Windows/VPS, chrome.exe may hand the visible browser window to
        // another process and let the process spawned by Spectra exit. Treat
        // the profile as closed only when no Chrome process still owns this
        // user-data-dir.
        if (process.platform === 'win32') {
          await new Promise(resolve => setTimeout(resolve, 400));
          try {
            const remainingProcessIds = await this.getProfileProcessIds(profilePath);
            if (remainingProcessIds.length > 0) {
              this.appendLifecycleEvent(options.profileId, 'browser-handoff-detected', {
                rootPid: chromeProcess.pid || null,
                rootExitCode: code,
                rootSignal: signal,
                survivingPids: remainingProcessIds,
              });
              console.log(
                `[Chrome] Browser handoff detected for ${options.profileId}; ` +
                `surviving PIDs: ${remainingProcessIds.join(',')}`
              );
              monitorHandedOffBrowser();
              return;
            }
          } catch (error) {
            console.warn(`[Chrome] Browser handoff check failed for ${options.profileId}:`, error);
          }
        }

        // Save last URL from open_tabs.json (updated by extension or Chrome itself)
        // Note: Without CDP we can't export cookies on exit, but Chrome saves them
        // to its native Cookies DB which is included in profile sync
        cleanupChromeProcess('root-process-exit', {
          pid: chromeProcess.pid || null,
          code,
          signal,
        });
      });

      const profileProcessIds = process.platform === 'win32'
        ? await this.getProfileProcessIds(profilePath)
        : [];
      if (
        processCleanedUp ||
        (
          process.platform === 'win32'
            ? profileProcessIds.length === 0
            : chromeProcess.exitCode !== null || chromeProcess.signalCode !== null
        )
      ) {
        throw new Error('Chrome exited before the launch could be marked Running');
      }

      this.pendingProfiles.delete(options.profileId);
      this.pendingLaunchModes.delete(options.profileId);
      this.activeProfiles.set(options.profileId, profileInstance);
      profileInstance.syncEligible = true;
      console.log(`Chrome launched successfully for profile: ${options.profileId}`);

      // Open Selected must not block the entire batch while VenusBot confirms.
      // The visible browser window is the launch confirmation; VenusBot keeps
      // reporting its own status in the background. Closing an instance
      // manually before that report is therefore a normal close, not a failed
      // browser launch.
      if (launchConfirmationPromise) {
        void launchConfirmationPromise
          .then(launchStatus => {
            if (launchStatus === 'venus-confirmed') {
              console.log(
                `[Spectra AutoStart] VenusBot confirmed for ${options.profileId}`
              );
            } else if (launchStatus === 'manual-pause-preserved') {
              console.warn(
                `[Spectra AutoStart] VenusBot manual pause preserved for ${options.profileId}`
              );
            } else if (launchStatus === 'timeout') {
              console.warn(
                `[Spectra AutoStart] VenusBot confirmation timed out for ${options.profileId}`
              );
            } else if (launchStatus === 'process-exited') {
              console.log(
                `[Spectra AutoStart] ${options.profileId} closed before VenusBot confirmation`
              );
            }
          })
          .catch(error => {
            console.warn(
              `[Spectra AutoStart] VenusBot background confirmation failed for ${options.profileId}:`,
              error
            );
          });
      }

      return { success: true };

    } catch (error: any) {
      this.pendingProfiles.delete(options.profileId);
      this.pendingLaunchModes.delete(options.profileId);
      if (autoStartLaunchId) {
        this.cancelLaunchConfirmation(options.profileId, autoStartLaunchId);
      }
      console.error('Error launching browser:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Find system-installed Chrome (sends proper "Google Chrome" in Sec-Ch-Ua)
   */
  private static findSystemChrome(): string | null {
    const candidates: string[] = [];
    if (process.platform === 'win32') {
      const programFiles = process.env['PROGRAMFILES'] || 'C:\\Program Files';
      const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
      const localAppData = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');
      candidates.push(
        path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      );
    } else if (process.platform === 'darwin') {
      candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    } else {
      candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable');
    }
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        console.log(`[Browser] Found system Chrome: ${c}`);
        return c;
      }
    }
    console.log('[Browser] System Chrome not found, will use Chrome for Testing');
    return null;
  }

  /**
   * Download Chrome for Testing (fallback)
   */
  private static async downloadChromeForTesting(): Promise<string> {
    const cacheDir = path.join(os.homedir(), '.antidetect-browser', 'browser');
    const platform = detectBrowserPlatform();

    if (!platform) {
      throw new Error('Cannot detect browser platform');
    }

    const markerPath = path.join(cacheDir, '.installed');
    if (fs.existsSync(markerPath)) {
      const savedPath = fs.readFileSync(markerPath, 'utf8').trim();
      const cachedVersion = await this.getBrowserVersion(savedPath);
      if (fs.existsSync(savedPath) && cachedVersion === MANAGED_CHROME_VERSION) {
        console.log(`[Browser] Using cached Chrome: ${savedPath}`);
        return savedPath;
      }
      console.warn(
        `[Browser] Cached Chrome is stale (${cachedVersion || 'unknown'}); ` +
        `installing ${MANAGED_CHROME_VERSION}`
      );
    }

    console.log('[Browser] Downloading Chrome for Testing...');
    this.sendProgress(0, 'Téléchargement Chrome for Testing...');
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    const buildId = MANAGED_CHROME_VERSION;
    console.log(`[Browser] Using Chrome version: ${buildId}`);

    let lastPercent = 0;
    const result = await install({
      browser: Browser.CHROME,
      buildId: buildId,
      cacheDir: cacheDir,
      platform: platform,
      downloadProgressCallback: (downloadedBytes: number, totalBytes: number) => {
        const percent = Math.round((downloadedBytes / totalBytes) * 100);
        if (percent !== lastPercent) {
          lastPercent = percent;
          const dlMB = (downloadedBytes / 1024 / 1024).toFixed(1);
          const totalMB = (totalBytes / 1024 / 1024).toFixed(1);
          this.sendProgress(percent, `Chrome for Testing... ${dlMB} / ${totalMB} Mo`);
        }
      },
    });

    this.sendProgress(100, 'Navigateur prêt !');
    console.log(`[Browser] Chrome downloaded: ${result.executablePath}`);
    fs.writeFileSync(markerPath, result.executablePath);
    return result.executablePath;
  }

  /**
   * Create a local HTTP proxy that relays to a remote proxy with authentication.
   * Chrome connects to localhost (no auth needed), local proxy adds Proxy-Authorization.
   */
  private static createLocalProxy(proxy: any): Promise<{ server: http.Server; port: number }> {
    return new Promise((resolve, reject) => {
      const authHeader = 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
      const remoteHost = proxy.host;
      const remotePort = Number(proxy.port);

      const server = http.createServer((req, res) => {
        // HTTP requests — forward with auth header
        const options: http.RequestOptions = {
          host: remoteHost,
          port: remotePort,
          method: req.method,
          path: req.url,
          headers: { ...req.headers, 'Proxy-Authorization': authHeader },
        };
        const proxyReq = http.request(options, (proxyRes) => {
          res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
          proxyRes.pipe(res);
        });
        proxyReq.on('error', (e) => {
          console.error('[Proxy] HTTP relay error:', e.message);
          res.writeHead(502);
          res.end('Proxy error');
        });
        req.pipe(proxyReq);
      });

      // HTTPS CONNECT tunneling
      server.on('connect', (req, clientSocket, head) => {
        const connectReq = `CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\nProxy-Authorization: ${authHeader}\r\n\r\n`;
        const remoteSocket = net.connect(remotePort, remoteHost, () => {
          remoteSocket.write(connectReq);
        });

        let responded = false;
        remoteSocket.once('data', (chunk) => {
          const response = chunk.toString();
          if (response.includes('200')) {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length > 0) remoteSocket.write(head);
            remoteSocket.pipe(clientSocket);
            clientSocket.pipe(remoteSocket);
            responded = true;
          } else {
            clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
            clientSocket.end();
            remoteSocket.end();
          }
        });

        remoteSocket.on('error', (e) => {
          console.error('[Proxy] CONNECT relay error:', e.message);
          if (!responded) {
            clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
            clientSocket.end();
          }
        });

        clientSocket.on('error', () => remoteSocket.destroy());
        remoteSocket.on('close', () => clientSocket.destroy());
        clientSocket.on('close', () => remoteSocket.destroy());
      });

      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        console.log(`[Proxy] Local relay started on 127.0.0.1:${addr.port}`);
        resolve({ server, port: addr.port });
      });

      server.on('error', reject);
    });
  }

  static async closeProfile(profileId: string, source = 'ui-graceful-close') {
    this.assertSafeId(profileId, 'profile ID');
    this.cancelledProfiles.add(profileId);
    const instance = this.activeProfiles.get(profileId);
    const closeIntent = { source, timestamp: new Date().toISOString() };
    if (instance) instance.closeIntent = closeIntent;
    this.appendLifecycleEvent(profileId, 'close-requested', {
      source,
      method: 'graceful',
      launchMode: instance?.launchMode || this.pendingLaunchModes.get(profileId) || null,
    });
    if (!instance) {
      const profilesRoot = process.platform === 'win32'
        ? path.join(os.homedir(), 'AppData', 'Local', 'AntidetectBrowser', 'Profiles')
        : path.join(os.homedir(), '.antidetect-browser', 'profiles');
      await this.terminateProfileProcesses(path.join(profilesRoot, profileId));
      return;
    }

    try {
      // Give the cookie-sync extension one interval to persist its final state.
      await new Promise(resolve => setTimeout(resolve, 1100));
      if (process.platform === 'win32') {
        const escapedPath = instance.profilePath.replace(/'/g, "''");
        await this.runPowerShell(`
          $profilePath = '${escapedPath}'
          $deadline = (Get-Date).AddSeconds(10)
          $browserProcesses = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" |
            Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profilePath) }
          $windowProcess = $browserProcesses |
            ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } |
            Where-Object { $_ -and $_.MainWindowHandle -ne 0 } |
            Select-Object -First 1
          if ($windowProcess) {
            [void]$windowProcess.CloseMainWindow()
          }
          do {
            Start-Sleep -Milliseconds 250
            $remaining = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" |
              Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profilePath) }
          } while ($remaining -and (Get-Date) -lt $deadline)
          if ($remaining) {
            $remaining | ForEach-Object {
              Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            }
          }
        `);
      } else if (instance.chromeProcess && instance.chromeProcess.exitCode === null) {
        instance.chromeProcess.kill('SIGTERM');
      }
    } catch (error) {
      console.warn(`[Chrome] Graceful close failed for ${profileId}, forcing shutdown:`, error);
      try {
        if (instance.chromeProcess && instance.chromeProcess.exitCode === null) {
          instance.chromeProcess.kill();
        }
      } catch {}
    }
  }

  static async forceCloseProfile(profileId: string, source = 'ui-force-close') {
    this.assertSafeId(profileId, 'profile ID');
    this.cancelledProfiles.add(profileId);
    const instance = this.activeProfiles.get(profileId);
    const closeIntent = { source, timestamp: new Date().toISOString() };
    if (instance) instance.closeIntent = closeIntent;
    this.appendLifecycleEvent(profileId, 'close-requested', {
      source,
      method: 'forced',
      launchMode: instance?.launchMode || this.pendingLaunchModes.get(profileId) || null,
    });
    const profilesRoot = process.platform === 'win32'
      ? path.join(os.homedir(), 'AppData', 'Local', 'AntidetectBrowser', 'Profiles')
      : path.join(os.homedir(), '.antidetect-browser', 'profiles');
    const profilePath = instance?.profilePath || path.join(profilesRoot, profileId);
    if (instance?.processMonitorTimer) {
      clearTimeout(instance.processMonitorTimer);
      instance.processMonitorTimer = null;
    }

    const beforeProcessIds = await this.getProfileProcessIds(profilePath);
    console.log(
      `[Spectra OpenPost] Force close ${profileId}; Chrome PIDs before: ${beforeProcessIds.join(',') || 'none'}`
    );
    if (beforeProcessIds.length > 0) {
      // OpenPost normally flushes explicitly; this also protects emergency/UI closes.
      await new Promise(resolve => setTimeout(resolve, 1100));
    }
    await this.terminateProfileProcesses(profilePath);
    const afterProcessIds = await this.getProfileProcessIds(profilePath);
    this.appendLifecycleEvent(profileId, 'forced-close-completed', {
      source,
      beforeProcessIds,
      afterProcessIds,
    });
    console.log(
      `[Spectra OpenPost] Force close ${profileId}; Chrome PIDs after: ${afterProcessIds.join(',') || 'none'}`
    );
    this.pendingProfiles.delete(profileId);
    this.pendingLaunchModes.delete(profileId);
    this.activeProfiles.delete(profileId);
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(
        'profiles:activeUpdate',
        Array.from(this.activeProfiles.keys())
      );
      if (instance?.syncEligible && !instance.closeNotified) {
        instance.closeNotified = true;
        const portableAuthReady = !instance.requiresPortableAuth ||
          this.ensureAuthenticatedXSnapshot(instance.profilePath);
        this.mainWindow.webContents.send('profile:closed', profileId, {
          syncEligible: portableAuthReady,
          launchMode: instance.launchMode,
          requiresPortableAuth: instance.requiresPortableAuth,
          reason: portableAuthReady ? 'forced-close' : 'missing-authenticated-x-snapshot',
        });
      }
    }
  }

  static getActiveProfiles(): string[] {
    for (const [profileId, instance] of this.activeProfiles) {
      if (process.platform === 'win32') {
        if (!instance?.profilePath) this.activeProfiles.delete(profileId);
        continue;
      }
      const processExited = !instance?.chromeProcess ||
        instance.chromeProcess.exitCode !== null ||
        instance.chromeProcess.signalCode !== null;
      if (processExited) this.activeProfiles.delete(profileId);
    }
    return Array.from(this.activeProfiles.keys());
  }

  static canAcceptOpenPostClose(profileId: string): boolean {
    return this.pendingLaunchModes.get(profileId) === 'open-post' ||
      this.activeProfiles.get(profileId)?.launchMode === 'open-post';
  }

  static async getRunningProfiles(profileIds: string[]): Promise<string[]> {
    const safeIds = Array.from(new Set(profileIds)).filter(id => {
      try {
        this.assertSafeId(id, 'profile ID');
        return true;
      } catch {
        return false;
      }
    });
    const running = new Set(this.getActiveProfiles());
    if (process.platform !== 'win32' || safeIds.length === 0) {
      return safeIds.filter(id => running.has(id) && !this.pendingProfiles.has(id));
    }

    const profilesRoot = path.join(os.homedir(), 'AppData', 'Local', 'AntidetectBrowser', 'Profiles');
    const escapedRoot = profilesRoot.replace(/'/g, "''");
    const powershellIds = safeIds.map(id => `'${id}'`).join(',');
    try {
      const output = await this.runPowerShell(`
        $profilesRoot = '${escapedRoot}'
        $ids = @(${powershellIds})
        $processes = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" |
          Where-Object { $_.CommandLine }
        foreach ($id in $ids) {
          $profilePath = Join-Path $profilesRoot $id
          if ($processes | Where-Object { $_.CommandLine.Contains($profilePath) } | Select-Object -First 1) {
            Write-Output $id
          }
        }
      `);
      output.split(/\r?\n/).map(value => value.trim()).filter(Boolean).forEach(id => running.add(id));
    } catch (error) {
      console.warn('[Chrome] Could not discover running profiles:', error);
      throw new Error('Unable to inspect running Chrome profiles');
    }
    return safeIds.filter(id => running.has(id) && !this.pendingProfiles.has(id));
  }

  static async getCookies(profileId: string): Promise<any[]> {
    // Without CDP, we read cookies from the synced_cookies.json file
    const instance = this.activeProfiles.get(profileId);
    if (!instance) return [];

    try {
      const syncedPath = path.join(instance.profilePath, 'synced_cookies.json');
      if (fs.existsSync(syncedPath)) {
        return JSON.parse(fs.readFileSync(syncedPath, 'utf8'));
      }
    } catch {}
    return [];
  }
}
