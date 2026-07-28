import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import * as net from 'net';
import { spawn, execFile, ChildProcess } from 'child_process';
import { install, Browser, detectBrowserPlatform } from '@puppeteer/browsers';
import { resolveVenusAutostartState } from './venus-autostart-state';

// Keep the managed browser aligned with the Chrome version advertised by new profiles.
const MANAGED_CHROME_VERSION = '151.0.7922.47';

export interface PuppeteerLaunchOptions {
  profileId: string;
  profileName: string;
  userAgent?: string;
  proxy?: any;
  fingerprint?: any;
  lastUrl?: string;
  connectionType?: string;
  extensionPaths?: string[];
  windowLayout?: { index: number; total: number };
  autoStartTwitterBot?: boolean;
}

export class PuppeteerLauncher {
  private static activeProfiles = new Map<string, any>();
  private static pendingProfiles = new Set<string>();
  private static launchConfirmationWaiters = new Map<
    string,
    { resolve: (status: string) => void; timeout: NodeJS.Timeout }
  >();
  private static browserVersions = new Map<string, Promise<string | null>>();
  private static mainWindow: any = null;
  private static localServerConfig: { port: number; token: string } | null = null;
  private static readonly compactWindow = { width: 480, height: 500, margin: 0, gap: 0 };

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
      return output.split(/\r?\n/).map(Number).filter(Number.isFinite);
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

