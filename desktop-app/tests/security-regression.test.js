const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

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
  assert.match(launcher, /await importCookies\(\);\s+await openStartUrl\(\)/);
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
  assert.match(launcher, /const retainedTabId = target\?\.id/);
  assert.match(launcher, /tab\.id !== retainedTabId/);
  assert.match(launcher, /chrome\.tabs\.get\(retainedTabId\)/);
  assert.match(launcher, /target:\s*\{ tabId: retainedTabId \}/);
  assert.match(launcher, /Retained startup tab was replaced during cleanup/);
  assert.match(launcher, /options\.autoStartTwitterBot\s*\?\s*'about:blank'/);
  assert.doesNotMatch(launcher, /createStartupTabCleanerExtension/);
  assert.match(launcher, /let bootstrapComplete = false/);
  assert.match(launcher, /closeOtherTabs:\s*options\.autoStartTwitterBot === true/);
  assert.match(launcher, /suppressExtensionInstallTabs\(runtimePath\)/);
  assert.match(launcher, /workerSource\.includes\('html\/initialSetup\.html'\)/);
  assert.match(launcher, /autonomousPhaseStartTime\|manualPause\|spectraPendingLaunchId/);
  assert.match(launcher, /e\.spectraPendingLaunchId===/);
  assert.match(launcher, /spectra:autostart-initializing:\[\^"'\]\+/);
  assert.match(app, /!activeProfiles\.includes\(p\.id\)/);
  assert.doesNotMatch(launcher, /manualPause:\s*false/);
  assert.match(launcher, /Manual pause preserved; autostart skipped/);
  assert.match(launcher, /--disable-backgrounding-occluded-windows/);
  assert.match(launcher, /--disable-renderer-backgrounding/);
  assert.match(launcher, /--disable-background-timer-throttling/);
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
