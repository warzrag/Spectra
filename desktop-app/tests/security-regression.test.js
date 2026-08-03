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

const getCookieSyncBackgroundSource = ({
  profileId,
  profileName,
  launchId,
  hasStagedCookies = false,
}) => {
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
    .replaceAll('${JSON.stringify(Boolean(targetTweetUrl))}', 'false')
    .replaceAll('${JSON.stringify(hasStagedCookies)}', JSON.stringify(hasStagedCookies))
    .replaceAll('${JSON.stringify(sessionImportAttemptId)}', JSON.stringify(''))
    .replaceAll('${this.localServerConfig?.port || 0}', '45678')
    .replaceAll("${JSON.stringify(this.localServerConfig?.token || '')}", JSON.stringify('test-token'))
    .replaceAll('\\\\', '\\');
};

const getVenusAutostartSource = ({
  profileId,
  profileName,
  launchId,
  venusVersion = '4.55.55',
}) => {
  const launcher = read('desktop-app/src/main/puppeteer-launcher.ts').replace(/\r\n/g, '\n');
  const marker = 'const autostartScript = `\n';
  const start = launcher.indexOf(marker);
  const end = launcher.indexOf('\n`;', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const { resolveVenusAutostartState } = loadTypeScriptModule(
    'desktop-app/src/main/venus-autostart-state.ts'
  );
  return launcher
    .slice(start + marker.length, end)
    .replaceAll('${JSON.stringify(launchContext.profileId)}', JSON.stringify(profileId))
    .replaceAll('${JSON.stringify(launchContext.profileName)}', JSON.stringify(profileName))
    .replaceAll('${JSON.stringify(launchContext.launchId)}', JSON.stringify(launchId))
    .replaceAll('${JSON.stringify(venusVersion)}', JSON.stringify(venusVersion))
    .replaceAll('${stateResolverSource}', resolveVenusAutostartState.toString())
    .replaceAll('\\\\', '\\');
};

test('X post links are normalized and non-post URLs are rejected', () => {
  const { normalizeTweetUrl } = loadTypeScriptModule(
    'desktop-app/src/shared/twitter-url.ts'
  );

  assert.equal(
    normalizeTweetUrl(' https://twitter.com/Spectra_Test/status/123456789?ref_src=twsrc '),
    'https://x.com/Spectra_Test/status/123456789'
  );
  assert.equal(
    normalizeTweetUrl('https://www.x.com/user/status/42/'),
    'https://x.com/user/status/42'
  );
  assert.equal(normalizeTweetUrl('https://x.com/home'), null);
  assert.equal(normalizeTweetUrl('http://x.com/user/status/42'), null);
  assert.equal(normalizeTweetUrl('https://example.com/user/status/42'), null);
  assert.equal(normalizeTweetUrl('javascript:alert(1)'), null);
});

test('manual and managed browser launches use isolated startup policies', () => {
  const {
    resolveLaunchMode,
    isManagedLaunch,
    shouldAppendLaunchUrl,
    shouldOpenSetupTab,
  } = loadTypeScriptModule('desktop-app/src/shared/launch-policy.ts');

  assert.equal(resolveLaunchMode({}), 'manual');
  assert.equal(resolveLaunchMode({ targetTweetUrl: 'https://x.com/user/status/1' }), 'open-post');
  assert.equal(resolveLaunchMode({ autoStartTwitterBot: true }), 'automation');
  assert.equal(resolveLaunchMode({ sessionImportAttemptId: 'attempt' }), 'session-import');

  assert.equal(isManagedLaunch('manual'), false);
  assert.equal(isManagedLaunch('open-post'), true);
  assert.equal(shouldAppendLaunchUrl('manual', true), false);
  assert.equal(shouldAppendLaunchUrl('manual', false), true);
  assert.equal(shouldAppendLaunchUrl('open-post', true), true);
  assert.equal(shouldOpenSetupTab('manual', false), true);
  assert.equal(shouldOpenSetupTab('manual', true), false);
  assert.equal(shouldOpenSetupTab('open-post', false), false);
});

test('manual windows are fitted to smaller displays without changing valid layouts', () => {
  const { fitWindowToWorkArea } = loadTypeScriptModule(
    'desktop-app/src/shared/launch-policy.ts'
  );
  const smallDisplay = { x: 0, y: 0, width: 800, height: 600 };

  assert.equal(
    fitWindowToWorkArea(
      { left: 20, top: 20, right: 720, bottom: 520 },
      smallDisplay
    ),
    null
  );
  assert.deepEqual(
    fitWindowToWorkArea(
      { left: 1200, top: 50, right: 2100, bottom: 770 },
      smallDisplay
    ),
    { left: 8, top: 8, right: 792, bottom: 592 }
  );
  assert.deepEqual(
    fitWindowToWorkArea(
      { left: -400, top: -300, right: 100, bottom: 200 },
      smallDisplay
    ),
    { left: 8, top: 8, right: 508, bottom: 508 }
  );
});

test('failed browser startups cannot trigger a profile upload', () => {
  const launcher = read('desktop-app/src/main/puppeteer-launcher.ts');
  const preload = read('desktop-app/src/main/preload.ts');
  const app = read('desktop-app/src/renderer/App.tsx');

  assert.match(launcher, /syncEligible:\s*false/);
  assert.match(launcher, /this\.activeProfiles\.set\(options\.profileId, profileInstance\);\s*profileInstance\.syncEligible = true/);
  assert.match(launcher, /if \(profileInstance\.syncEligible && !profileInstance\.closeNotified\)/);
  assert.match(launcher, /if \(instance\?\.syncEligible && !instance\.closeNotified\)/);
  assert.match(
    preload,
    /details\?: \{[\s\S]*syncEligible\?: boolean;[\s\S]*requiresPortableAuth\?: boolean;[\s\S]*reason\?: string;/
  );
  assert.match(app, /if \(details\?\.syncEligible === false\)/);
});

test('manual launches preserve the user window while managed launches keep equal sizing', () => {
  const launcher = read('desktop-app/src/main/puppeteer-launcher.ts');

  assert.match(
    launcher,
    /openSelectedWindow = \{\s*width: 620,\s*height: 520,\s*margin: 8,\s*gap: 8/
  );
  assert.match(
    launcher,
    /launchMode === 'automation'\s*\?\s*this\.openSelectedWindow\s*:\s*this\.compactWindow/
  );
  assert.match(
    launcher,
    /getWindowPlacement\(options\.windowLayout, launchMode\)/
  );
  assert.match(
    launcher,
    /if \(managedLaunch\) \{\s*args\.push\(`--window-size=\$\{compactWindowSize\}`\);\s*args\.push\(`--window-position=\$\{compactWindowPosition\}`\);/
  );
  assert.match(
    launcher,
    /if \(managedLaunch\) \{\s*this\.enforceWindowPlacement\(chromeProcess\.pid, placement\);\s*\}/
  );
  assert.match(
    launcher,
    /\.\.\.\(managedLaunch \? \[\{[\s\S]*js: \['x-cookie-consent\.js'\][\s\S]*\}\] : \[\]\)/
  );
});

test('stale cross-device profile uploads are rejected before the compatibility mirror changes', () => {
  const sync = read('desktop-app/src/renderer/services/profile-sync-service.ts');
  const conflictCheck = sync.indexOf('cloudVersion !== baseVersion || revisionConflict');
  const transactionUpdate = sync.indexOf('transaction.update(profileRef');
  const compatibilityMirror = sync.indexOf('Compatibility mirror for older Spectra clients');

  assert.notEqual(conflictCheck, -1);
  assert.notEqual(transactionUpdate, -1);
  assert.notEqual(compatibilityMirror, -1);
  assert.ok(conflictCheck < transactionUpdate);
  assert.ok(transactionUpdate < compatibilityMirror);
  assert.match(sync, /cloudProfile\.lockedBy !== currentUser\.uid/);
  assert.match(sync, /cloudProfile\.lockedByInstallationId !== currentUser\.installationId/);
  assert.match(sync, /conflictError\.code = 'profile-sync\/conflict'/);
});

test('folder post launch is isolated from Open Selected and retains one target tab', () => {
  const launcher = read('desktop-app/src/main/puppeteer-launcher.ts');
  const main = read('desktop-app/src/main/main.ts');
  const preload = read('desktop-app/src/main/preload.ts');
  const urlServer = read('desktop-app/src/main/url-server.ts');
  const app = read('desktop-app/src/renderer/App.tsx');
  const dashboard = read('desktop-app/src/renderer/pages/Dashboard.tsx');

  assert.match(main, /targetTweetUrl:\s*profileData\.targetTweetUrl/);
  assert.match(launcher, /normalizeTweetUrl\(options\.targetTweetUrl\)/);
  assert.match(launcher, /throw new Error\('Invalid X post URL'\)/);
  assert.match(launcher, /closeOtherTabs:\s*options\.autoStartTwitterBot === true \|\| Boolean\(targetTweetUrl\)/);
  assert.match(launcher, /likeTargetPost:\s*Boolean\(targetTweetUrl\)/);
  assert.match(launcher, /targetTweetUrl \|\| \(hasStagedCookies \? 'about:blank' : startUrl\)/);
  assert.match(launcher, /!options\.autoStartTwitterBot && !targetTweetUrl/);
  assert.match(launcher, /js:\s*\['open-post-actions\.js'\]/);
  assert.match(launcher, /run_at:\s*'document_idle'/);
  assert.match(launcher, /window\.__spectraOpenPostActionsStarted/);
  assert.match(launcher, /article\[data-testid="tweet"\]/);
  assert.match(launcher, /\[data-testid="unlike"\]/);
  assert.match(launcher, /\[data-testid="like"\]/);
  assert.match(launcher, /\[data-testid="tweetPhoto"\]/);
  assert.match(launcher, /actionBarOutsideViewport/);
  assert.match(launcher, /likeButton\.scrollIntoView\(\{ block: 'center'/);
  assert.match(launcher, /\[data-testid="unretweet"\]/);
  assert.match(launcher, /\[data-testid="retweet"\]/);
  assert.match(launcher, /\[data-testid="retweetConfirm"\]/);
  assert.match(launcher, /spectra:open-post-actions-complete/);
  assert.match(launcher, /spectra-open-post-overlay/);
  assert.match(launcher, /Actions terminées/);
  assert.match(launcher, /Instance ignorée/);
  assert.match(launcher, /Like confirmé/);
  assert.match(launcher, /Like non confirmé/);
  assert.match(launcher, /Repost confirmé/);
  assert.match(launcher, /Repost non confirmé/);
  assert.match(launcher, /Fermeture de l’instance/);
  assert.match(launcher, /Passage à l’instance suivante/);
  assert.match(launcher, /spectraOpenPostComplete = '1'/);
  assert.match(launcher, /const OPEN_POST_MODE =/);
  assert.match(launcher, /let openPostCompleted = false/);
  assert.match(launcher, /Completion marker detected/);
  assert.match(launcher, /if \(!openPostCompleted && !bootstrapComplete && !bootstrapPromise\)/);
  assert.match(launcher, /Actions finished; saving session before closing instance/);
  assert.match(launcher, /chrome\.windows\.remove\(sender\.tab\.windowId\)/);
  assert.match(launcher, /sendResponse\(\{ accepted: true \}\)/);
  assert.match(launcher, /for \(let attempt = 0; attempt < 5; attempt\+\+\)/);
  assert.match(launcher, /window\.location\.replace\(CLOSE_FALLBACK_URL\)/);
  assert.match(launcher, /requestProfileClose\('message'\)/);
  assert.match(launcher, /requestProfileClose\('watchdog'\)/);
  assert.match(launcher, /fetch\(SERVER \+ '\/api\/close-profile'/);
  assert.match(urlServer, /req\.url === '\/api\/close-profile'/);
  assert.match(urlServer, /requestUrl\.pathname === '\/api\/close-profile'/);
  assert.match(urlServer, /Navigation fallback received/);
  assert.match(urlServer, /internal:close-profile/);
  assert.match(main, /ipcMain\.on\('internal:close-profile'/);
  assert.match(main, /PuppeteerLauncher\.canAcceptOpenPostClose\(profileId\)/);
  assert.match(launcher, /pendingLaunchModes/);
  assert.match(launcher, /canAcceptOpenPostClose/);
  assert.match(
    launcher,
    /async function requestProfileClose\(source\) \{\s*if \(!OPEN_POST_MODE\)/
  );
  assert.match(
    launcher,
    /!OPEN_POST_MODE \|\|\s*message\?\.type !== 'spectra:open-post-actions-complete'/
  );
  assert.match(main, /PuppeteerLauncher\.forceCloseProfile\(profileId\)/);
  assert.match(preload, /forceClose: \(profileId: string\)/);
  assert.match(launcher, /private static cancelledProfiles = new Set<string>\(\)/);
  assert.match(launcher, /this\.cancelledProfiles\.has\(options\.profileId\)/);
  assert.match(launcher, /showResultOverlay\(success, likeConfirmed, repostConfirmed\)/);
  assert.match(launcher, /if \(targetTweetUrl\)[\s\S]*extensionName\.includes\('shadowban scanner'\)/);
  assert.match(launcher, /Shadowban Scanner skipped for Open post/);
  assert.match(launcher, /if \(LAUNCH_ID\) await reportLaunchStatus\('bootstrap-confirmed'/);
  assert.match(app, /targetTweetUrl:\s*normalizedUrl/);
  assert.match(app, /autoStartTwitterBot:\s*false/);
  assert.match(app, /const launchBatchSize = 1/);
  assert.match(app, /const launchStaggerMs = 0/);
  assert.match(launcher, /await wait\(800\)/);
  assert.match(app, /waitForBatchToClose = async \(profileIds: string\[\], timeoutMs = 60000\)/);
  assert.match(app, /waitForBatchToClose/);
  assert.match(app, /getRunning\(profileIds\)/);
  assert.match(app, /ignored: proxy too slow/);
  assert.match(app, /window\.electronAPI\.profiles\.forceClose\(profileId\)/);
  assert.match(app, /ignored \(timeout\)/);
  assert.match(app, /const handleStopOpenPost = async/);
  assert.match(app, /run\.cancelled = true/);
  assert.match(app, /__shouldCancel: \(\) => runState\.cancelled/);
  assert.match(app, /candidateProfileIds: profilesToLaunch\.map/);
  assert.match(app, /getRunning\(run\.candidateProfileIds\)/);
  assert.match(app, /Open post stopped — current instance closed/);
  assert.match(app, /batchStart \+= launchBatchSize/);
  assert.match(app, /await Promise\.all\(/);
  assert.match(app, /windowLayout:\s*\{\s*index:\s*batchIndex,\s*total:\s*batch\.length\s*\}/);
  assert.match(launcher, /compactWindow = \{ width: 900, height: 720/);
  assert.doesNotMatch(launcher, /--force-device-scale-factor/);
  assert.match(launcher, /x-cookie-consent\.js/);
  assert.match(launcher, /data-testid="BottomBar"/);
  assert.match(launcher, /rejectPattern/);
  assert.match(launcher, /for \(\$attempt = 0; \$attempt -lt 3; \$attempt\+\+\)/);
  assert.match(dashboard, /selectedFolderProfileIds = selectedProfiles\.filter/);
  assert.match(dashboard, /Open post \(\{selectedFolderProfileIds\.length\}\)/);
  assert.match(dashboard, /onOpenTweetInFolder\(selectedFolderProfileIds, normalizedTweetUrl\)/);
  assert.match(dashboard, /Arrêter tout/);
  assert.match(dashboard, /onClick=\{onStopOpenPost\}/);
});

test('launch-specific cookie extension workers are not reused across modes', () => {
  const launcher = read('desktop-app/src/main/puppeteer-launcher.ts');
  assert.match(
    launcher,
    /const cookieSyncExtensionVersion = \[[\s\S]*extensionVersionTime\.getUTCSeconds\(\)[\s\S]*\]\.join\('\.'\)/
  );
  assert.match(
    launcher,
    /name: 'Cookie Sync',\s*version: cookieSyncExtensionVersion/
  );
});

test('manual profile launches do not inherit managed OpenPost tab behavior', () => {
  const launcher = read('desktop-app/src/main/puppeteer-launcher.ts');

  assert.match(
    launcher,
    /isLegacyGoogleStartUrl/
  );
  assert.doesNotMatch(
    launcher,
    /isValidUrl\(options\.lastUrl \|\| ''\) \? options\.lastUrl! : 'https:\/\/www\.google\.com'/
  );
  assert.match(
    launcher,
    /isValidUrl\(savedUrl\) && !isLegacyGoogleStartUrl\(savedUrl\)/
  );
  assert.match(
    launcher,
    /const MANAGED_STARTUP_MODE = OPEN_POST_MODE \|\| Boolean\(LAUNCH_ID\) \|\| SESSION_IMPORT_MODE/
  );
  assert.match(
    launcher,
    /const ENFORCE_SINGLE_TAB = OPEN_POST_MODE \|\| Boolean\(LAUNCH_ID\)/
  );
  assert.match(
    launcher,
    /if \(MANAGED_STARTUP_MODE\) \{[\s\S]*bootstrap\(\)\.then\(\(tabId\) => startSessionImport\(tabId\)\)/
  );
  assert.match(
    launcher,
    /chrome\.tabs\.onCreated\.addListener\(\(tab\) => \{\s*if \(\s*ENFORCE_SINGLE_TAB/
  );
  assert.match(
    launcher,
    /async function runStartupWatchdog\(\) \{[\s\S]*if \(ENFORCE_SINGLE_TAB\) \{[\s\S]*chrome\.tabs\.remove/
  );
  assert.match(
    launcher,
    /\} else \{\s*importCookies\(\)\s*\.then\(async \(\) => \{\s*cookiesImported = true;\s*await resumeManualStartupAfterCookieImport\(\)/
  );
  assert.match(launcher, /Only reuse Spectra's[\s\S]*never close or replace an existing user tab/);
  assert.match(launcher, /tabs\.find\(\(tab\) => tab\.id && isStartupJunkTab\(tab\)\)/);
  assert.match(launcher, /Temporary tab resumed immediately/);
  assert.match(
    launcher,
    /resumeManualStartupAfterCookieImport\(\)[\s\S]*\^https\?:\\\\\/\\\\\//
  );
});

test('authenticated X sessions survive fast closes and cross-device sync', () => {
  const main = read('desktop-app/src/main/main.ts');
  const launcher = read('desktop-app/src/main/puppeteer-launcher.ts');
  const sync = read('desktop-app/src/main/profile-sync.ts');
  const preload = read('desktop-app/src/main/preload.ts');
  const app = read('desktop-app/src/renderer/App.tsx');
  const urlServer = read('desktop-app/src/main/url-server.ts');
  const { hasAuthenticatedXSession } = loadTypeScriptModule(
    'desktop-app/src/shared/x-auth-snapshot.ts'
  );

  const future = 2_000_000_000;
  assert.equal(hasAuthenticatedXSession([
    { name: 'auth_token', value: 'auth', domain: '.x.com', expirationDate: future },
    { name: 'ct0', value: 'csrf', domain: '.x.com', expirationDate: future },
  ], 1_900_000_000), true);
  assert.equal(hasAuthenticatedXSession([
    { name: 'auth_token', value: 'auth', domain: '.x.com', expirationDate: 1_800_000_000 },
    { name: 'ct0', value: 'csrf', domain: '.x.com', expirationDate: future },
  ], 1_900_000_000), false);

  assert.match(main, /hasAuthenticatedXSession\(cookies\)/);
  assert.match(main, /authenticated_cookies\.json/);
  assert.match(main, /protected X snapshot retained/);
  assert.match(main, /profile:authenticatedXSnapshotSaved/);
  assert.match(main, /authenticatedSnapshotNotifications\.delete\(profileId\)/);
  assert.match(main, /notificationRequired/);
  assert.match(urlServer, /Cookie snapshot was not acknowledged/);
  assert.match(urlServer, /res\.end\(JSON\.stringify\(saveResult\)\)/);
  assert.match(sync, /'authenticated_cookies\.json'/);
  assert.match(launcher, /ensureAuthenticatedXSnapshot/);
  assert.match(launcher, /missing-authenticated-x-snapshot/);
  assert.match(launcher, /if \(authenticationCookieChanged\) \{\s*exportCookies\(\)/);
  assert.match(launcher, /chrome\.windows\?\.onRemoved\?\.addListener/);
  assert.match(preload, /profile:hasAuthenticatedXSnapshot/);
  assert.match(app, /not synchronized: authenticated X snapshot is missing/);
  assert.match(app, /non synchronisé : aucune session X connectée détectée/);
  assert.match(launcher, /const syncedIsAuthenticated =/);
  assert.match(launcher, /const protectedIsAuthenticated =/);
  assert.match(launcher, /const syncedIsNewer =/);
  assert.match(launcher, /protectedIsAuthenticated[\s\S]*authenticatedCookiesPath/);
  assert.match(launcher, /async function flushCookiesBeforeClose\(\)/);
  assert.match(launcher, /Authenticated X snapshot acknowledged by Spectra/);
  assert.match(launcher, /authenticationRetryTimer = setTimeout/);
  assert.match(launcher, /showAuthenticatedSnapshotConfirmation/);
  assert.match(launcher, /result\.notificationRequired === true/);
  assert.match(launcher, /spectra-session-saved-toast/);
  assert.match(launcher, /Session X enregistr/);
  assert.match(launcher, /if \(OPEN_POST_MODE\) return/);
  assert.match(
    launcher,
    /async function requestProfileClose\(source\) \{[\s\S]*if \(!OPEN_POST_MODE\)[\s\S]*await flushCookiesBeforeClose\(\)/
  );
  assert.match(launcher, /setInterval\(exportCookies, 1000\)/);
  assert.match(launcher, /await new Promise\(resolve => setTimeout\(resolve, 1100\)\)/);
  assert.match(preload, /onAuthenticatedXSnapshotSaved/);
  assert.match(app, /session X enregistr/);
});

test('cloud profile downloads use authenticated Electron transport instead of renderer XHR', () => {
  const main = read('desktop-app/src/main/main.ts');
  const preload = read('desktop-app/src/main/preload.ts');
  const sync = read('desktop-app/src/renderer/services/profile-sync-service.ts');

  assert.doesNotMatch(sync, /\bgetBlob\b/);
  assert.match(sync, /auth\.currentUser\?\.getIdToken\(\)/);
  assert.match(sync, /profileSync\.downloadFromCloud/);
  assert.match(preload, /profileSync:downloadFromCloud/);
  assert.match(preload, /profileSync:downloadProgress/);
  assert.match(main, /ipcMain\.handle\(\s*'profileSync:downloadFromCloud'/);
  assert.match(main, /url\.hostname !== 'firebasestorage\.googleapis\.com'/);
  assert.match(main, /objectPath\.startsWith\(`profiles\/\$\{profileId\}\/`\)/);
  assert.match(main, /Authorization: `Bearer \$\{idToken\}`/);
});

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

test('VA Manager integration encrypts cookie write-back and remains isolated from Open Post', () => {
  const client = read('desktop-app/src/main/va-manager-client.ts');
  const main = read('desktop-app/src/main/main.ts');
  const preload = read('desktop-app/src/main/preload.ts');
  const page = read('desktop-app/src/renderer/pages/VaManagerPage.tsx');
  const app = read('desktop-app/src/renderer/App.tsx');

  assert.match(client, /safeStorage\.encryptString/);
  assert.match(client, /safeStorage\.decryptString/);
  assert.doesNotMatch(client, /store\.set\([^)]*password/i);
  assert.match(client, /table:\s*'twitter_accounts'[\s\S]*action:\s*'select'/);
  assert.match(client, /table:\s*'twitter_stats'[\s\S]*action:\s*'select'/);
  assert.doesNotMatch(client, /action:\s*'(upsert|delete)'/);
  assert.match(client, /syncAuthenticatedXCookiesToVaManager/);
  assert.match(client, /AES-GCM/);
  assert.match(client, /createHash\('sha256'\)/);
  assert.match(client, /SPECTRA_COOKIES:v1/);
  assert.match(client, /action:\s*'update'/);
  assert.match(client, /fillMissingVaManagerAccountInformation/);
  assert.match(client, /table:\s*'gmail_accounts'[\s\S]*action:\s*'insert'/);
  assert.match(client, /currentXPasswordIsEmail/);
  assert.match(client, /repairedMisplacedPasswords/);
  assert.match(client, /currentNotes[\s\S]*\[2FA:\$\{twoFa\}\]/);
  assert.match(client, /\['organization_id',\s*'eq',\s*account\.organizationId\]/);
  assert.match(client, /\['id',\s*'eq',\s*account\.id\]/);
  assert.match(main, /queueVaManagerCookieSync\(profileId, cookies\)/);
  assert.match(main, /profileVaManagerLinks/);
  assert.match(main, /vaManager:syncProfileCookies/);
  assert.match(main, /authenticated_cookies\.json/);
  assert.match(preload, /syncProfileCookies/);
  assert.doesNotMatch(preload, /auth_token|ct0/);
  assert.match(preload, /vaManager:listAccounts/);
  assert.match(page, /findLinkedProfile/);
  assert.match(page, /Cookies X synchronis/);
  assert.match(page, /attemptedExistingCookieSyncs/);
  assert.match(page, /Plus d’abonnés/);
  assert.match(app, /case 'va-manager'/);
  assert.doesNotMatch(page, /Open post|onOpenTweetInFolder|targetTweetUrl/);
});

test('VA Manager audit separates Anto accounts without exposing decrypted credentials', () => {
  const client = read('desktop-app/src/main/va-manager-client.ts');
  const page = read('desktop-app/src/renderer/pages/VaManagerPage.tsx');

  assert.match(client, /table:\s*'gmail_accounts'[\s\S]*action:\s*'select'/);
  assert.match(client, /'\/api\/org-password-key'[\s\S]*action:\s*'get'/);
  assert.match(client, /canDecryptCredential/);
  assert.match(client, /hasPassword:\s*Boolean\(account\.encrypted_password\)/);
  assert.match(client, /passwordUsable/);
  assert.match(client, /hasTwoFa/);
  assert.match(client, /hasAuthToken/);
  assert.match(client, /hasCookies/);
  assert.match(client, /hasEmailPassword/);
  assert.doesNotMatch(client, /return\s*\{[\s\S]{0,500}(password|twoFa|authToken):\s*(decrypted|notes)/i);

  assert.match(page, /Instances déjà créées/);
  assert.match(page, /Instances à créer/);
  assert.match(page, /Informations manquantes/);
  assert.match(page, /Prêts à créer et connecter/);
  assert.match(page, /getMissingInformation\(account\)/);
  assert.match(page, /auditFilter === 'ready'\) return !linked && complete/);
  assert.match(page, /Mot de passe X illisible/);
  assert.match(page, /Mot de passe email illisible/);
  const missingAudit = page.slice(
    page.indexOf('function getMissingInformation'),
    page.indexOf('const statusStyle')
  );
  assert.doesNotMatch(missingAudit, /hasAuthToken|auth_token/);
});

test('VA Manager creates ready instances idempotently without sending secrets to the renderer', () => {
  const client = read('desktop-app/src/main/va-manager-client.ts');
  const main = read('desktop-app/src/main/main.ts');
  const preload = read('desktop-app/src/main/preload.ts');
  const app = read('desktop-app/src/renderer/App.tsx');
  const page = read('desktop-app/src/renderer/pages/VaManagerPage.tsx');

  assert.match(client, /getVaManagerSessionImportCredentials/);
  assert.match(client, /table:\s*'twitter_accounts'[\s\S]*action:\s*'select'/);
  assert.match(client, /decryptCredential/);
  assert.match(main, /sessionImport:runVaManager/);
  assert.match(main, /getVaManagerSessionImportCredentials\([\s\S]*runSessionImport/);
  assert.match(main, /credentials\.password = ''/);
  assert.match(main, /credentials\.totpSecret = ''/);
  assert.match(preload, /runVaManager:\s*\(profileData: any, organizationId: string, accountId: string\)/);
  assert.doesNotMatch(preload, /runVaManager:[\s\S]{0,180}(password|totpSecret)/);

  assert.match(app, /handleCreateVaManagerInstances/);
  assert.match(app, /proxyIdentityKey/);
  assert.match(app, /vaManagerAccountId:\s*account\.id/);
  assert.match(app, /vaManagerOrganizationId:\s*account\.organizationId \|\| organizationId/);
  assert.match(app, /vaManagerLoginStatus:\s*'pending'/);
  assert.match(app, /vaManagerLoginStatus:\s*'connected'/);
  assert.match(app, /handleRetryVaManagerConnection/);
  assert.match(app, /existingAccountIds\.has\(account\.id\)/);
  assert.match(app, /Math\.max\(0,\s*3 - \(usageByProxy\.get\(key\) \|\| 0\)\)/);
  assert.match(app, /pendingAccounts\.slice\(0,\s*validSlots\.length\)/);
  assert.match(app, /en attente de proxy/);
  assert.match(app, /window\.electronAPI\.proxy\.test\(proxy\)/);
  assert.match(app, /fingerprint\.generate\(\s*'windows',\s*'chrome',\s*proxy\.country \|\| 'US'/);
  assert.match(app, /country:\s*proxy\.country \|\| 'US'/);
  assert.match(app, /language:\s*'en-US',\s*languages:\s*\['en-US',\s*'en'\]/);
  assert.match(app, /fingerprint:\s*usFingerprint/);
  assert.match(app, /sessionImport\.runVaManager\(/);
  assert.match(page, /Créer et connecter les prêts/);
  assert.match(page, /Réessayer/);
  assert.match(page, /onStopImport/);
  assert.doesNotMatch(page, /Open post|onOpenTweetInFolder|targetTweetUrl/);
});

test('proxy imports ignore duplicates without merging distinct provider credentials', () => {
  const identity = read('desktop-app/src/shared/proxy-identity.ts');
  const proxyPage = read('desktop-app/src/renderer/pages/ProxyManager.tsx');
  const firestore = read('desktop-app/src/renderer/services/firestore-service.ts');

  assert.match(identity, /proxyIdentityKey/);
  assert.match(identity, /proxy\.type/);
  assert.match(identity, /proxy\.host/);
  assert.match(identity, /proxy\.port/);
  assert.match(identity, /proxy\.username/);
  assert.doesNotMatch(identity, /proxy\.password/);
  assert.match(identity, /SHA-256/);
  assert.match(proxyPage, /filter\(proxy => !teamId \|\| proxy\.teamId === teamId\)/);
  assert.match(proxyPage, /\.map\(proxyIdentityKey\)/);
  assert.match(proxyPage, /knownKeys\.has\(key\)/);
  assert.match(proxyPage, /const bulkAnalysis = analyzeBulkProxyText\(\)/);
  assert.match(proxyPage, /Doublons ignorés/);
  assert.match(proxyPage, /disabled=\{bulkAnalysis\.parsed\.length === 0 \|\| adding\}/);
  assert.match(proxyPage, /doublon/);
  assert.match(firestore, /proxyDocumentId\(teamId, proxy\)/);
  assert.match(firestore, /doc\(db, PROXIES_COLLECTION, deterministicId\)/);
});

test('VA Manager accounts link to existing Spectra profiles by stable id before username', () => {
  const { findLinkedProfile, normalizeXUsername } = loadTypeScriptModule(
    'desktop-app/src/shared/va-manager.ts'
  );
  const profiles = [
    { id: 'profile-1', name: 'X — noonine91', vaManagerAccountId: 'account-1' },
    { id: 'profile-2', name: '@another_account' },
  ];

  assert.equal(normalizeXUsername('https://x.com/NooNine91/status/123'), 'noonine91');
  assert.equal(
    findLinkedProfile({ id: 'account-1', username: 'different_name' }, profiles).id,
    'profile-1'
  );
  assert.equal(
    findLinkedProfile({ id: 'account-2', username: 'another_account' }, profiles).id,
    'profile-2'
  );
  assert.equal(
    findLinkedProfile(
      { id: 'account-3', username: 'noonine91' },
      [{ id: 'profile-3', name: 'noonine91', vaManagerAccountId: 'another-account' }]
    ),
    undefined
  );
});

test('VA Manager links are explicit, reversible, and reject duplicate profile assignments', () => {
  const page = read('desktop-app/src/renderer/pages/VaManagerPage.tsx');
  const app = read('desktop-app/src/renderer/App.tsx');

  assert.match(page, /vaManagerAccountId === account\.id \? 'Liaison confirmée' : 'Correspondance détectée'/);
  assert.match(page, /Confirmer la liaison/);
  assert.match(page, /Lier une instance/);
  assert.match(page, /vaManagerAccountId:\s*account\.id/);
  assert.match(page, /vaManagerOrganizationId:\s*account\.organizationId \|\| organizationId/);
  assert.match(page, /vaManagerAccountId:\s*null/);
  assert.match(page, /vaManagerOrganizationId:\s*null/);
  assert.match(page, /Ce compte est déjà lié à l’instance/);
  assert.match(page, /est déjà liée à un autre compte/);
  assert.match(app, /handleUpdateVaManagerLink/);
  assert.match(app, /firestoreUpdateProfile\(profileId, profileData\)/);
});

test('session import accepts TXT, JSONL and JSON without exposing secrets', () => {
  const { parseSessionImportFile } = loadTypeScriptModule(
    'desktop-app/src/shared/session-import.ts'
  );
  assert.deepEqual(
    parseSessionImportFile('alice|password-1|JBSWY3DPEHPK3PXP'),
    [{ username: 'alice', password: 'password-1', totpSecret: 'JBSWY3DPEHPK3PXP' }]
  );
  assert.equal(
    parseSessionImportFile(
      '{"username":"alice","password":"one","totp_secret":"JBSWY3DPEHPK3PXP"}\n' +
      '{"username":"bob","password":"two","totp_secret":"JBSWY3DPEHPK3PXQ"}'
    ).length,
    2
  );
  assert.equal(
    parseSessionImportFile(JSON.stringify([
      { username: '@alice', password: 'one', totp_secret: 'JBSW Y3DP EHPK 3PXP' },
    ]))[0].username,
    'alice'
  );
  assert.throws(
    () => parseSessionImportFile('alice|one|JBSWY3DPEHPK3PXP\nalice|two|JBSWY3DPEHPK3PXQ'),
    /dupliqu/
  );

  const app = read('desktop-app/src/renderer/App.tsx');
  const launcher = read('desktop-app/src/main/puppeteer-launcher.ts');
  const server = read('desktop-app/src/main/url-server.ts');
  assert.match(app, /3 - \(usageByProxy\.get\(key\) \|\| 0\)/);
  assert.match(app, /window\.electronAPI\.proxy\.test\(proxy\)/);
  assert.match(app, /account\.password = ''/);
  assert.doesNotMatch(app, /localStorage\.setItem\([^)]*session/i);
  assert.match(server, /sessionImportCredentials\.delete\(attemptId\)/);
  assert.match(server, /Cache-Control.*no-store/);
  assert.match(launcher, /code 2FA/);
  assert.match(launcher, /crypto\.subtle\.sign\('HMAC'/);
  assert.match(launcher, /credentials\.password = ''/);
  assert.doesNotMatch(launcher, /JSON\.stringify\(options\.sessionImport\?\.password/);
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

test('super admins work inside one explicitly selected agency workspace', () => {
  const app = read('desktop-app/src/renderer/App.tsx');
  const sidebar = read('desktop-app/src/renderer/components/Sidebar.tsx');

  assert.match(app, /const scopeTeamId = activeWorkspaceTeamIds\.length/);
  assert.match(app, /subscribeToProxies\(scopeTeamId, setProxies\)/);
  assert.match(app, /spectra-active-workspace:/);
  assert.match(app, /findUserByEmail\(email\)/);
  assert.match(app, /getTeamsByOwnerId\(ownerId\)/);
  assert.match(app, /spectra-active-workspace-teams:/);
  assert.doesNotMatch(app, /const scopeTeamId = user\.role === 'super_admin' \? null/);
  assert.match(sidebar, /Active workspace/);
  assert.match(sidebar, /Owner or member email/);
  assert.match(sidebar, /onOpenWorkspace/);
  const dashboard = read('desktop-app/src/renderer/pages/Dashboard.tsx');
  assert.match(dashboard, /workspaceTitle/);
  assert.doesNotMatch(dashboard, /isSuperAdmin \? \(/);
});

test('Chrome launch waits for a visible window and repairs stale singleton files', () => {
  const launcher = read('desktop-app/src/main/puppeteer-launcher.ts');
  assert.match(launcher, /waitForVisibleWindow/);
  assert.match(launcher, /\$preferredPid = \$\{preferredPid\}/);
  assert.match(launcher, /Get-Process -Id \$preferredPid/);
  assert.match(launcher, /waitForVisibleWindow\(\s*profilePath,\s*12000,\s*chromeProcess\.pid/);
  assert.match(launcher, /terminateProfileProcesses/);
  assert.match(launcher, /stale process\(es\) without a visible window/);
  assert.match(launcher, /clearStaleSingletonFiles/);
  assert.match(launcher, /Chrome started but no visible window appeared/);
  assert.match(launcher, /Browser handoff detected/);
  assert.match(launcher, /monitorHandedOffBrowser/);
  assert.match(launcher, /const profileProcessIds = process\.platform === 'win32'/);
  assert.match(launcher, /if \(process\.platform === 'win32'\) \{\s+if \(!instance\?\.profilePath\)/);
});

test('cookie import targets the file consumed by the runtime importer', () => {
  const main = read('desktop-app/src/main/main.ts');
  assert.match(main, /cookieStagingPath = path\.join\(profileDir, 'synced_cookies\.json'\)/);
  assert.doesNotMatch(main, /cookieStagingPath = path\.join\(profileDir, 'pending_cookies\.json'\)/);
});

test('cross-device cookies are restored before navigation and Chrome closes gracefully', () => {
  const launcher = read('desktop-app/src/main/puppeteer-launcher.ts');
  const profileSync = read('desktop-app/src/renderer/services/profile-sync-service.ts');
  assert.match(launcher, /options\.autoStartTwitterBot\s*\?\s*startUrl\s*:\s*\(targetTweetUrl \|\| \(hasStagedCookies \? 'about:blank' : startUrl\)\)/);
  assert.match(launcher, /Promise\.race\(\[\s*chrome\.cookies\.set\(details\)/);
  assert.match(launcher, /Cookie import timed out/);
  assert.match(launcher, /await importCookies\(\);\s+cookiesImported = true/);
  assert.match(launcher, /const tabId = await openStartUrl\(\)/);
  assert.match(launcher, /await reportLaunchStatus\('bootstrap-confirmed'[\s\S]*bootstrapComplete = true/);
  assert.match(launcher, /CloseMainWindow\(\)/);
  assert.match(profileSync, /cloudSyncChecksumRevision:\s*revisionId/);
  assert.match(profileSync, /profile\.cloudSyncChecksumRevision === expectedRevision/);
});

test('Open Selected always starts a fresh VenusBot cycle on Requests', () => {
  const { resolveVenusAutostartState } = loadTypeScriptModule(
    'desktop-app/src/main/venus-autostart-state.ts'
  );
  const now = 1_800_000;

  const firstStartup = resolveVenusAutostartState({}, now);
  assert.equal(firstStartup.valid, false);
  assert.equal(firstStartup.phase, 'requests');
  assert.equal(firstStartup.phaseStartTime, now);
  assert.equal(firstStartup.updates.autonomousPhaseStartTime, now);
  assert.equal(firstStartup.targetUrl, 'https://x.com/i/chat/requests');

  const dms = resolveVenusAutostartState({
    autonomousPhase: 'dms',
    autonomousPhaseStartTime: now - 120_000,
    autonomousDmsTime: 10,
  }, now);
  assert.equal(dms.valid, false);
  assert.equal(dms.phase, 'requests');
  assert.equal(dms.phaseStartTime, now);
  assert.equal(dms.remainingMilliseconds, null);
  assert.equal(dms.targetUrl, 'https://x.com/i/chat/requests');
  assert.equal(dms.updates.autonomousPhase, 'requests');
  assert.equal(dms.updates.autonomousPhaseStartTime, now);
  assert.equal(dms.updates.requestsWasIdle, false);

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
    Array.from({ length: 5 }, () => now)
  );

  const ownedCommand = resolveVenusAutostartState({
    autonomousPhase: 'dms',
    autonomousPhaseStartTime: now - 120_000,
    autonomousDmsTime: 10,
  }, now, 'launch-test');
  assert.equal(ownedCommand.updates.spectraPendingLaunchId, 'launch-test');
});

test('Open Selected accepts the retained tab-id marker and stages one real VenusBot command', () => {
  const launchId = 'launch-tab-contract';
  const source = getVenusAutostartSource({
    profileId: 'profile-tab-contract',
    profileName: 'Tab Contract',
    launchId,
  });
  const sessionValues = new Map([
    [`spectra:startup-tabs-ready:${launchId}`, '321'],
  ]);
  const state = {};
  const writes = [];
  let reloadCount = 0;

  const sessionStorage = {
    getItem: key => sessionValues.has(key) ? sessionValues.get(key) : null,
    setItem: (key, value) => sessionValues.set(key, String(value)),
    removeItem: key => sessionValues.delete(key),
  };
  const location = {
    href: 'https://x.com/i/chat/requests',
    pathname: '/i/chat/requests',
    reload: () => {
      reloadCount++;
    },
  };
  const chrome = {
    runtime: { lastError: null },
    storage: {
      local: {
        get: (_keys, callback) => callback({ ...state }),
        set: (updates, callback) => {
          Object.assign(state, updates);
          writes.push({ ...updates });
          callback?.();
        },
        remove: (keys, callback) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
          callback?.();
        },
      },
    },
  };
  const document = {
    readyState: 'complete',
    querySelector: selector => {
      if (selector.includes('autocomplete=') || selector.includes('loginButton')) return null;
      if (selector.includes('AppTabBar_Home_Link')) return {};
      if (selector.includes('#react-root')) return {};
      return null;
    },
  };
  const window = {
    location,
    setTimeout: callback => callback(),
    twitterAutoReplyBot: null,
    venusSecurityLabBot: null,
  };
  const context = {
    chrome,
    console,
    document,
    location,
    sessionStorage,
    window,
    Date,
    Math,
    Set,
    String,
    Boolean,
  };

  vm.runInNewContext(source, context, { filename: 'spectra-autostart.js' });

  assert.equal(writes.length, 1);
  assert.equal(writes[0].pendingAutoStart, true);
  assert.equal(writes[0].pendingMode, 'autonomous');
  assert.equal(writes[0].spectraPendingLaunchId, launchId);
  assert.equal(reloadCount, 1);
  assert.equal(
    sessionValues.get(`spectra:autostart-command-sent:${launchId}`),
    '1'
  );

  state.isEnabled = true;
  state.mode = 'autonomous';
  window.twitterAutoReplyBot = {
    isRunning: true,
    autonomousCycleRunning: true,
    isEnabled: true,
  };
  vm.runInNewContext(source, context, { filename: 'spectra-autostart-reload.js' });

  assert.equal(
    sessionValues.get(`spectra:autostart-confirmed:${launchId}`),
    '1'
  );
});

test('Open Selected coordinates one exact startup tab and one VenusBot start command', () => {
  const launcher = read('desktop-app/src/main/puppeteer-launcher.ts');
  const main = read('desktop-app/src/main/main.ts');
  const urlServer = read('desktop-app/src/main/url-server.ts');
  const app = read('desktop-app/src/renderer/App.tsx');
  assert.match(launcher, /require\('crypto'\)\.randomUUID\(\)/);
  assert.match(launcher, /spectra:startup-tabs-ready:/);
  assert.match(launcher, /if \(!sessionStorage\.getItem\(READY_MARKER\)\)/);
  assert.doesNotMatch(launcher, /sessionStorage\.getItem\(READY_MARKER\) !== '1'/);
  assert.match(launcher, /String\(tabId\)/);
  assert.match(launcher, /spectra:autostart-command-sent:/);
  assert.match(launcher, /spectra:autostart-confirmed:/);
  assert.match(launcher, /manifest\.version_name = venusVersion/);
  assert.match(launcher, /manifest\.version = this\.nextVenusRuntimeVersion/);
  assert.match(launcher, /\.spectra-venus-runtime-version\.json/);
  assert.doesNotMatch(launcher, /spectraBackgroundAutostartLaunchId/);
  assert.doesNotMatch(launcher, /SPECTRA_VENUS_AUTOSTART_BEGIN/);
  assert.match(launcher, /const pendingGuard = 'if\(e\.pendingAutoStart&&!e\.manualPause\)\{'/);
  assert.match(
    launcher,
    /chrome\.storage\.local\.remove\(\['pendingAutoStart','pendingMode','autonomousPhase','spectraPendingLaunchId'\]\)/
  );
  assert.match(
    launcher,
    /bot && bot\.isRunning === true && bot\.autonomousCycleRunning === true/
  );
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
  assert.match(launcher, /data-testid="primaryColumn"/);
  assert.match(launcher, /input\[autocomplete="username"\]/);
  assert.match(launcher, /X application ready in compact layout/);
  assert.match(app, /lastUrl:\s*'https:\/\/x\.com\/i\/chat\/requests'/);
  assert.match(app, /autoStartTwitterBot:\s*true/);
  assert.match(launcher, /chrome\.tabs\.create\(\{ url: startUrl, active: true \}\)/);
  assert.match(launcher, /let retainedTabId = null/);
  assert.match(launcher, /tab\.id !== retainedTabId/);
  assert.match(launcher, /chrome\.tabs\.get\(retainedTabId\)/);
  assert.match(launcher, /target:\s*\{ tabId: retainedTabId \}/);
  assert.match(launcher, /return retainedTabId/);
  assert.match(launcher, /options\.autoStartTwitterBot\s*\?\s*startUrl/);
  assert.match(launcher, /startupTabsMarkerDeadline = Date\.now\(\) \+ 5000/);
  assert.match(launcher, /Single-tab marker delayed; using Requests fallback/);
  assert.doesNotMatch(launcher, /createStartupTabCleanerExtension/);
  assert.match(launcher, /let bootstrapComplete = false/);
  assert.match(launcher, /BOOTSTRAP_ATTEMPTS = 5/);
  assert.match(launcher, /RETRY_DELAYS = \[1000, 2000, 4000, 8000, 12000\]/);
  assert.match(launcher, /WATCHDOG_DEADLINE = Date\.now\(\) \+ \(OPEN_POST_MODE \? 120000 : 60000\)/);
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
  assert.match(launcher, /closeOtherTabs:\s*options\.autoStartTwitterBot === true \|\| Boolean\(targetTweetUrl\)/);
  assert.match(launcher, /getChromeExtensionId\(runtimePath\)/);
  assert.match(launcher, /shadowbanSetupUrl\s*=/);
  assert.match(launcher, /html\/initialSetup\.html/);
  assert.match(launcher, /Shadowban Scanner skipped for Open Selected/);
  assert.match(
    launcher,
    /\(targetTweetUrl \|\| options\.autoStartTwitterBot === true\)[\s\S]*extensionName\.includes\('shadowban scanner'\)/
  );
  assert.match(launcher, /Opening the standard Shadowban setup tab/);
  assert.doesNotMatch(launcher, /Shadowban initial setup suppressed/);
  assert.doesNotMatch(launcher, /const spectraTabsCreate = chrome\.tabs\.create/);
  assert.match(launcher, /autonomousPhaseStartTime\|manualPause\|spectraPendingLaunchId/);
  assert.doesNotMatch(launcher, /e\.spectraPendingLaunchId===/);
  assert.match(launcher, /spectra:autostart-initializing:\[\^"'\]\+/);
  assert.match(app, /!activeProfiles\.includes\(p\.id\)/);
  assert.doesNotMatch(launcher, /manualPause:\s*false/);
  assert.match(launcher, /Manual pause preserved; autostart skipped/);
  assert.match(launcher, /VenusBot is unavailable or incompatible/);
  assert.match(launcher, /--disable-backgrounding-occluded-windows/);
  assert.match(launcher, /--disable-renderer-backgrounding/);
  assert.match(launcher, /--disable-background-timer-throttling/);
  assert.match(launcher, /pendingProfiles\.add\(options\.profileId\)/);
  assert.match(launcher, /void launchConfirmationPromise\s*\.then\(launchStatus =>/);
  assert.doesNotMatch(launcher, /await launchConfirmationPromise/);
  assert.match(launcher, /closed before VenusBot confirmation/);
  assert.match(launcher, /running\.has\(id\) && !this\.pendingProfiles\.has\(id\)/);
  assert.match(urlServer, /req\.url === '\/api\/launch-status'/);
  assert.match(main, /internal:launch-status/);
});

test('manual cross-device launch replaces only the temporary blank tab after cookie import', async () => {
  const tabs = [
    { id: 1, url: 'about:blank', status: 'complete', active: true },
    { id: 2, url: 'https://example.com/kept-by-user', status: 'complete', active: false },
  ];
  const updatedTabIds = [];
  const removedTabIds = [];
  const importedCookies = [];

  const chrome = {
    runtime: {
      getURL: file => `chrome-extension://cookie-sync/${file}`,
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} },
      onSuspend: { addListener() {} },
    },
    cookies: {
      set: async cookie => { importedCookies.push(cookie); },
      getAll: async () => [],
      onChanged: { addListener() {} },
    },
    tabs: {
      query: async () => tabs.map(tab => ({ ...tab })),
      update: async (tabId, properties) => {
        const tab = tabs.find(candidate => candidate.id === tabId);
        if (!tab) throw new Error('tab not found');
        Object.assign(tab, properties, { status: 'complete' });
        updatedTabIds.push(tabId);
        return { ...tab };
      },
      remove: async tabId => {
        removedTabIds.push(tabId);
        const index = tabs.findIndex(tab => tab.id === tabId);
        if (index >= 0) tabs.splice(index, 1);
      },
      onCreated: { addListener() {} },
    },
    alarms: {
      clear: async () => true,
      onAlarm: { addListener() {} },
    },
  };

  const fetch = async url => {
    if (String(url).endsWith('/cookies.json')) {
      return {
        ok: true,
        json: async () => [{
          name: 'auth_token',
          value: 'portable-session',
          domain: '.x.com',
          path: '/',
        }],
      };
    }
    if (String(url).endsWith('/start_url.json')) {
      return {
        ok: true,
        json: async () => ({ startUrl: 'https://x.com/home', closeOtherTabs: false }),
      };
    }
    if (String(url).endsWith('/api/save-cookies')) return { ok: true };
    throw new Error(`Unexpected URL: ${url}`);
  };

  const source = getCookieSyncBackgroundSource({
    profileId: 'manual_profile',
    profileName: 'Manual Profile',
    launchId: '',
    hasStagedCookies: true,
  });
  vm.runInNewContext(source, {
    chrome,
    fetch,
    console,
    setTimeout: (callback, delay = 0) => setTimeout(callback, Math.min(delay, 5)),
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    Promise,
    JSON,
    RegExp,
    String,
    Error,
  }, { filename: 'cookie-sync-manual-fast-start.js' });

  await new Promise(resolve => setTimeout(resolve, 30));

  assert.equal(importedCookies.length, 1);
  assert.deepEqual(updatedTabIds, [1]);
  assert.deepEqual(removedTabIds, []);
  assert.equal(tabs[0].url, 'https://x.com/home');
  assert.equal(tabs[1].url, 'https://example.com/kept-by-user');
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
  assert.match(launcher, /const fp = \{ \.\.\.effectiveFingerprint, userAgent, platform \}/);
});

test('team deletion is targeted and refuses teams that still own resources', () => {
  const admin = read('desktop-app/src/renderer/pages/AdminPage.tsx');
  assert.match(admin, /TEAM_RESOURCE_COLLECTIONS/);
  assert.match(admin, /where\('teamId', '==', teamId\)/);
  assert.match(admin, /Suppression refusée : team utilisée/);
  assert.match(admin, /deleteDoc\(doc\(db, 'teams', teamId\)\)/);
  assert.doesNotMatch(admin, /const ownerTeams = teams\.filter/);
});

test('profile-specific fingerprint repairs persist without changing other profiles', () => {
  const launcher = read('desktop-app/src/main/puppeteer-launcher.ts');
  const sync = read('desktop-app/src/main/profile-sync.ts');

  assert.match(launcher, /const fingerprintOverridePath = path\.join\(profilePath, 'fingerprint_override\.json'\)/);
  assert.match(launcher, /effectiveFingerprint = \{ \.\.\.effectiveFingerprint, \.\.\.override \}/);
  assert.match(launcher, /const fp = \{ \.\.\.effectiveFingerprint, userAgent, platform \}/);
  assert.match(launcher, /'fingerprint_override\.json'/);
  assert.match(sync, /'fingerprint_override\.json'/);
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
  assert.match(launcher, /Final window-close snapshot failed/);
  assert.match(launcher, /setTimeout\(emitClosedProfile, 1500\)/);
  assert.match(launcher, /setInterval\(exportCookies, 1000\)/);
  assert.match(main, /function atomicWriteJson/);
  assert.match(main, /atomicWriteJson\(syncedPath, cookies\)/);
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

test('temporary Firestore failures retain the authenticated Spectra session', () => {
  const authService = read('desktop-app/src/renderer/services/auth-service.ts');

  assert.match(authService, /class UserConfigurationError extends Error/);
  assert.match(authService, /error instanceof UserConfigurationError/);
  assert.match(authService, /Temporary user resolution failure; session retained/);
  assert.match(authService, /const delays = \[1000, 3000, 5000, 10000, 30000\]/);
  assert.doesNotMatch(
    authService,
    /Unable to resolve authenticated user:[\s\S]{0,160}signOut\(auth\)/
  );
});

test('authenticated legacy profiles are migrated without automatic cloud overwrite', () => {
  const app = read('desktop-app/src/renderer/App.tsx');
  const sync = read('desktop-app/src/renderer/services/profile-sync-service.ts');

  assert.match(app, /Protected authentication migration:/);
  assert.match(app, /Promise\.allSettled\([\s\S]*hasAuthenticatedXSnapshot/);
  assert.match(sync, /cloudSyncProtocolVersion:\s*2/);
});

test('development mode hot-reloads React and safely restarts Electron main changes', () => {
  const packageJson = read('desktop-app/package.json');
  const main = read('desktop-app/src/main/main.ts');

  assert.match(packageJson, /"dev:main": "tsc -p tsconfig\.json --watch --preserveWatchOutput"/);
  assert.match(packageJson, /npm run dev:react/);
  assert.match(packageJson, /npm run dev:main/);
  assert.match(packageJson, /npm run dev:electron:wait/);
  assert.match(packageJson, /concurrently --kill-others-on-fail/);
  assert.doesNotMatch(packageJson, /concurrently --kill-others "/);
  assert.match(main, /function startDevAutoRestart\(\)/);
  assert.match(main, /fs\.watch\(directory, \{ recursive: true \}/);
  assert.match(main, /if \(hasUnsafeShutdownState\(\)\) \{\s*devRestartPending = true/);
  assert.match(main, /app\.relaunch\(\);\s*app\.exit\(0\)/);
});

test('deleting proxies also detaches every assigned profile', () => {
  const proxyManager = read('desktop-app/src/renderer/pages/ProxyManager.tsx');
  const firestore = read('desktop-app/src/renderer/services/firestore-service.ts');

  assert.match(proxyManager, /filter\(proxy => !teamId \|\| proxy\.teamId === teamId\)/);
  assert.match(proxyManager, /assignedProfileIdsFor/);
  assert.match(proxyManager, /firestoreDeleteProxy\(proxyId, assignedProfileIds\)/);
  assert.match(proxyManager, /deleteProxiesBulk\(ids, assignedProfileIds\)/);
  assert.match(firestore, /proxy:\s*null/);
  assert.match(firestore, /connectionType:\s*'system'/);
  assert.match(firestore, /connectionConfig:\s*\{\s*type:\s*'system'\s*\}/);
});

test('the instance table exposes a working per-profile proxy test', () => {
  const dashboard = read('desktop-app/src/renderer/pages/Dashboard.tsx');
  assert.match(dashboard, /handleTestProfileProxy/);
  assert.match(dashboard, /window\.electronAPI\.proxy\.test\(profile\.proxy\)/);
  assert.match(dashboard, /Tester le proxy de cette instance/);
  assert.match(dashboard, /proxy fonctionnel/);
  assert.match(dashboard, /proxy inaccessible/);
  assert.match(dashboard, /performance\.now\(\) - startedAt/);
  assert.match(dashboard, /proxyTestResult\.country/);
  assert.match(dashboard, /proxyTestResult\.ping/);
});

test('the instance table distinguishes local and remote running profiles', () => {
  const dashboard = read('desktop-app/src/renderer/pages/Dashboard.tsx');
  const app = read('desktop-app/src/renderer/App.tsx');

  assert.match(dashboard, /currentInstallationId\?: string \| null/);
  assert.match(dashboard, /const remoteActive = !isActive && isLockedByOther/);
  assert.match(dashboard, /Running locally/);
  assert.match(dashboard, /Running on \{remoteDevice\}/);
  assert.match(dashboard, /On \{remoteDevice\}/);
  assert.match(app, /currentInstallationId=\{currentInstallationId\}/);
  assert.match(app, /runtimeDetectedProfilesRef/);
  assert.match(app, /reconcileLocalRuntimePresence/);
  assert.match(app, /profiles\.getRunning!\(profileIds\)/);
  assert.match(app, /Restored cloud presence/);
  assert.match(app, /window\.setInterval\(reconcileLocalRuntimePresence, 30000\)/);
});

test('the profile upload queue discards an already committed retry and avoids toast spam', () => {
  const app = read('desktop-app/src/renderer/App.tsx');

  assert.match(app, /const alreadyCommitted = hasNoActiveLock/);
  assert.match(app, /localVersion === cloudVersion/);
  assert.match(app, /localRevision === cloudRevision/);
  assert.match(app, /Removed already committed queue item/);
  assert.match(app, /const notifiedSyncFailures = new Set<string>\(\)/);
  assert.match(app, /if \(!notifiedSyncFailures\.has\(profileId\)\)/);
});

test('profile lifecycle telemetry records exits without changing OpenPost or VenusBot control', () => {
  const launcher = read('desktop-app/src/main/puppeteer-launcher.ts');
  const urlServer = read('desktop-app/src/main/url-server.ts');
  const main = read('desktop-app/src/main/main.ts');

  assert.match(launcher, /profile-lifecycle\.ndjson/);
  assert.match(launcher, /'root-process-exit'/);
  assert.match(launcher, /'browser-handoff-detected'/);
  assert.match(launcher, /'profile-processes-gone'/);
  assert.match(launcher, /'close-requested'/);
  assert.match(launcher, /reportLifecycleEvent\('tab-removed'/);
  assert.match(launcher, /reportLifecycleEvent\('window-removed'/);
  assert.match(urlServer, /req\.url === '\/api\/lifecycle-event'/);
  assert.match(main, /ipcMain\.on\('internal:lifecycle-event'/);
  assert.match(
    main,
    /forceCloseProfile\(profileId, 'open-post-completed'\)/
  );
  assert.match(
    launcher,
    /if \(!OPEN_POST_MODE\) \{\s*throw new Error\('Profile close is only available in OpenPost mode'\)/
  );
});