  private static async waitForVisibleWindow(profilePath: string, timeoutMs = 12000): Promise<number | null> {
    if (process.platform !== 'win32') return null;
    const escapedPath = profilePath.replace(/'/g, "''");
    const timeoutSeconds = Math.max(3, Math.ceil(timeoutMs / 1000));
    const output = await this.runPowerShell(`
      $profilePath = '${escapedPath}'
      $deadline = (Get-Date).AddSeconds(${timeoutSeconds})
      do {
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

  private static getWindowPlacement(layout?: { index: number; total: number }) {
    let workArea = { x: 0, y: 0, width: 1920, height: 1080 };

    try {
      const { screen } = require('electron');
      const display = this.mainWindow && !this.mainWindow.isDestroyed()
        ? screen.getDisplayMatching(this.mainWindow.getBounds())
        : screen.getPrimaryDisplay();
      workArea = display.workArea;
    } catch {}

    const win = this.compactWindow;
    const maxColumns = Math.max(1, Math.floor((workArea.width - win.margin * 2 + win.gap) / (win.width + win.gap)));
    const columns = Math.max(1, maxColumns);
    const slot = Math.max(0, layout?.index ?? this.activeProfiles.size);
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

  private static configureTwitterAutoReplyAutostart(
    extensionPath: string,
    enabled: boolean,
    launchContext: { launchId: string; profileId: string; profileName: string }
  ): boolean {
    const manifestPath = path.join(extensionPath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return false;

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (!this.isTwitterAutoReplyManifest(manifest)) return false;

      const venusVersion = String(manifest.version || 'unknown');
      const contentScripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
      const contentScriptFiles = contentScripts.flatMap((script: any) =>
        Array.isArray(script.js) ? script.js : []
      );
      for (const scriptFile of contentScriptFiles) {
        const scriptPath = path.join(extensionPath, scriptFile);
        if (!fs.existsSync(scriptPath)) continue;
        const source = fs.readFileSync(scriptPath, 'utf8');
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
        const pendingGuard =
          `if(e.pendingAutoStart&&!e.manualPause&&(!sessionStorage.getItem(${JSON.stringify(`spectra:autostart-initializing:${launchContext.launchId}`)})||e.spectraPendingLaunchId===${JSON.stringify(launchContext.launchId)})){`;
        patched = patched.replace(
          /if\(e\.pendingAutoStart&&!e\.manualPause&&\(!sessionStorage\.getItem\(["']spectra:autostart-initializing:[^"']+["']\)\|\|e\.spectraPendingLaunchId===["'][^"']+["']\)\)\{/,
          pendingGuard
        );
        patched = patched.replace(
          /if\(e\.pendingAutoStart(?:&&!e\.manualPause)?\)\{/,
          pendingGuard
        );
        patched = patched.replace(
          /:this\.isEnabled(?:&&!sessionStorage\.getItem\(["']spectra:autostart-initializing:[^"']+["']\))?&&this\.startAutoMode\(\)/,
          `:this.isEnabled&&!sessionStorage.getItem(${JSON.stringify(`spectra:autostart-initializing:${launchContext.launchId}`)})&&this.startAutoMode()`
        );
        if (patched !== source) {
          fs.writeFileSync(scriptPath, patched);
          console.log(`[Spectra AutoStart] Patched cycle resume compatibility in ${scriptFile}`);
          break;
        }
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
  const SERVER = 'http://127.0.0.1:${this.localServerConfig?.port || 0}';
  const SERVER_TOKEN = ${JSON.stringify(this.localServerConfig?.token || '')};
  const READY_MARKER = 'spectra:startup-tabs-ready:' + LAUNCH_ID;
  const INIT_MARKER = 'spectra:autostart-initializing:' + LAUNCH_ID;
  const COMMAND_MARKER = 'spectra:autostart-command-sent:' + LAUNCH_ID;
  const CONFIRMED_MARKER = 'spectra:autostart-confirmed:' + LAUNCH_ID;
  const resolveVenusAutostartState = ${stateResolverSource};
  let activationInFlight = false;
  sessionStorage.setItem(INIT_MARKER, '1');

  const reportStatus = (status, details = {}, attempt = 1) => {
    fetch(SERVER + '/api/launch-status', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + SERVER_TOKEN
      },
      body: JSON.stringify({ profileId: PROFILE_ID, launchId: LAUNCH_ID, status, details })
    }).then((response) => {
      if (!response.ok) throw new Error('Status server returned ' + response.status);
    }).catch((error) => {
      if (attempt < 5) {
        window.setTimeout(() => reportStatus(status, details, attempt + 1), attempt * 500);
      } else {
        console.warn('[Spectra AutoStart] Status report failed:', error);
      }
    });
  };

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
            bot && (bot.isRunning || bot.autonomousCycleRunning || bot.isEnabled)
          );
          if (state.isEnabled === true && state.mode === 'autonomous' && running) {
            sessionStorage.setItem(CONFIRMED_MARKER, '1');
            sessionStorage.removeItem(INIT_MARKER);
            chrome.storage.local.remove('spectraPendingLaunchId');
            console.log('[Spectra AutoStart] VenusBot confirmed running');
            reportStatus('venus-confirmed', {
              phase: state.autonomousPhase,
              phaseStartTime: state.autonomousPhaseStartTime,
              tabId: sessionStorage.getItem(READY_MARKER)
            });
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
            reportStatus('manual-pause-preserved');
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
        waitForConfirmation();
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

  const deadline = Date.now() + 30000;
  const waitForReadyRequestsTab = () => {
    try {
      if (!isRequestsPage()) return;
      if (sessionStorage.getItem(READY_MARKER) !== '1') {
        if (Date.now() < deadline) {
          window.setTimeout(waitForReadyRequestsTab, 250);
        } else {
          sessionStorage.removeItem(INIT_MARKER);
          console.warn('[Spectra AutoStart] Tab cleanup readiness timed out');
        }
        return;
      }
      const authenticatedUi = document.querySelector(
        '[data-testid="AppTabBar_Home_Link"], [data-testid="SideNav_AccountSwitcher_Button"]'
      );
      if (authenticatedUi) {
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
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      } else if (!enabled && alreadyRegistered) {
        manifest.content_scripts = contentScripts.filter((script: any) =>
          !(Array.isArray(script.js) && script.js.includes(autostartFile))
        );
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      }

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

  private static suppressExtensionInstallTabs(runtimePath: string): boolean {
    const manifestPath = path.join(runtimePath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return false;

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const extensionName = String(manifest.name || '').toLowerCase();
      const serviceWorker = manifest.background?.service_worker;
      if (
        !extensionName.includes('shadowban scanner') ||
        typeof serviceWorker !== 'string' ||
        manifest.background?.type === 'module'
      ) {
        return false;
      }

      const workerPath = path.join(runtimePath, serviceWorker);
      if (!fs.existsSync(workerPath)) return false;

      const workerSource = fs.readFileSync(workerPath, 'utf8');
      if (!workerSource.includes('html/initialSetup.html')) return false;

      const patchedWorkerSource = workerSource.replace(
        /([A-Za-z_$][\w$]*=function\(\)\{)var ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.runtime\.getURL\(["']html\/initialSetup\.html["']\);\3\.tabs\.create\(\{url:\2\}\)(\})/,
        '$1console.log("[Spectra] Shadowban initial setup suppressed")$4'
      );
      if (patchedWorkerSource === workerSource) {
        throw new Error('Shadowban initialSetup handler was not recognized');
      }

      fs.writeFileSync(workerPath, patchedWorkerSource);
      console.log(`[Extensions] Disabled Shadowban onInstalled initialSetup for ${manifest.name}`);
      return true;
    } catch (error) {
      console.warn('[Extensions] Could not suppress automatic setup tab:', error);
      return false;
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
          [Win32]::SetWindowPos($p.MainWindowHandle, [IntPtr]::Zero, ${placement.left}, ${placement.top}, ${placement.width}, ${placement.height}, 0x0040) | Out-Null
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
        const handle = await this.waitForVisibleWindow(profilePath);
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
      'pending_cookies.json', 'synced_cookies.json', 'open_tabs.json',
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

      // Get user data directory path
      const userDataDir = process.platform === 'win32'
        ? path.join(os.homedir(), 'AppData', 'Local', 'AntidetectBrowser', 'Profiles')
        : path.join(os.homedir(), '.antidetect-browser', 'profiles');

      const profilePath = path.join(userDataDir, options.profileId);
      if (!fs.existsSync(profilePath)) {
        fs.mkdirSync(profilePath, { recursive: true });
      }

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
      const placement = this.getWindowPlacement(options.windowLayout);
      this.applyCleanLaunchState(profilePath, prefs);
      // Always discard Chrome's stale tab/session files. The URL Spectra should
      // reopen is tracked separately, and stale sessions can make Chrome exit
      // before showing a window on an individual launch.
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
        const systemChrome = this.findSystemChrome();
        if (!systemChrome) {
          throw new Error(`Managed browser unavailable and system Chrome was not found: ${downloadError.message}`);
        }
        console.warn(`[Browser] Managed browser unavailable, using system Chrome: ${downloadError.message}`);
        chromePath = systemChrome;
      }

      // Build Chrome args — MINIMAL flags only
      const compactWindowSize = `${placement.width},${placement.height}`;
      const compactWindowPosition = `${placement.left},${placement.top}`;
      const browserVersion = await this.getBrowserVersion(chromePath);
      const configuredUserAgent = options.userAgent || options.fingerprint?.userAgent || '';
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
        `--window-size=${compactWindowSize}`,
        `--window-position=${compactWindowPosition}`,
        `--lang=${options.fingerprint?.language || options.fingerprint?.languages?.[0] || 'en-US'}`,
        '--disable-features=CalculateNativeWinOcclusion',
      ];

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

        platformFixPath = path.join(profilePath, '__platform_fix_ext');
        if (fs.existsSync(platformFixPath)) {
          fs.rmSync(platformFixPath, { recursive: true, force: true });
        }
        fs.mkdirSync(platformFixPath, { recursive: true });

        fs.writeFileSync(path.join(platformFixPath, 'manifest.json'), JSON.stringify({
          manifest_version: 3,
          name: 'Spectra Fingerprint Runtime',
          version: '2.0',
          content_scripts: [{
            matches: ['<all_urls>'],
            js: ['fingerprint.js'],
            run_at: 'document_start',
            all_frames: true,
            world: 'MAIN',
          }],
        }));

        const fp = { ...(options.fingerprint || {}), userAgent, platform };
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
    define(Object.getPrototypeOf(navigator.userAgentData), 'platform',
      fp.platform === 'Win32' ? 'Windows' : fp.platform === 'MacIntel' ? 'macOS' : 'Linux');
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

      fs.writeFileSync(path.join(cookieSyncPath, 'manifest.json'), JSON.stringify({
        manifest_version: 3,
        name: 'Cookie Sync',
        version: '1.0',
        permissions: ['cookies', 'tabs', 'scripting', 'alarms'],
        host_permissions: ['<all_urls>'],
        background: { service_worker: 'background.js' },
      }));

      // Write synced cookies as cookies.json for import
      const syncedCookiesPath = path.join(profilePath, 'synced_cookies.json');
      let hasStagedCookies = false;
      if (fs.existsSync(syncedCookiesPath)) {
        try {
          const cookies = fs.readFileSync(syncedCookiesPath, 'utf8');
          const parsedCookies = JSON.parse(cookies);
          hasStagedCookies = Array.isArray(parsedCookies) && parsedCookies.length > 0;
          fs.writeFileSync(path.join(cookieSyncPath, 'cookies.json'), cookies);
          console.log(`[CookieSync] Loaded cookies for import`);
        } catch {}
      } else {
        fs.writeFileSync(path.join(cookieSyncPath, 'cookies.json'), '[]');
      }

      fs.writeFileSync(path.join(cookieSyncPath, 'background.js'),
`const PROFILE_ID = ${JSON.stringify(options.profileId)};
const PROFILE_NAME = ${JSON.stringify(options.profileName)};
const LAUNCH_ID = ${JSON.stringify(autoStartLaunchId)};
const SERVER = 'http://127.0.0.1:${this.localServerConfig?.port || 0}';
const SERVER_TOKEN = ${JSON.stringify(this.localServerConfig?.token || '')};
let bootstrapPromise = null;
let bootstrapComplete = false;
let exportInProgress = false;
let exportAgain = false;
let exportTimer = null;
let retainedTabId = null;
let cookiesImported = false;
let venusConfirmationReported = false;
const BOOTSTRAP_ATTEMPTS = 5;
const RETRY_DELAYS = [1000, 2000, 4000, 8000, 12000];
const WATCHDOG_DEADLINE = Date.now() + 60000;

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
        await chrome.cookies.set(details);
        imported++;
      } catch (e) {}
    }
    console.log('[CookieSync] Imported ' + imported + '/' + cookies.length + ' cookies');
  } catch (e) {}
}

async function openStartUrl() {
  try {
    const response = await fetch(chrome.runtime.getURL('start_url.json'));
    if (!response.ok) throw new Error('start_url.json returned ' + response.status);
    const { startUrl, closeOtherTabs } = await response.json();
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

function bootstrap() {
  if (bootstrapComplete && retainedTabId) return Promise.resolve(retainedTabId);
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      let lastError = null;
      for (let attempt = 1; attempt <= BOOTSTRAP_ATTEMPTS; attempt++) {
        console.log('[Spectra AutoStart] Bootstrap attempt ' + attempt + '/' + BOOTSTRAP_ATTEMPTS);
        try {
          if (!cookiesImported) {
            await importCookies();
            cookiesImported = true;
          }
          const tabId = await openStartUrl();
          if (!tabId) throw new Error('openStartUrl returned no retainedTabId');
          retainedTabId = tabId;
          await reportLaunchStatus('bootstrap-confirmed', { tabId });
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

async function runStartupWatchdog() {
  if (Date.now() > WATCHDOG_DEADLINE) {
    chrome.alarms.clear('spectra-startup-watchdog').catch(() => {});
    return;
  }
  try {
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

    if (bootstrapComplete) {
      const retained = retainedTabId
        ? await chrome.tabs.get(retainedTabId).catch(() => null)
        : null;
      if (!retained || !isXTab(retained)) {
        bootstrapComplete = false;
        retainedTabId = null;
        console.warn('[Spectra AutoStart] Watchdog found no retained X tab');
      } else if (!venusConfirmationReported) {
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

    if (!bootstrapComplete && !bootstrapPromise) {
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

chrome.alarms.create('spectra-startup-watchdog', {
  delayInMinutes: 0.5,
  periodInMinutes: 0.5,
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'spectra-startup-watchdog') runStartupWatchdog();
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
    console.log('[CookieSync] Exported ' + cookies.length + ' cookies');
  } catch (e) {
    console.warn('[CookieSync] Export failed', e);
  } finally {
    exportInProgress = false;
    if (exportAgain) {
      exportAgain = false;
      scheduleExport(100);
    }
  }
}

function scheduleExport(delay = 750) {
  if (exportTimer) clearTimeout(exportTimer);
  exportTimer = setTimeout(() => {
    exportTimer = null;
    exportCookies();
  }, delay);
}

bootstrap().catch((error) => {
  console.error('[Spectra AutoStart] Initial bootstrap exhausted:', error);
});
runStartupWatchdog();
chrome.runtime.onStartup.addListener(() => {
  bootstrap().catch((error) => console.error('[Spectra AutoStart] Startup bootstrap exhausted:', error));
});
chrome.runtime.onInstalled.addListener(() => {
  bootstrap().catch((error) => console.error('[Spectra AutoStart] Install bootstrap exhausted:', error));
});
chrome.cookies.onChanged.addListener(() => scheduleExport());
chrome.runtime.onSuspend.addListener(() => exportCookies());

// Safety snapshot in case Chrome does not emit a cookie change event.
setInterval(exportCookies, 5000);

// Also export after 5 seconds (initial page load)
setTimeout(exportCookies, 5000);
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
      if (platformFixPath) extPaths.push(platformFixPath);
      if (options.extensionPaths && options.extensionPaths.length > 0) {
        const validPaths = options.extensionPaths.flatMap((p, index) => {
          const manifestPath = path.join(p, 'manifest.json');
          const exists = fs.existsSync(manifestPath);
          console.log(`[Extensions] ${p} — manifest exists: ${exists}`);
          if (!exists) return [];
          const runtimePath = this.createRuntimeExtensionCopy(runtimeExtensionsRoot, p, index);
          this.suppressExtensionInstallTabs(runtimePath);
          if (this.configureTwitterAutoReplyAutostart(
            runtimePath,
            options.autoStartTwitterBot === true,
            {
              launchId: autoStartLaunchId,
              profileId: options.profileId,
              profileName: options.profileName,
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
          this.suppressExtensionInstallTabs(runtimePath);
          this.configureTwitterAutoReplyAutostart(runtimePath, true, {
            launchId: autoStartLaunchId,
            profileId: options.profileId,
            profileName: options.profileName,
          });
          shouldAutoStartTwitterBot = true;
          extPaths.push(runtimePath);
          console.log(`[Extensions] Auto-start extension added: ${runtimePath}`);
        }
      }
      // Determine start URL
      const isValidUrl = (url: string) => url && (url.startsWith('https://') || url.startsWith('http://'));
      let startUrl = isValidUrl(options.lastUrl || '') ? options.lastUrl! : 'https://www.google.com';
      const lastUrlPath = path.join(profilePath, 'last_url.txt');
      if (!options.autoStartTwitterBot && fs.existsSync(lastUrlPath)) {
        try {
          const savedUrl = fs.readFileSync(lastUrlPath, 'utf8').trim();
          if (isValidUrl(savedUrl)) {
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
          closeOtherTabs: options.autoStartTwitterBot === true,
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
      const launchUrl = options.autoStartTwitterBot
        ? 'about:blank'
        : (hasStagedCookies ? 'about:blank' : startUrl);
      args.push(launchUrl);
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
      if (options.fingerprint?.timezone) {
        cleanEnv['TZ'] = options.fingerprint.timezone;
        console.log(`[Timezone] Set to ${options.fingerprint.timezone}`);
      }

      // === SPAWN Chrome — no Puppeteer, no CDP, no debug port ===
      // Verify that the process survives startup. Some VPS/RDP machines reject
      // normal GPU initialization and previously looked like a successful launch.
      let chromeProcess: ChildProcess;
      try {
        chromeProcess = await this.spawnChromeAndVerify(chromePath, args, cleanEnv, profilePath);
      } catch (firstError: any) {
        if (process.platform !== 'win32') throw firstError;
        console.warn(`[Chrome] Standard startup failed, retrying in VPS compatibility mode: ${firstError.message}`);
        chromeProcess = await this.spawnChromeAndVerify(chromePath, [...args, '--disable-gpu'], cleanEnv, profilePath);
      }
      this.enforceWindowPlacement(chromeProcess.pid, placement);

      console.log(`[Chrome] Process spawned (PID: ${chromeProcess.pid}) — CDP-free`);

      const profileInstance = {
        chromeProcess,
        profilePath,
        profileId: options.profileId,
        localProxyServer,
      };

      let processCleanedUp = false;
      const cleanupChromeProcess = () => {
        if (processCleanedUp) return;
        processCleanedUp = true;

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
          this.mainWindow.webContents.send('profile:closed', options.profileId);
        }
      };

      chromeProcess.on('error', (error) => {
        console.error(`[Chrome] Process error for profile ${options.profileId}:`, error);
        cleanupChromeProcess();
      });

      // Monitor Chrome process exit
      chromeProcess.on('exit', (code, signal) => {
        console.log(`[Chrome] Process exited (code: ${code}) for profile: ${options.profileId}`);

        // Save last URL from open_tabs.json (updated by extension or Chrome itself)
        // Note: Without CDP we can't export cookies on exit, but Chrome saves them
        // to its native Cookies DB which is included in profile sync
        cleanupChromeProcess();
      });

      if (launchConfirmationPromise) {
        const launchStatus = await launchConfirmationPromise;
        if (launchStatus !== 'venus-confirmed') {
          console.error(`[Spectra AutoStart] Launch not confirmed: ${launchStatus}`);
          await this.terminateProfileProcesses(profilePath);
          cleanupChromeProcess();
          throw new Error(
            launchStatus === 'manual-pause-preserved'
              ? 'VenusBot is manually paused; profile was not marked Running'
              : `VenusBot launch confirmation failed: ${launchStatus}`
          );
        }
      }

      if (
        processCleanedUp ||
        chromeProcess.exitCode !== null ||
        chromeProcess.signalCode !== null
      ) {
        throw new Error('Chrome exited before the launch could be marked Running');
      }

      this.pendingProfiles.delete(options.profileId);
      this.activeProfiles.set(options.profileId, profileInstance);
      console.log(`Chrome launched successfully for profile: ${options.profileId}`);
      return { success: true };

    } catch (error: any) {
      this.pendingProfiles.delete(options.profileId);
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

  static async closeProfile(profileId: string) {
    this.assertSafeId(profileId, 'profile ID');
    const instance = this.activeProfiles.get(profileId);
    if (!instance) return;

    try {
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

  static getActiveProfiles(): string[] {
    for (const [profileId, instance] of this.activeProfiles) {
      const processExited = !instance?.chromeProcess ||
        instance.chromeProcess.exitCode !== null ||
        instance.chromeProcess.signalCode !== null;
      if (processExited) this.activeProfiles.delete(profileId);
    }
    return Array.from(this.activeProfiles.keys());
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
