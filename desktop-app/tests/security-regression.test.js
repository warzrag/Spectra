const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const repoRoot = path.resolve(root, '..');
const read = relativePath => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
const loadTypeScriptModule = relativePath => {
  const source = read(relativePath);
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const module = { exports: {} };
  new Function('exports', 'module', compiled)(module.exports, module);
  return module.exports;
};

const getCookieSyncBackgroundSource = ({ profileId, profileName, launchId }) => {
  const launcher = read('desktop-app/src/main/puppeteer-launcher.ts').replace(/\r\n/g, '\n');
  const marker = "fs.writeFileSync(path.join(cookieSyncPath, 'background.js'),\n`";
  const start = launcher.indexOf(marker);
  const end = launcher.indexOf('\n`\n      );', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return launcher
    .slice(start + marker.length, end)
    .replaceAll('${JSON.stringify(options.profileId)}', JSON.stringify(profileId))
    .replaceAll('${JSON.stringify(options.profileName)}', JSON.stringify(profileName))
    .replaceAll('${JSON.stringify(autoStartLaunchId)}', JSON.stringify(launchId))
    .replaceAll('${this.localServerConfig?.port || 0}', '45678')
    .replaceAll("${JSON.stringify(this.localServerConfig?.token || '')}", JSON.stringify('test-token'))
    .replaceAll('\\\\', '\\');
};

test('Electron renderer security remains enabled and updater has no embedded token', () => {
  const main = read('desktop-app/src/main/main.ts');
  assert.match(main, /webSecurity:\s*true/);
  assert.doesNotMatch(main, /const _t\s*=\s*\[/);
  assert.match(main, /private:\s*false/);
  assert.doesNotMatch(main, /SPECTRA_GH_TOKEN/);
});

test('account credentials are not persisted in renderer storage', () => {
  const sidebar = read('desktop-app/src/renderer/components/Sidebar.tsx');
  assert.doesNotMatch(sidebar, /localStorage\.setItem\(['"]spectra_saved_accounts/);
  assert.doesNotMatch(sidebar, /password:\s*newPassword/);
});

test('Firestore and Storage access is scoped by role, team, and profile', () => {
  const firestoreRules = read('admin-panel/firestore.rules');
  const storageRules = read('admin-panel/storage.rules');
  assert.match(firestoreRules, /function canReadProfile/);
  assert.match(firestoreRules, /assignedFolderId == data\.folderId/);
  assert.doesNotMatch(firestoreRules, /allow read,\s*write:\s*if request\.auth != null/);
  assert.match(storageRules, /function canUseProfile/);
  assert.doesNotMatch(storageRules, /allow read:\s*if request\.auth != null/);
});

test('Chrome launch waits for a visible window and repairs stale singleton files', () => {
  const launcher = read('desktop-app/src/main/puppeteer-launcher.ts');
  assert.match(launcher, /waitForVisibleWindow/);
  assert.match(launcher, /terminateProfileProcesses/);
  assert.match(launcher, /stale process\(es\) without a visible window/);
  assert.match(launcher, /clearStaleSingletonFiles/);
  assert.match(launcher, /Chrome started but no visible window appeared/);
});

test('cookie import targets the file consumed by the runtime importer', () => {
  const main = read('desktop-app/src/main/main.ts');
  assert.match(main, /cookieStagingPath = path\.join\(profileDir, 'synced_cookies\.json'\)/);
  assert.doesNotMatch(main, /cookieStagingPath = path\.join\(profileDir, 'pending_cookies\.json'\)/);
});

test('cross-device cookies are restored before navigation and Chrome closes gracefully', () => {
  const launcher = read('desktop-app/src/main/puppeteer-launcher.ts');
  const profileSync = read('desktop-app/src/renderer/services/profile-sync-service.ts');
  assert.match(launcher, /options\.autoStartTwitterBot\s*\?\s*'about:blank'\s*:\s*\(hasStagedCookies \? 'about:blank' : startUrl\)/);
  assert.match(launcher, /await importCookies\(\);\s+cookiesImported = true/);
  assert.match(launcher, /const tabId = await openStartUrl\(\)/);
  assert.match(launcher, /await reportLaunchStatus\('bootstrap-confirmed'[\s\S]*bootstrapComplete = true/);
  assert.match(launcher, /CloseMainWindow\(\)/);
  assert.match(profileSync, /cloudSyncChecksumRevision:\s*revisionId/);
  assert.match(profileSync, /profile\.cloudSyncChecksumRevision === expectedRevision/);
});

test('Open Selected resumes the saved VenusBot phase without resetting its timer', () => {
  const { resolveVenusAutostartState } = loadTypeScriptModule(
    'desktop-app/src/main/venus-autostart-state.ts'
  );
  const now = 1_800_000;

  const firstStartup = resolveVenusAutostartState({}, now);
  assert.equal(firstStartup.valid, false);
  assert.equal(firstStartup.phase, 'requests');
  assert.equal(firstStartup.phaseStartTime, now);
  assert.equal(firstStartup.updates.autonomousPhaseStartTime, now);

  const requests = resolveVenusAutostartState({
    autonomousPhase: 'requests',
    autonomousPhaseStartTime: now - 260_000,
    autonomousRequestsTime: 5,
  }, now);
  assert.equal(requests.valid, true);
  assert.equal(requests.phase, 'requests');
  assert.equal(requests.phaseStartTime, now - 260_000);
  assert.equal(requests.remainingMilliseconds, 40_000);
  assert.equal(requests.targetUrl, 'https://x.com/i/chat/requests');
  assert.equal('autonomousPhase' in requests.updates, false);
  assert.equal('autonomousPhaseStartTime' in requests.updates, false);

  const dms = resolveVenusAutostartState({
    autonomousPhase: 'dms',
    autonomousPhaseStartTime: now - 120_000,
    autonomousDmsTime: 10,
  }, now);
  assert.equal(dms.valid, true);
  assert.equal(dms.phaseStartTime, now - 120_000);
  assert.equal(dms.remainingMilliseconds, 480_000);
  assert.equal(dms.targetUrl, 'https://x.com/i/chat');
  assert.equal('autonomousPhaseStartTime' in dms.updates, false);

  const expired = resolveVenusAutostartState({
    autonomousPhase: 'requests',
    autonomousPhaseStartTime: now - 600_000,
    autonomousRequestsTime: 5,
  }, now);
  assert.equal(expired.valid, true);
  assert.equal(expired.phaseStartTime, now - 600_000);
  assert.equal(expired.remainingMilliseconds, 0);
  assert.equal('autonomousPhaseStartTime' in expired.updates, false);

  const isolatedPlans = Array.from({ length: 5 }, (_, index) =>
    resolveVenusAutostartState({
      autonomousPhase: index % 2 === 0 ? 'requests' : 'dms',
      autonomousPhaseStartTime: now - index * 10_000,
      autonomousRequestsTime: 5,
      autonomousDmsTime: 5,
    }, now)
  );
  assert.deepEqual(
    isolatedPlans.map(plan => plan.phaseStartTime),
    Array.from({ length: 5 }, (_, index) => now - index * 10_000)
  );

  const ownedCommand = resolveVenusAutostartState({
    autonomousPhase: 'dms',
    autonomousPhaseStartTime: now - 120_000,
    autonomousDmsTime: 10,
  }, now, 'launch-test');
  assert.equal(ownedCommand.updates.spectraPendingLaunchId, 'launch-test');
});

test('Open Selected coordinates one exact startup tab and one VenusBot start command', () => {
  const launcher = read('desktop-app/src/main/puppeteer-launcher.ts');
  const main = read('desktop-app/src/main/main.ts');
  const urlServer = read('desktop-app/src/main/url-server.ts');
  const app = read('desktop-app/src/renderer/App.tsx');
  assert.match(launcher, /require\('crypto'\)\.randomUUID\(\)/);
  assert.match(launcher, /spectra:startup-tabs-ready:/);
  assert.match(launcher, /spectra:autostart-command-sent:/);
  assert.match(launcher, /spectra:autostart-confirmed:/);
  assert.match(launcher, /activationInFlight/);
  assert.match(launcher, /Duplicate start blocked/);
  assert.match(launcher, /Stale pending command replaced/);
  assert.match(launcher, /state\.spectraPendingLaunchId === LAUNCH_ID/);
  assert.match(launcher, /VenusBot confirmed running/);
  assert.match(launcher, /Cycle resumed/);
  assert.match(launcher, /Resuming phase/);
  assert.match(launcher, /Saved autonomousPhaseStartTime/);
  assert.match(launcher, /Remaining time/);
  assert.match(launcher, /Saved timer expired; VenusBot will perform the normal phase transition/);
  assert.match(launcher, /AppTabBar_Home_Link/);
  assert.match(app, /lastUrl:\s*'https:\/\/x\.com\/i\/chat\/requests'/);
  assert.match(app, /autoStartTwitterBot:\s*true/);
  assert.match(launcher, /chrome\.tabs\.create\(\{ url: startUrl, active: true \}\)/);
  assert.match(launcher, /let retainedTabId = null/);
  assert.match(launcher, /tab\.id !== retainedTabId/);
  assert.match(launcher, /chrome\.tabs\.get\(retainedTabId\)/);
  assert.match(launcher, /target:\s*\{ tabId: retainedTabId \}/);
  assert.match(launcher, /return retainedTabId/);
  assert.match(launcher, /options\.autoStartTwitterBot\s*\?\s*'about:blank'/);
  assert.doesNotMatch(launcher, /createStartupTabCleanerExtension/);
  assert.match(launcher, /let bootstrapComplete = false/);
  assert.match(launcher, /BOOTSTRAP_ATTEMPTS = 5/);
  assert.match(launcher, /RETRY_DELAYS = \[1000, 2000, 4000, 8000, 12000\]/);
  assert.match(launcher, /WATCHDOG_DEADLINE = Date\.now\(\) \+ 60000/);
  assert.match(launcher, /permissions: \['cookies', 'tabs', 'scripting', 'alarms'\]/);
  assert.match(launcher, /chrome\.alarms\.create\('spectra-startup-watchdog'/);
  assert.match(launcher, /Bootstrap attempt/);
  assert.match(launcher, /Bootstrap retry scheduled/);
  assert.match(launcher, /Bootstrap confirmed/);
  assert.match(launcher, /runStartupWatchdog/);
  assert.match(launcher, /isStartupJunkTab/);
  const openStartUrl = launcher.slice(
    launcher.indexOf('async function openStartUrl()'),
    launcher.indexOf('function bootstrap()')
  );
  assert.doesNotMatch(openStartUrl, /catch\s*\([^)]*\)\s*\{\s*\}/);
  assert.match(openStartUrl, /throw error/);
  assert.match(openStartUrl, /startup-tabs-ready written/);
  assert.match(launcher, /closeOtherTabs:\s*options\.autoStartTwitterBot === true/);
  assert.match(launcher, /suppressExtensionInstallTabs\(runtimePath\)/);
  assert.match(launcher, /workerSource\.includes\('html\/initialSetup\.html'\)/);
  assert.match(launcher, /Shadowban initial setup suppressed/);
  assert.doesNotMatch(launcher, /const spectraTabsCreate = chrome\.tabs\.create/);
  assert.match(launcher, /autonomousPhaseStartTime\|manualPause\|spectraPendingLaunchId/);
  assert.match(launcher, /e\.spectraPendingLaunchId===/);
  assert.match(launcher, /spectra:autostart-initializing:\[\^"'\]\+/);
  assert.match(app, /!activeProfiles\.includes\(p\.id\)/);
  assert.doesNotMatch(launcher, /manualPause:\s*false/);
  assert.match(launcher, /Manual pause preserved; autostart skipped/);
  assert.match(launcher, /--disable-backgrounding-occluded-windows/);
  assert.match(launcher, /--disable-renderer-backgrounding/);
  assert.match(launcher, /--disable-background-timer-throttling/);
  assert.match(launcher, /pendingProfiles\.add\(options\.profileId\)/);
  assert.match(launcher, /await launchConfirmationPromise/);
  assert.match(launcher, /launchStatus !== 'venus-confirmed'/);
  assert.match(launcher, /running\.has\(id\) && !this\.pendingProfiles\.has\(id\)/);
  assert.match(urlServer, /req\.url === '\/api\/launch-status'/);
  assert.match(main, /internal:launch-status/);
});

test('five generated Open Selected bootstraps recover independently and retain one X tab', async () => {
  const runs = Array.from({ length: 5 }, async (_, index) => {
    const profileId = `test_profile_${index + 1}`;
    const launchId = `launch_${index + 1}`;
    const tabs = [
      { id: 1, url: 'about:blank', status: 'complete' },
      {
        id: 2,
        url: 'chrome-extension://shadowban/html/initialSetup.html',
        status: 'complete',
      },
    ];
    const logs = [];
    const statuses = [];
    const createdListeners = [];
    let nextTabId = 3;
    let createFailuresRemaining = index < 2 ? 0 : 1;
    let readyWritten = false;
    let fakeNow = 1_000_000;

    class FastDate extends Date {
      static now() {
        fakeNow += 1000;
        return fakeNow;
      }
    }

    const chrome = {
      runtime: {
        getURL: file => `chrome-extension://cookie-sync/${file}`,
        onStartup: { addListener() {} },
        onInstalled: { addListener() {} },
        onSuspend: { addListener() {} },
      },
      cookies: {
        set: async () => {},
        getAll: async () => [],
        onChanged: { addListener() {} },
      },
      tabs: {
        query: async () => tabs.map(tab => ({ ...tab })),
        create: async properties => {
          if (createFailuresRemaining > 0) {
            createFailuresRemaining--;
            throw new Error('simulated create failure');
          }
          const tab = {
            id: nextTabId++,
            url: properties.url,
            status: 'complete',
            active: properties.active,
          };
          tabs.push(tab);
          createdListeners.forEach(listener => listener({ ...tab }));
          return { ...tab };
        },
        update: async (tabId, properties) => {
          const tab = tabs.find(candidate => candidate.id === tabId);
          if (!tab) throw new Error('tab not found');
          Object.assign(tab, properties, { status: 'complete' });
          return { ...tab };
        },
        remove: async tabId => {
          const index = tabs.findIndex(tab => tab.id === tabId);
          if (index === -1) throw new Error('tab not found');
          tabs.splice(index, 1);
        },
        get: async tabId => {
          const tab = tabs.find(candidate => candidate.id === tabId);
          if (!tab) throw new Error('tab not found');
          return { ...tab };
        },
        onCreated: { addListener: listener => createdListeners.push(listener) },
      },
      scripting: {
        executeScript: async options => {
          const source = String(options.func);
          if (source.includes('sessionStorage.setItem')) {
            readyWritten = true;
            return [{ result: undefined }];
          }
          return [{
            result: {
              confirmed: readyWritten,
              manualPause: false,
            },
          }];
        },
      },
      alarms: {
        create() {},
        clear: async () => true,
        onAlarm: { addListener() {} },
      },
    };

    const fetch = async url => {
      if (url.endsWith('/start_url.json')) {
        return {
          ok: true,
          json: async () => ({
            startUrl: 'https://x.com/i/chat/requests',
            closeOtherTabs: true,
          }),
        };
      }
      if (url.endsWith('/cookies.json')) {
        return { ok: true, json: async () => [] };
      }
      if (url.endsWith('/api/launch-status')) {
        return {
          ok: true,
          json: async () => ({}),
          clone: () => ({ json: async () => ({}) }),
        };
      }
      if (url.endsWith('/api/save-cookies')) return { ok: true };
      throw new Error(`Unexpected URL: ${url}`);
    };

    const source = getCookieSyncBackgroundSource({ profileId, profileName: profileId, launchId });
    const context = {
      chrome,
      fetch: async (url, options = {}) => {
        if (String(url).endsWith('/api/launch-status')) {
          statuses.push(JSON.parse(options.body).status);
        }
        return fetch(String(url));
      },
      console: {
        log: (...args) => logs.push(args.join(' ')),
        warn: (...args) => logs.push(args.join(' ')),
        error: (...args) => logs.push(args.join(' ')),
      },
      Date: FastDate,
      setTimeout: (callback, delay = 0) => setTimeout(callback, Math.min(5, delay / 1000)),
      clearTimeout,
      setInterval: () => 0,
      clearInterval() {},
      Promise,
      JSON,
      RegExp,
      String,
      Error,
    };

    vm.runInNewContext(source, context, { filename: `cookie-sync-${profileId}.js` });
    await new Promise(resolve => setTimeout(resolve, 120));

    assert.equal(tabs.length, 1, `${profileId} should retain exactly one tab`);
    assert.match(tabs[0].url, /^https:\/\/x\.com\/i\/chat\/requests/);
    assert.equal(tabs.some(tab => tab.url === 'about:blank'), false);
    assert.equal(tabs.some(tab => tab.url.includes('initialSetup.html')), false);
    assert.equal(statuses.filter(status => status === 'bootstrap-confirmed').length, 1);
    assert.equal(statuses.filter(status => status === 'venus-confirmed').length, 1);
    assert.equal(logs.some(line => line.includes('Bootstrap confirmed')), true);
    if (index >= 2) {
      assert.equal(logs.some(line => line.includes('Bootstrap retry scheduled')), true);
    }
  });

  await Promise.all(runs);
});

test('managed Chrome and the advertised user-agent stay version-aligned', () => {
  const launcher = read('desktop-app/src/main/puppeteer-launcher.ts');
  assert.match(launcher, /const MANAGED_CHROME_VERSION = '151\.0\.7922\.47'/);
  assert.match(launcher, /cachedVersion === MANAGED_CHROME_VERSION/);
  assert.match(launcher, /alignUserAgentToBrowser/);
  assert.match(launcher, /Correcting Chrome User-Agent mismatch/);
  assert.match(launcher, /normalizedPath\.startsWith\(`\$\{managedBrowserRoot\}\$\{path\.sep\}`\)/);
  assert.match(launcher, /browserVersions\.get\(normalizedPath\)/);
  assert.match(launcher, /const fp = \{ \.\.\.\(options\.fingerprint \|\| \{\}\), userAgent, platform \}/);
});

test('team deletion is targeted and refuses teams that still own resources', () => {
  const admin = read('desktop-app/src/renderer/pages/AdminPage.tsx');
  assert.match(admin, /TEAM_RESOURCE_COLLECTIONS/);
  assert.match(admin, /where\('teamId', '==', teamId\)/);
  assert.match(admin, /Suppression refusée : team utilisée/);
  assert.match(admin, /deleteDoc\(doc\(db, 'teams', teamId\)\)/);
  assert.doesNotMatch(admin, /const ownerTeams = teams\.filter/);
});

test('cloud profile restore validates in staging and rolls back failed swaps', () => {
  const sync = read('desktop-app/src/main/profile-sync.ts');
  assert.match(sync, /Cloud profile archive is incomplete/);
  assert.match(sync, /\.restore-\$\{transactionId\}/);
  assert.match(sync, /\.backup-\$\{transactionId\}/);
  assert.match(sync, /for \(const relativePath of installedPaths\.reverse\(\)\)/);
  assert.match(sync, /fs\.renameSync\(savedPath, currentPath\)/);
  assert.doesNotMatch(sync, /Failed to extract:/);
});

test('cookie and lock synchronization survive fast closes and app restarts', () => {
  const launcher = read('desktop-app/src/main/puppeteer-launcher.ts');
  const main = read('desktop-app/src/main/main.ts');
  const app = read('desktop-app/src/renderer/App.tsx');
  const sync = read('desktop-app/src/renderer/services/profile-sync-service.ts');
  assert.match(launcher, /chrome\.cookies\.onChanged\.addListener/);
  assert.match(launcher, /setInterval\(exportCookies, 5000\)/);
  assert.match(main, /fs\.renameSync\(tempPath, syncedPath\)/);
  assert.match(launcher, /static async getRunningProfiles/);
  assert.match(app, /profiles\.getRunning\(locallyLockedIds\)/);
  assert.match(sync, /lockedAt: serverTimestamp\(\)/);
  assert.match(sync, /profile\.lockedByInstallationId === installationId/);
});

test('Spectra blocks shutdown and updates while profiles are active or syncing', () => {
  const main = read('desktop-app/src/main/main.ts');
  const app = read('desktop-app/src/renderer/App.tsx');
  assert.match(main, /function hasUnsafeShutdownState/);
  assert.match(main, /PuppeteerLauncher\.getActiveProfiles\(\)\.length > 0 \|\| profileSyncBusy/);
  assert.match(main, /mainWindow\.on\('close'/);
  assert.match(main, /ipcMain\.handle\('profileSync:setBusy'/);
  assert.match(app, /profileSync\?\.setBusy\(true\)/);
  assert.match(app, /profileSync\?\.setBusy\(false\)/);
});
