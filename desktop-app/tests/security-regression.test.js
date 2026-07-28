const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const repoRoot = path.resolve(root, '..');
const read = relativePath => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

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
  assert.match(launcher, /options\.autoStartTwitterBot\s+\? startUrl\s+:\s+\(hasStagedCookies \? 'about:blank' : startUrl\)/);
  assert.match(launcher, /await importCookies\(\);\s+await openStartUrl\(\)/);
  assert.match(launcher, /CloseMainWindow\(\)/);
  assert.match(profileSync, /cloudSyncChecksumRevision:\s*revisionId/);
  assert.match(profileSync, /profile\.cloudSyncChecksumRevision === expectedRevision/);
});

test('bulk launch persists the complete bot state without a startup reload', () => {
  const launcher = read('desktop-app/src/main/puppeteer-launcher.ts');
  const app = read('desktop-app/src/renderer/App.tsx');
  assert.match(launcher, /spectra:auto-reply-autostart-ready/);
  assert.match(launcher, /autonomousPhase:\s*'requests'/);
  assert.match(launcher, /requestsWasIdle:\s*false/);
  assert.doesNotMatch(launcher, /window\.setTimeout\(\(\) => window\.location\.reload\(\)/);
  assert.match(app, /lastUrl:\s*'https:\/\/x\.com\/i\/chat\/requests'/);
  assert.match(launcher, /tab\.id !== target\.id/);
  assert.match(launcher, /chrome\.tabs\.create\(\{ url: START_URL, active: true \}\)/);
  assert.match(launcher, /closeOtherTabs:\s*options\.autoStartTwitterBot === true/);
  assert.match(launcher, /suppressExtensionInstallTabs\(runtimePath\)/);
  assert.match(launcher, /workerSource\.includes\('html\/initialSetup\.html'\)/);
});
