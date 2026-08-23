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
  // `require` est fourni : un module qui lit des fichiers importe fs et path.
  // Sans lui, il echouait sur « require is not defined » -- une panne du banc
  // d'essai, pas du code teste.
  new Function('exports', 'module', 'require', compiled)(module.exports, module, require);
  return module.exports;
};

// Le script genere est un service worker : il s'installe en prenant la main
// tout de suite, sans attendre la version precedente. Le bac a sable doit donc
// fournir ce que tout worker possede, sinon il refuse de demarrer.
const fauxWorker = () => ({
  addEventListener() {},
  skipWaiting() {},
  clients: { claim: async () => {} },
});

const getCookieSyncBackgroundSource = ({
  profileId,
  profileName,
  launchId,
  hasStagedCookies = false,
  openPostMode = false,
  cookieImportMode = 'remplacer',
  // Mass post ou branding : Spectra pilote l'instance de bout en bout.
  publicationMode = false,
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
    .replaceAll('${JSON.stringify(Boolean(targetTweetUrl))}', JSON.stringify(openPostMode))
    .replaceAll('${JSON.stringify(hasStagedCookies)}', JSON.stringify(hasStagedCookies))
    .replaceAll('${JSON.stringify(modeImportCookies)}', JSON.stringify(cookieImportMode))
    .replaceAll('${JSON.stringify(sessionImportAttemptId)}', JSON.stringify(''))
    .replaceAll(
      '${JSON.stringify(Boolean(options.massPost || options.branding))}',
      JSON.stringify(publicationMode)
    )
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

  // Un mass post et un branding sont pilotes par Spectra, pas par
  // l'utilisateur. Tant qu'ils tombaient en « manuel », aucune adresse
  // n'etait imposee des lors que le profil avait une session Chrome a
  // rouvrir : le navigateur restait sur la page vide ouverte pour poser les
  // cookies. Invisible sur un poste ou ces profils ne servent qu'a ca ;
  // total sur un VPS ou on les ouvre aussi a la main. Constate le
  // 23 aout 2026, sur les 74 comptes du dossier « post mass ».
  assert.equal(resolveLaunchMode({ publication: true }), 'publication');
  assert.equal(isManagedLaunch('publication'), true);
  assert.equal(shouldAppendLaunchUrl('publication', true), true);
  assert.equal(shouldAppendLaunchUrl('manual', true), false);

  // Un Open Post reste prioritaire : il vise un tweet precis.
  assert.equal(
    resolveLaunchMode({ publication: true, targetTweetUrl: 'https://x.com/u/status/1' }),
    'open-post'
  );

  assert.equal(isManagedLaunch('manual'), false);
  assert.equal(isManagedLaunch('open-post'), true);
  assert.equal(shouldAppendLaunchUrl('manual', true), false);
  assert.equal(shouldAppendLaunchUrl('manual', false), true);
  assert.equal(shouldAppendLaunchUrl('open-post', true), true);
  assert.equal(shouldOpenSetupTab('manual', false), true);
  assert.equal(shouldOpenSetupTab('manual', true), false);
  assert.equal(shouldOpenSetupTab('open-post', false), false);
});

test('Open Selected window placement cycles through visible screen slots', () => {
  const launcher = read('desktop-app/src/main/puppeteer-launcher.ts');

  assert.match(launcher, /const maxRows = Math\.max\(1, Math\.floor/);
  assert.match(launcher, /const visibleCapacity = Math\.max\(1, columns \* maxRows\)/);
  assert.match(launcher, /launchMode === 'automation'[\s\S]*rawSlot % visibleCapacity/);
  assert.match(launcher, /7 overlays 1, 8 overlays 2/);
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
  // Les fenetres de branding sont plus petites : personne ne travaille dedans,
  // on les regarde s'executer, et il en tient davantage a l'ecran. Une
  // publication en masse est du meme ordre.
  assert.match(launcher, /brandingWindow = \{\s*width: 460,\s*height: 420/);
  assert.match(launcher, /branding\s*\?\s*this\.brandingWindow/);
  assert.match(
    launcher,
    /getWindowPlacement\(\s*options\.windowLayout, launchMode,\s*Boolean\(options\.branding \|\| options\.massPost\)\s*\)/
  );
  assert.match(
    launcher,
    /if \(managedLaunch\) \{\s*args\.push\(`--window-size=\$\{compactWindowSize\}`\);\s*args\.push\(`--window-position=\$\{compactWindowPosition\}`\);/
  );
  assert.match(
    launcher,
    /if \(managedLaunch\) \{\s*this\.enforceWindowPlacement\(chromeProcess\.pid, placement\);\s*\}/
  );
  // Le script de consentement ne se charge que sur un lancement pilote.
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
  // Un Open Post ne demarre plus sur la page interne de l'extension : Chrome
  // la refuse en navigation directe, et la declarer publique la rendrait
  // detectable par n'importe quel site.
  assert.match(launcher, /targetTweetUrl\s*\?\s*'about:blank'/);
  assert.doesNotMatch(launcher, /\?\s*openPostBootstrapUrl/);
  assert.match(launcher, /!options\.autoStartTwitterBot && !targetTweetUrl/);
  assert.match(launcher, /key:\s*cookieSyncManifestKey/);
  assert.match(launcher, /bootstrap\.html/);
  assert.match(launcher, /spectra:open-post-bootstrap-page/);
  assert.match(launcher, /chrome\.scripting\.executeScript\(\{\s*target:\s*\{ tabId \},\s*files:\s*\['open-post-actions\.js'\]/);
  assert.match(launcher, /window\.__spectraOpenPostActionsStarted/);
  assert.match(launcher, /spectra:open-post-telemetry/);
  assert.match(launcher, /reportStage\('content-loaded'/);
  assert.match(launcher, /reportStage\('actions-started'/);
  assert.match(launcher, /reportStage\('like-result'/);
  assert.match(launcher, /reportStage\('repost-result'/);
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
  // Un tour rend compte de ce que chaque instance a fait, pas de ce qu'elle a
  // ouvert. Le 17 aout 2026, 47 instances tournaient toutes les vingt minutes
  // et 17 n'avaient jamais retweete -- invisible depuis l'application, il
  // fallait lire les journaux du VPS en session distante.
  const principalRt = read('desktop-app/src/main/main.ts');
  assert.match(principalRt, /const EVENEMENTS_TOUR = \[/);
  assert.match(principalRt, /'open-post-repost-result'/);
  assert.match(principalRt, /webContents\.send\('openPost:event'/);
  // Le retweet se lit sur le champ status, une chaine -- pas un booleen. Et
  // « deja retweete » est une reussite : ne compter que « reposted » faisait
  // passer pour rates tous les comptes qui l'avaient deja fait.
  assert.match(app, /\['reposted', 'already-reposted'\]\.includes/);
  assert.match(app, /\['liked', 'already-liked'\]\.includes/);

  // Le verdict est relu sur la page et envoye en direct au serveur local, sans
  // le relais par le service worker qui perdait des messages : le 17 aout
  // 2026, le tweet affichait 24 retweets quand le recapitulatif en comptait 7.
  assert.match(launcher, /function rapportDirect\(stage, details = \{\}\)/);
  assert.match(launcher, /await rapportDirect\('open-post-verdict'/);
  assert.match(launcher, /article\.querySelector\('\[data-testid="unretweet"\]'\)\)/);
  assert.match(app, /case 'open-post-verdict':/);
  // Le resultat monte sur la fiche : le tour se joue sur le VPS et se regarde
  // depuis le PC.
  assert.match(app, /lastOpenPost: \{/);
  assert.match(read('desktop-app/src/types/index.ts'), /lastOpenPost\?: \{/);
  // Et le recapitulatif montre les echecs en premier : c'est la liste sur
  // laquelle on agit.
  assert.ok(
    app.indexOf("bloc('N’ont pas retweeté'") < app.indexOf("bloc('Ont retweeté'"),
    'les echecs doivent venir avant les reussites'
  );

  // « Tweet introuvable » recouvrait trois pannes qui se reparent
  // differemment : verification humaine, compte deconnecte, compte suspendu.
  // Le bot dit maintenant ce qu'il avait a l'ecran.
  assert.match(launcher, /reportStage\('target-not-found', \{/);
  assert.match(launcher, /'verification-humaine'/);
  assert.match(launcher, /'compte-suspendu'/);
  assert.match(app, /'X demande une vérification humaine'/);
  assert.match(app, /'Compte suspendu par X'/);

  // La chaine qui mene au tweet compte trois etapes et aucune n'etait tracee :
  // une instance qui echoue restait 52 secondes sur un ecran muet -- soit le
  // temps cumule des delais d'attente. Chaque etape se raconte maintenant, a
  // l'ecran et dans la telemetrie.
  assert.match(launcher, /function noterEtape\(texte, ton = 'info'\)/);
  assert.match(launcher, /noterEtape\(nom \+ ' : début'/);
  assert.match(launcher, /noterEtape\(\s*\n?\s*nom \+ ' : ÉCHEC après '/);
  assert.match(launcher, /'spectra:journal-demarrage'/);
  assert.match(launcher, /id="spectra-etapes"/);
  // Le journal vit dans le service worker ; la page ne fait que l'afficher.
  assert.match(launcher, /sendResponse\(\{ lignes: journalDemarrage \}\)/);

  // Le registre : une ligne par instance et par tweet, gardee sur le disque.
  // Rien n'etait ecrit a un seul endroit -- le bot savait qu'il avait
  // retweete mais son message se perdait, Spectra ignorait qui avait deja
  // travaille, et au redemarrage tout etait oublie. Le 18 aout 2026, un tweet
  // a ete rouvert 25 fois en 90 minutes par des instances qui l'avaient deja
  // retweete, pendant qu'un post plus recent attendait.
  const registre = read('desktop-app/src/main/registre-openpost.ts');
  assert.match(registre, /export function dejaRetweete\(tweet: string\): Set<string>/);
  // Une ligne ajoutee, jamais un fichier reecrit : deux instances qui
  // finissent ensemble ne peuvent pas s'ecraser.
  assert.match(registre, /fs\.appendFileSync/);
  assert.doesNotMatch(registre, /fs\.writeFileSync/);
  // Le tweet voyage avec le verdict, sinon le registre ne sait pas a quel
  // post rattacher le resultat.
  assert.match(launcher, /tweet: TARGET_STATUS_ID/);
  // Un echec se note aussi : sans cela le tour rouvrirait l'instance sans fin.
  assert.equal((launcher.match(/rapportDirect\('open-post-verdict'/g) || []).length, 2);
  assert.match(read('desktop-app/src/main/main.ts'), /noterResultat\(\{/);
  // Et le tour saute celles qui ont deja fait le travail.
  assert.match(app, /disponibles\.filter\(p => !dejaFaits\.includes\(p\.id\)\)/);

  // Un proxy tombe rarement pour toujours : il devient injoignable puis
  // revient une heure plus tard. Le remplacer au premier echec ferait
  // changer l'adresse de sortie d'un compte pour rien -- et pour X, un
  // compte qui demenage sans raison se remarque.
  const sante = read('desktop-app/src/main/sante-proxys.ts');
  assert.match(sante, /export const HEURES_AVANT_REMPLACEMENT = 6;/);
  assert.match(sante, /export const ECHECS_AVANT_REMPLACEMENT = 6;/);
  // Un proxy qui revient efface son ardoise.
  assert.match(sante, /fiche.echecs = 0;/);
  // Le test passe par CONNECT, comme le navigateur pour une page en https.
  assert.match(sante, /method: 'CONNECT'/);
  // Et les instances d'un proxy en panne sont sautees, pas reaffectees :
  // 65 secondes perdues par instance et par tour, sinon.
  assert.match(app, /proxy injoignable/);
  assert.match(app, /proxysSante.tester/);

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
  // Quatre facons d'ouvrir un profil sans que l'utilisateur y touche. Chacune
  // doit mettre l'extension en mode pilote, sinon personne ne renvoie le
  // navigateur sur X et il reste sur la page vide ouverte pour les cookies.
  // On verifie la presence de chaque marqueur, sans figer la formulation :
  // epingler la ligne entiere la faisait echouer au premier ajout, et c'est
  // arrive le 23 aout 2026 en y ajoutant le mass post.
  const debutManaged = launcher.indexOf('const MANAGED_STARTUP_MODE =');
  assert.ok(debutManaged >= 0, 'MANAGED_STARTUP_MODE est introuvable');
  const expressionManaged = launcher.slice(debutManaged, launcher.indexOf(';', debutManaged));
  for (const marqueur of ['OPEN_POST_MODE', 'LAUNCH_ID', 'SESSION_IMPORT_MODE', 'PUBLICATION_MODE']) {
    assert.ok(
      expressionManaged.includes(marqueur),
      marqueur + ' manque dans MANAGED_STARTUP_MODE'
    );
  }
  assert.match(
    launcher,
    /const ENFORCE_SINGLE_TAB = OPEN_POST_MODE \|\| Boolean\(LAUNCH_ID\)/
  );
  assert.match(
    launcher,
    /if \(MANAGED_STARTUP_MODE\) \{[\s\S]*bootstrap\(\)\.then\(async \(tabId\) => \{\s*await startSessionImport\(tabId\);\s*await startOpenPostActions\(tabId\);/
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
  assert.match(app, /non envoyé : pas de session X dans ce profil/);
  assert.match(app, /La version du cloud est préservée/);
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

  // Quatre compteurs qui ne se recouvrent pas : chaque compte tombe dans une
  // seule categorie, et le total des quatre fait le nombre de comptes.
  assert.match(page, /label: 'À créer'/);
  assert.match(page, /label: 'À compléter'/);
  assert.match(page, /label: 'À finir'/);
  assert.match(page, /label: 'En place'/);
  assert.doesNotMatch(page, /Prêts à créer et connecter/);
  assert.match(page, /getMissingInformation\(account\)/);
  // Compteurs, filtres et lignes lisent le meme calcul.
  assert.match(page, /etatParCompte\.get\(account\.id\)\?\.categorie === categorie/);
  assert.match(page, /etatParCompte\.get\(account\.id\)\?\.categorie === auditFilter/);

  // La page a deux filtres : les cartes du haut et une liste deroulante. Le
  // 16 aout 2026 la liste envoyait encore d'anciennes valeurs -- elle ne
  // filtrait plus rien, en silence. Les deux doivent proposer exactement les
  // memes categories que celles calculees.
  const categories = ['a-creer', 'a-completer', 'a-finir', 'en-place'];
  const valeursListe = Array.from(
    page.matchAll(/<option value="([a-z-]+)">(?:Tous les comptes|À créer|À compléter|À finir|En place)</g),
    found => found[1]
  );
  assert.deepEqual(
    valeursListe,
    ['all', ...categories],
    'la liste deroulante doit proposer les memes categories que les cartes'
  );
  for (const categorie of categories) {
    assert.match(
      page,
      new RegExp(`filter: '${categorie}' as AuditFilter`),
      `la carte ${categorie} doit filtrer sur cette categorie`
    );
    assert.match(
      page,
      new RegExp(`categorie: '${categorie}'`),
      `aucune categorie ne doit exister sans etre attribuee a un compte`
    );
  }
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
  // La capacite restante d'un proxy se calcule a partir de la constante
  // partagee, jamais d'un nombre recopie sur place.
  assert.match(
    app,
    /Math\.max\(\s*0,\s*COMPTES_MAX_PAR_PROXY - \(usageByProxy\.get\(proxyIdentityKey\(proxy\)\) \|\| 0\)\s*\)/
  );
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

  // Une instance trouvee par le nom n'est qu'une hypothese : elle doit etre
  // confirmee a la main avant de compter comme une liaison.
  assert.match(page, /profile\.vaManagerAccountId !== account\.id/);
  assert.match(page, /Une instance semble correspondre/);
  assert.match(page, /action: 'confirmer'/);
  assert.match(page, /Confirmer la liaison/);
  assert.match(page, />\s*Lier\s*<\/button>/);
  assert.match(page, /vaManagerAccountId:\s*account\.id/);
  assert.match(page, /vaManagerOrganizationId:\s*account\.organizationId \|\| organizationId/);
  assert.match(page, /vaManagerAccountId:\s*null/);
  assert.match(page, /vaManagerOrganizationId:\s*null/);
  assert.match(page, /Ce compte est déjà lié à l’instance/);
  assert.match(page, /est déjà liée à un autre compte/);
  assert.match(app, /handleUpdateVaManagerLink/);
  assert.match(app, /firestoreUpdateProfile\(profileId, profileData\)/);
});

test('automatic X login works on the dialog X actually serves', () => {
  // Le 16 aout 2026, X a servi x.com/i/jf/onboarding/web : une boite de
  // dialogue posee par-dessus une page qui contenait deja un champ
  // identifiant. Le script ecrivait dans le champ du dessous et cherchait un
  // bouton « Next » alors que celui-ci s'appelle « Continue ». La connexion
  // s'arretait sur le premier ecran, sans erreur visible.
  const lanceur = read('desktop-app/src/main/puppeteer-launcher.ts');
  const debut = lanceur.indexOf(
    "fs.writeFileSync(path.join(cookieSyncPath, 'session-import-login.js')"
  );
  // Le script va jusqu'a l'ecriture du fichier suivant : s'arreter avant
  // laisserait la moitie des etapes hors du controle.
  const script = lanceur.slice(debut, lanceur.indexOf('fs.writeFileSync(', debut + 40));
  assert.ok(script.includes('entering-totp'), 'le script doit etre lu en entier');

  // On agit dans la boite de dialogue du dessus, pas dans la page du dessous.
  assert.match(script, /const racineActive = \(\) => \{/);
  assert.match(script, /document\.querySelectorAll\('\[role="dialog"\]'\)/);
  assert.match(script, /dialogues\[dialogues\.length - 1\]/);
  assert.match(script, /for \(const racine of \[racineActive\(\), document\]\)/);

  // Et on connait les trois libelles que X emploie pour avancer.
  assert.match(script, /\['next', 'suivant', 'continue', 'continuer'\]/);
  assert.match(script, /'se connecter', 'connexion', 'continue', 'continuer'/);

  // X affiche le champ avant de l'activer. Ecrire trop tot ne laisse rien, et
  // la connexion s'arretait sans erreur. On attend qu'il soit actif, on ecrit,
  // puis on relit pour verifier que le texte est bien entre.
  assert.match(script, /const champPret = \(input\) =>[\s\S]{0,160}!input\.disabled && !input\.readOnly/);
  assert.match(script, /aria-disabled'\) !== 'true'/);
  // On retrouve le champ a chaque essai. X change de page entre deux etapes :
  // s'accrocher au premier champ trouve, c'est attendre qu'un element mort
  // redevienne actif. Mesure du 16 aout 2026 : le mot de passe etait saisi sur
  // la page qu'on venait de quitter, puis abandonne au bout de cinq secondes.
  assert.match(script, /async function saisirEtVerifier\(trouver, value, nom/);
  assert.match(script, /typeof trouver === 'function' \? trouver\(\) : trouver/);
  assert.match(script, /document\.contains\(input\)/);
  assert.match(script, /if \(input\.value === value\) \{/);
  for (const champs of ['CHAMPS_IDENTIFIANT', 'CHAMPS_MOT_DE_PASSE', 'CHAMPS_CODE']) {
    assert.match(
      script,
      new RegExp('saisirEtVerifier\\(\\s*\\(\\) => findVisible\\(' + champs),
      `${champs} doit etre reevalue a chaque essai`
    );
  }
  assert.ok(
    script.indexOf('const champPret') < script.indexOf('const findVisible'),
    'champPret doit etre defini avant d etre utilise par findVisible'
  );

  // Les trois saisies passent par la verification, pas seulement la premiere.
  assert.equal(
    (script.match(/await saisirEtVerifier\(/g) || []).length,
    3,
    'identifiant, mot de passe et code 2FA doivent tous etre verifies'
  );
  assert.doesNotMatch(script, /setInputValue\((?:username|passwordState|afterPassword)/);

  // Un panneau dans la page raconte chaque etape, et un point rouge marque
  // chaque endroit touche. « Rien ne se passe » ne disait pas a quel moment.
  assert.match(script, /id = 'spectra-journal'/);
  assert.match(script, /function pointRouge\(element\)/);

  // Le journal se copie : bouton dedie, et texte selectionnable a la souris.
  assert.match(script, /id = 'spectra-journal-copier'/);
  assert.match(script, /navigator\.clipboard\.writeText\(texte\)/);
  assert.match(script, /document\.execCommand\('copy'\)/);
  assert.match(script, /user-select:text/);

  // Devenu cliquable, le panneau ne doit jamais etre confondu avec la page de
  // X : sinon le robot clique sur son propre bouton Copier.
  assert.match(script, /!element\.closest\('#spectra-journal'\)/);
  assert.match(script, /pointRouge\(button\)/);
  assert.match(script, /pointRouge\(input\)/);
  assert.match(script, /sessionStorage\.setItem\(CLE_JOURNAL/);

  // Le bandeau de consentement masque le formulaire. Le script de connexion
  // l'ecarte lui-meme : compter sur une autre extension laissait la fenetre
  // attendre 45 s devant un formulaire invisible -- constate le 16 aout 2026.
  assert.match(script, /function ecarterBandeauCookies\(\)/);
  assert.match(script, /ecarterBandeauCookies\(\);/);

  // X ne nomme pas son champ de la meme facon selon l'ecran servi : on part du
  // plus precis et on elargit, au lieu de ne connaitre que deux selecteurs.
  assert.match(script, /const CHAMPS_IDENTIFIANT = \[/);
  assert.match(script, /'input\[autocomplete="email"\]'/);
  assert.match(script, /'input\[type="text"\]'/);
  // Le mot de passe souffrait du meme defaut : deux noms connus seulement.
  assert.match(script, /const CHAMPS_MOT_DE_PASSE = \[/);
  assert.match(script, /'input\[type="password"\]'/);
  assert.match(script, /J’attends le mot de passe/);

  // L'ecran du code 2FA se reconnait d'abord a son adresse : le texte affiche
  // change avec la langue et avec les versions de X. Exiger « authentication
  // code » a fait manquer cet ecran le 16 aout 2026.
  // La derniere etape fait changer de page : le script qui suivait la connexion
  // meurt avec l'ancienne. C'est celui recharge sur /home qui annonce la
  // reussite -- sinon Spectra attend trois minutes et conclut a un echec, alors
  // que le compte est connecte. Mesure du 16 aout 2026.
  assert.match(script, /if \(isHome\(\)\) \{[\s\S]{0,200}report\('success'/);

  assert.match(script, /const ecranDuCode = \(\) =>/);
  assert.match(script, /two\[_-\]\?factor\|login_verification/);
  assert.match(script, /test\(location\.href\)/);
  assert.match(script, /if \(otp && ecranDuCode\(\)\)/);
  assert.match(script, /J’attends la suite/);
  // Et pendant l'attente, le panneau dit ce qu'il voit dans la page.
  assert.match(script, /champ\(s\) visible\(s\)/);
  assert.match(script, /aucun champ de saisie dans la page/);
  assert.match(script, /je refuse les cookies non nécessaires/);
  // Toujours le choix le plus protecteur, jamais l'acceptation.
  assert.match(script, /refuser\.click\(\)/);
  assert.doesNotMatch(script, /accepter\.click\(\)|ACCEPTE[^)]*\)\.click\(\)/);

  // Le journal est visible dans la page : ni le mot de passe ni la cle 2FA n'y
  // apparaissent. Le code a six chiffres, lui, ne vaut que trente secondes et
  // sert a comparer avec un generateur exterieur.
  assert.doesNotMatch(script, /journal\([^)]*credentials\.password/);
  assert.doesNotMatch(script, /journal\([^)]*credentials\.totpSecret\b(?!\)\.length)/);

  // Une cle 2FA arrive en minuscules, avec des espaces, ou en lien otpauth://.
  // Le decodeur n'acceptait que des majuscules collees : tout le reste levait
  // une erreur remontee en « echec inattendu », sans nommer la cause.
  assert.match(script, /function nettoyerSecret\(secret\)/);
  assert.match(script, /toUpperCase\(\)/);
  assert.match(script, /otpauth/);
  assert.match(script, /searchParams\.get\('secret'\)/);
  assert.match(script, /for \(const character of nettoyerSecret\(secret\)\)/);
  assert.match(script, /Clé 2FA illisible/);

  // Une connexion part de l'accueil de X : /i/flow/login redirige vers un
  // ecran d'onboarding qui ne presente plus le formulaire au meme endroit.
  const principal = read('desktop-app/src/main/main.ts');
  assert.match(lanceur, /sessionImportAttemptId\s*\?\s*'https:\/\/x\.com\/'/);
  assert.match(principal, /lastUrl: 'https:\/\/x\.com\/',\s*\n\s*launchMode: 'session-import'/);
  assert.doesNotMatch(lanceur, /i\/flow\/login/);
  assert.doesNotMatch(principal, /i\/flow\/login/);

  // Le script est injecte dans l'onglet avant qu'on lui parle : sa declaration
  // dans le manifeste ne garantit pas qu'il soit deja en place.
  const demarrage = lanceur.slice(
    lanceur.indexOf('async function startSessionImport(tabId)'),
    lanceur.indexOf('async function requestProfileClose(')
  );
  assert.match(demarrage, /chrome\.scripting\.executeScript\(\{[\s\S]{0,160}session-import-login\.js/);
  assert.ok(
    demarrage.indexOf('executeScript') < demarrage.indexOf('sendMessage'),
    "l'injection doit precede l'envoi des identifiants"
  );
  // Et l'echec doit dire lequel : serveur, jeton, ou onglet muet.
  assert.match(demarrage, /'serveur ' \+ response\.status/);
  assert.match(demarrage, /String\(error\?\.message \|\| error\)/);

  // Une connexion ratee laisse la fenetre ouverte le temps de lire l'ecran :
  // message de X, compte suspendu, journal. Elle etait fermee sur-le-champ,
  // c'est-a-dire au moment precis ou il fallait regarder.
  assert.match(
    principal,
    /result\.status === 'failed'\)[\s\S]{0,600}setTimeout\([\s\S]{0,200}forceCloseProfile\(profileId\)[\s\S]{0,80}90_000/,
    'un echec doit laisser la fenetre visible avant de fermer'
  );

  // Les identifiants restent lisibles pendant la tentative : un service worker
  // arrete par Chrome les redemande en repartant.
  const serveur = read('desktop-app/src/main/url-server.ts');
  const routeIdentifiants = serveur.slice(
    serveur.indexOf("requestUrl.pathname === '/api/session-import-credentials'"),
    serveur.indexOf("if (\n          req.method === 'POST'")
  );
  assert.doesNotMatch(
    routeIdentifiants.slice(routeIdentifiants.indexOf('res.writeHead(200')),
    /sessionImportCredentials\.delete/
  );
  assert.match(serveur, /expiresAt: Date\.now\(\) \+ 5 \* 60 \* 1000/);
});

test('the cookie banner is dismissed wherever X puts it', () => {
  // Mesure du 16 aout 2026 sur https://x.com/ : la page n'expose plus aucun
  // data-testid, et la banniere vit dans un simple [role="region"]. Le script
  // ne cherchait que dans [data-testid="BottomBar"] : il ne trouvait rien, la
  // banniere restait, et le formulaire de connexion n'apparaissait jamais.
  // Une connexion automatique attendait alors 45 s dans le vide.
  const lanceur = read('desktop-app/src/main/puppeteer-launcher.ts');
  const debut = lanceur.indexOf("'x-cookie-consent.js'), `");
  const script = lanceur.slice(debut, lanceur.indexOf('`);', debut));

  // On cherche par ce que la banniere contient, pas par l'endroit ou elle est.
  assert.match(script, /document\.querySelectorAll\('button, \[role="button"\]'\)/);
  assert.match(script, /closest\('\[role="region"\]'\)/);
  assert.doesNotMatch(
    script,
    /const bottomBar = document\.querySelector\('\[data-testid="BottomBar"\]'\);\s*\n\s*if \(!bottomBar\) return false;/,
    'la banniere ne doit plus etre cherchee uniquement dans BottomBar'
  );

  // Deux boutons opposes dans le meme bloc : c'est ce qui distingue une
  // banniere de consentement d'un « refuser » situe ailleurs dans la page.
  assert.match(script, /const acceptPattern =/);
  assert.match(script, /if \(!accompagne\) return false;/);

  // Et on refuse toujours ce qui n'est pas necessaire.
  assert.match(script, /rejectButton\.click\(\)/);
  assert.doesNotMatch(script, /acceptButton\.click\(\)/);
});

test('every launch option asked for actually reaches the browser', () => {
  // `launchProfileBrowser` reconstruit les options champ par champ : tout ce
  // qui n'y figure pas est perdu en silence. Le 17 aout 2026, le branding et le
  // modele de robot etaient demandes, transmis, puis jetes ici -- la fenetre
  // s'ouvrait et il ne se passait rien, sans la moindre erreur.
  const principal = read('desktop-app/src/main/main.ts');
  const appel = principal.slice(
    principal.indexOf('const result = await PuppeteerLauncher.launch({'),
    principal.indexOf('if (result.alreadyRunning)')
  );

  for (const champ of ['branding', 'folderId', 'botTemplate', 'botTemplateApplied']) {
    assert.match(
      appel,
      new RegExp(`${champ}: profileData\\.${champ}`),
      `${champ} doit etre transmis au lanceur`
    );
  }
  // Les options historiques ne doivent pas disparaitre au passage.
  for (const champ of ['sessionImport', 'targetTweetUrl', 'lastUrl', 'proxy']) {
    assert.match(appel, new RegExp(`${champ}:`), `${champ} doit rester transmis`);
  }
});

test('branding clears a field before writing the new value', () => {
  // Un compte a souvent deja une bio ou un nom. Ecrire par-dessus sans vider
  // laisse la page dans un etat que X ne prend pas toujours : la valeur d'avant
  // revient, ou les deux se melangent.
  const lanceur = read('desktop-app/src/main/puppeteer-launcher.ts');
  const debut = lanceur.indexOf("cookieSyncPath, 'spectra-branding.js'");
  const script = lanceur.slice(debut, lanceur.indexOf('const cookieSyncExtensionId', debut));

  // On vide, on laisse la page enregistrer ce vide, puis on ecrit lettre par
  // lettre : cinq champs remplis a la milliseconde pres sont une signature.
  assert.match(script, /poserValeur\(champ, ''\);\s*\n\s*await pause\(\d+, \d+\);/);
  assert.match(script, /for \(const lettre of String\(valeur\)\)/);
  assert.match(script, /poserValeur\(champ, ecrit\)/);
  assert.match(script, /setSelectionRange\(0, String\(champ\.value \|\| ''\)\.length\)/);

  // Les pauses ne sont jamais deux fois les memes.
  assert.match(script, /const hasardEntre = \(min, max\) =>/);
  assert.ok(
    (script.match(/await pause\(/g) || []).length >= 6,
    'chaque etape doit marquer un temps, pas seulement la saisie'
  );

  // Et on relit le champ : sans cette verification, un effacement refuse
  // passerait pour une reussite.
  assert.match(script, /if \(champ\.value === valeur\)/);

  // Un element absent du lot ne touche a rien : on ne vide pas une bio pour la
  // remplacer par du vide.
  assert.match(script, /if \(!valeur\) return true;/);

  // Poser une photo sur X se fait en trois temps : choisir le fichier, valider
  // le recadrage, enregistrer. Sans le clic sur « Appliquer », l'image est
  // deposee puis perdue -- l'enregistrement ne la voit meme pas.
  assert.match(script, /async function validerRecadrage\(nom\)/);
  assert.match(script, /'apply', 'appliquer'/);
  assert.match(script, /await validerRecadrage\('Photo'\)/);
  assert.match(script, /await validerRecadrage\('Bannière'\)/);
  // Et la validation vient apres le depot, jamais avant.
  assert.ok(
    script.indexOf("deposerImage(champsFichier[1]") < script.indexOf("validerRecadrage('Photo')"),
    'le recadrage se valide apres le depot du fichier'
  );

  // Une page rouverte la ou on l'avait laissee ne convient pas : un branding
  // impose la page des reglages, une publication celle du composeur.
  const lanceurEntier = read('desktop-app/src/main/puppeteer-launcher.ts');
  assert.match(
    lanceurEntier,
    /!options\.branding && !options\.massPost && fs\.existsSync\(lastUrlPath\)/
  );
});

test('branding never gives two accounts the same face', () => {
  const os = require('os');
  const { analyserLieu, lireLotBranding, attribuerBranding } = loadTypeScriptModule(
    'desktop-app/src/main/branding-manager.ts'
  );

  // Le pays devant un lieu est facultatif : « US | Miami, FL » ou « Paris ».
  assert.deepEqual(analyserLieu('US | Miami, FL'), { pays: 'US', valeur: 'Miami, FL' });
  assert.deepEqual(analyserLieu('Paris'), { pays: null, valeur: 'Paris' });
  // Une ligne mal formee reste un lieu, elle ne disparait pas.
  assert.deepEqual(analyserLieu('Rio | de Janeiro'), { pays: null, valeur: 'Rio | de Janeiro' });

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'branding-'));
  const lot = path.join(base, 'Branding', 'madison');
  fs.mkdirSync(path.join(lot, 'photos'), { recursive: true });
  fs.mkdirSync(path.join(lot, 'bannieres'), { recursive: true });
  for (let index = 1; index <= 3; index++) {
    fs.writeFileSync(path.join(lot, 'photos', `p${index}.jpg`), 'x');
  }
  fs.writeFileSync(path.join(lot, 'bios.txt'), '# ignore\nbio A\nbio B\n\nbio C\n');
  fs.writeFileSync(path.join(lot, 'noms.txt'), 'Madison\n');
  fs.writeFileSync(path.join(lot, 'liens.txt'), 'https://exemple.test/a\n');
  fs.writeFileSync(path.join(lot, 'lieux.txt'), 'US | Miami, FL\nUS | Austin, TX\nGB | London\n');

  // Les commentaires et les lignes vides ne comptent pas comme des bios.
  assert.deepEqual(lireLotBranding(base, 'madison').bios, ['bio A', 'bio B', 'bio C']);

  let graine = 7;
  const hasard = () => {
    graine = (graine * 9301 + 49297) % 233280;
    return graine / 233280;
  };

  // Trois photos, trois comptes : aucune ne doit se repeter.
  const photos = ['a', 'b', 'c'].map(
    (identifiant) => attribuerBranding(base, 'madison', identifiant, 'US', hasard).attribution.photo
  );
  assert.equal(new Set(photos).size, 3, 'deux comptes ne doivent jamais partager une photo');

  // Le quatrieme epuise le lot : on reprend, mais on le dit.
  const quatrieme = attribuerBranding(base, 'madison', 'd', 'US', hasard);
  assert.ok(quatrieme.doublons.includes('photo'), 'un doublon doit etre annonce, pas subi');

  // Un lieu coherent avec la sortie du proxy : Miami derriere un proxy
  // allemand, c'est la contradiction qui se repere.
  for (const identifiant of ['a', 'b', 'c', 'd']) {
    const lieu = attribuerBranding(base, 'madison', identifiant, 'US', hasard).attribution.lieu;
    assert.ok(['Miami, FL', 'Austin, TX'].includes(lieu), `lieu hors pays : ${lieu}`);
  }
  assert.equal(attribuerBranding(base, 'madison', 'gb', 'GB', hasard).attribution.lieu, 'London');

  // Une instance deja servie garde ce qu'elle a recu : sinon les comptes
  // changeraient de visage a chaque ouverture.
  const repete = attribuerBranding(base, 'madison', 'a', 'US', hasard);
  assert.equal(repete.deja, true);
  assert.equal(repete.attribution.photo, photos[0]);

  // Le lien du profil est tire comme le reste. Il etait collecte dans le
  // panneau et jamais utilise : le champ Website restait vide.
  assert.equal(repete.attribution.lien, 'https://exemple.test/a');

  // Une fiche ecrite avant qu'un element existe doit se completer, pas rester
  // amputee. Le 17 aout 2026, le lien a ete ajoute apres coup : toutes les
  // instances deja servies gardaient une fiche sans lien, et le champ Website
  // n'etait jamais rempli -- sans la moindre erreur.
  const fiches = path.join(lot, 'attributions.json');
  const avant = JSON.parse(fs.readFileSync(fiches, 'utf8'));
  delete avant.a.lien;
  delete avant.a.bio;
  fs.writeFileSync(fiches, JSON.stringify(avant));

  const complete = attribuerBranding(base, 'madison', 'a', 'US', hasard);
  assert.equal(complete.deja, true, 'une fiche completee reste la meme fiche');
  assert.equal(complete.attribution.photo, photos[0], 'le visage ne doit pas changer');
  assert.ok(complete.attribution.lien, 'le lien manquant doit etre ajoute');
  assert.ok(complete.attribution.bio, 'la bio manquante doit etre ajoutee');
  const lanceur = read('desktop-app/src/main/puppeteer-launcher.ts');
  assert.match(lanceur, /'input\[name="url"\]'/);
  assert.match(lanceur, /BRANDING\.lien, 'Lien'/);
  assert.match(read('desktop-app/src/main/main.ts'), /lien: choix\.lien/);

  // X renomme ses champs au fil des versions : un selecteur perime laissait le
  // champ vide sans rien dire. Chaque champ a donc un repli par libelle, et un
  // echec dit ce qu'il y avait dans la page.
  assert.match(lanceur, /function chercherParLibelle\(motif\)/);
  assert.equal((lanceur.match(/i\) && complet/g) || []).length, 4);
  assert.match(lanceur, /champ introuvable — présents : /);

  fs.rmSync(base, { recursive: true, force: true });
});

test('a mass post never says the same thing twice', () => {
  const os = require('os');
  const { tirerPublication } = loadTypeScriptModule(
    'desktop-app/src/main/branding-manager.ts'
  );

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-'));
  const lot = path.join(base, 'Branding', 'tous');
  fs.mkdirSync(path.join(lot, 'medias'), { recursive: true });
  fs.writeFileSync(lot + '/posts.txt', '# ignore\npost A\npost B\n\npost C\n');
  for (const nom of ['m1.jpg', 'm2.mp4']) {
    fs.writeFileSync(path.join(lot, 'medias', nom), 'x');
  }

  let graine = 11;
  const hasard = () => {
    graine = (graine * 9301 + 49297) % 233280;
    return graine / 233280;
  };

  // Trois posts, trois comptes : vingt comptes disant la meme phrase a la meme
  // minute, c'est la trace la plus lisible qui soit.
  const textes = ['a', 'b', 'c'].map(
    (identifiant) => tirerPublication(base, 'tous', identifiant, hasard).post
  );
  assert.equal(new Set(textes).size, 3, 'deux comptes ne doivent pas publier le meme texte');

  // Le fichier .txt garde ses commentaires pour l'utilisateur, pas pour le
  // tirage.
  assert.ok(!textes.includes('# ignore'));

  // Un post porte souvent ses propres retours a la ligne, et une ligne vide au
  // milieu fait partie du texte : une ligne --- separe alors deux posts.
  // Decouper par ligne aurait fait partir chaque morceau comme un post entier.
  const multi = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-multi-'));
  const lotMulti = path.join(multi, 'Branding', 'tous');
  fs.mkdirSync(lotMulti, { recursive: true });
  fs.writeFileSync(
    path.join(lotMulti, 'posts.txt'),
    '# entete\nmayyy i dm you??\n\n(answer quickly)\n---\ndeuxieme post\n'
  );
  // Ce qui part sur X porte des caracteres de largeur nulle, glisses pour que
  // deux envois du meme post ne soient pas identiques. On compare donc ce qui
  // se lit, pas ce qui s'ecrit.
  const lisible = (valeur) => String(valeur || '').replace(/[​-‍﻿⁠]/g, '');
  const doubles = ['x', 'y'].map(
    (identifiant) => tirerPublication(multi, 'tous', identifiant, hasard).post
  );
  assert.deepEqual(
    doubles.map(lisible).slice().sort(),
    ['deuxieme post', 'mayyy i dm you??\n\n(answer quickly)'],
    'un post sur plusieurs lignes doit rester entier'
  );

  // Et ces caracteres sont bien la : sans eux, un compte qui a fait le tour de
  // la reserve republie son propre texte mot pour mot, ce que X repere.
  assert.ok(
    doubles.every((valeur) => lisible(valeur) !== valeur),
    'chaque publication doit porter des caracteres de largeur nulle'
  );
  fs.rmSync(multi, { recursive: true, force: true });

  // Le coller transmet le texte entier, retours a la ligne compris.
  assert.match(
    read('desktop-app/src/main/puppeteer-launcher.ts'),
    /new ClipboardEvent\('paste', \{/
  );

  // Un compte ne se repete pas : le deuxieme envoi lui donne autre chose.
  const secondPourA = tirerPublication(base, 'tous', 'a', hasard).post;
  assert.notEqual(secondPourA, textes[0], 'un compte ne doit pas republier son propre texte');

  // Une video est un media comme un autre : la reserve accepte les deux.
  // La part de media est forcee a 1 ici : depuis le 20 aout 2026 le tirage la
  // saute une fois sur deux, et cette ligne parle de la reserve, pas du hasard.
  const avecMedia = tirerPublication(base, 'tous', 'd', hasard, 1);
  assert.ok(/m1\.jpg|m2\.mp4/.test(String(avecMedia.media)));

  // Toutes les publications ne portent pas un media.
  //
  // Une timeline ou chaque post a une photo se reconnait de loin : personne
  // n'ecrit comme ca. Le bot VENUS tire deja au sort de son cote -- 55 % de
  // texte seul -- et le mass post collait un media a chaque fois.
  const tirages = Array.from({ length: 60 }, (_, i) =>
    tirerPublication(base, 'tous', 'ratio' + i, hasard)
  );
  const sansMedia = tirages.filter((t) => !t.media).length;
  assert.ok(sansMedia > 8, 'des publications doivent partir en texte seul');
  assert.ok(sansMedia < 52, 'des publications doivent porter un media');
  assert.ok(
    tirages.every((t) => t.post),
    'un tirage sans media doit quand meme rendre un texte'
  );

  // Un dossier qui n'a que des medias continue d'en envoyer : sans cette
  // reserve, un post vide et un media saute laisseraient l'instance sans rien.
  const seulsMedias = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-media-'));
  const lotMedias = path.join(seulsMedias, 'Branding', 'tous');
  fs.mkdirSync(path.join(lotMedias, 'medias'), { recursive: true });
  fs.writeFileSync(path.join(lotMedias, 'medias', 'seul.jpg'), 'x');
  for (let i = 0; i < 8; i++) {
    const t = tirerPublication(seulsMedias, 'tous', 'm' + i, hasard);
    assert.ok(t.media, 'sans texte, le media doit toujours partir');
  }
  fs.rmSync(seulsMedias, { recursive: true, force: true });

  // Quand le compte a tout publie, on recommence -- mais on le dit, plutot que
  // de n'envoyer rien.
  tirerPublication(base, 'tous', 'a', hasard);
  const epuise = tirerPublication(base, 'tous', 'a', hasard);
  assert.equal(epuise.epuise, true, 'une reserve epuisee doit etre annoncee');
  assert.ok(epuise.post, 'une reserve epuisee ne doit pas rendre un post vide');

  // L'historique survit au redemarrage : il est sur le disque, pas en memoire.
  const historique = JSON.parse(fs.readFileSync(path.join(lot, 'publications.json'), 'utf8'));
  assert.ok(historique.a.posts.length >= 3);

  // Un post qui n'est pas parti revient dans la reserve. Le tirage est
  // enregistre a l'ouverture du navigateur, avant qu'on sache si ca aboutira :
  // sans ce retour, une serie d'echecs viderait la reserve sans qu'une seule
  // publication soit envoyee.
  const { rendrePublication, lireResultats, ecrireResultat } = loadTypeScriptModule(
    'desktop-app/src/main/branding-manager.ts'
  );
  const avantRetour = tirerPublication(base, 'tous', 'z', hasard);
  const compteAvant = JSON.parse(
    fs.readFileSync(path.join(lot, 'publications.json'), 'utf8')
  ).z.posts.length;
  rendrePublication(base, 'tous', 'z', avantRetour.post, avantRetour.media);
  const compteApres = JSON.parse(
    fs.readFileSync(path.join(lot, 'publications.json'), 'utf8')
  ).z.posts.length;
  assert.equal(compteApres, compteAvant - 1, 'un post rate doit revenir dans la reserve');

  // Le resultat dit ce qui a abouti, pas ce qui a ete tire : un compte peut
  // avoir sa photo attribuee et n'avoir jamais rien recu.
  ecrireResultat(base, 'tous', 'a', 'post', {
    statut: 'echoue', quand: '2026-08-17T04:00:00.000Z', message: 'Bouton Poster éteint',
  });
  ecrireResultat(base, 'tous', 'a', 'branding', {
    statut: 'reussi', quand: '2026-08-17T03:00:00.000Z', message: 'Branding posé',
  });
  const traces = lireResultats(base, 'tous');
  assert.equal(traces.a.post.statut, 'echoue');
  assert.equal(traces.a.branding.statut, 'reussi', 'les deux actions se suivent separement');

  // Une instance mise de cote sort des lots sans etre supprimee, et revient
  // d'un clic. Sans cela, une instance que X refuse revient en echec a chaque
  // tour et noie les vrais echecs dans le bilan.
  const { marquerEcartee } = loadTypeScriptModule('desktop-app/src/main/branding-manager.ts');
  marquerEcartee(base, 'tous', 'a', true, 'Vérification humaine');
  assert.equal(lireResultats(base, 'tous').a.ecartee.raison, 'Vérification humaine');
  assert.equal(
    lireResultats(base, 'tous').a.branding.statut, 'reussi',
    'la mise de cote ne doit pas effacer ce qui a deja abouti'
  );
  marquerEcartee(base, 'tous', 'a', false);
  assert.equal(lireResultats(base, 'tous').a.ecartee, null);

  // Le tableau saute ces instances, et dit combien il en a sautees : un lot
  // qui traite moins d'instances que coche doit s'expliquer.
  const tableau = read('desktop-app/src/renderer/pages/Dashboard.tsx');
  assert.match(tableau, /cibles\.filter\(profil => !resultatsActions\[profil\.id\]\?\.ecartee\)/);
  assert.match(tableau, /mise\(s\) de côté — sautée\(s\)/);

  // Et l'ecriture du resultat suit le verdict du script, pas le tirage.
  const principal = read('desktop-app/src/main/main.ts');
  assert.match(principal, /statut: fin\.status === 'success' \? 'reussi' : 'echoue'/);
  assert.match(principal, /rendrePublication\(racine, folderId, profileId, tirage\.post, tirage\.media\)/);

  // L'editeur de X reaffiche son propre etat apres chaque changement. Ecrire
  // lettre par lettre posait le caractere dans la page, puis l'editeur
  // reaffichait par-dessus : les deux s'additionnaient et le texte doublait a
  // chaque frappe -- « if » devenait « ifi », puis « ifi ifi ». Le coller ne
  // touche pas a la page, l'editeur l'intercepte et se reaffiche une fois.
  const lanceur = read('desktop-app/src/main/puppeteer-launcher.ts');
  assert.doesNotMatch(lanceur, /execCommand\('insertText'/);
  assert.match(lanceur, /transfert\.setData\('text\/plain', contenu\)/);
  assert.match(lanceur, /'\[data-testid="tweetTextarea_0"\]'/);
  // Et le texte obtenu est relu avant tout clic : un texte abime ne doit pas
  // partir. C'est ce qui a empeche six publications ratees le 17 aout 2026.
  assert.match(lanceur, /if \(ecrit !== attendu\) \{/);
  // Mais elle doit relire l'editeur ligne par ligne : textContent colle les
  // lignes bout a bout, et un post en deux paragraphes se relisait
  // « ... 2 HOURS !Guysss onlyyyy » sans l'espace attendu -- refuse alors que
  // le texte etait juste.
  // Une seule etiquette a la fois : les demander ensemble ramenait le bloc
  // exterieur ET le bloc interieur qu'il contient, donc chaque ligne lue deux
  // fois. Et les emoji sont des images, pas du texte : sans leur attribut alt
  // la relecture croit le texte ampute.
  assert.doesNotMatch(lanceur, /'\[data-block="true"\], \.public-DraftStyleDefault-block'/);
  assert.match(lanceur, /if \(blocs\.length === 0\) blocs = editeur\.querySelectorAll/);
  assert.match(lanceur, /image\.getAttribute\('alt'\)/);
  assert.match(lanceur, /const sansEspaces = /);
  // Le repli ne rejoue que sur un editeur vide : recoller par-dessus un texte
  // deja pose le doublait.
  assert.match(lanceur, /if \(!String\(lireEditeur\(editeur\)\)\.trim\(\)\) \{/);

  // X pose ses annonces par-dessus la page -- « Introducing Downloadable
  // Videos » et son bouton Got it recouvraient le bouton Poster, et le bot
  // attendait un bouton qu'il ne pouvait pas atteindre.
  assert.match(lanceur, /function ecarterAnnonce\(\)/);
  assert.match(lanceur, /'got it', 'not now', 'maybe later'/);
  // Jamais un OK ni un Fermer : trop ambigus pour etre cliques a l'aveugle.
  const libelles = lanceur.slice(
    lanceur.indexOf('LIBELLES_ECARTER = ['),
    lanceur.indexOf('function ecarterAnnonce()')
  );
  for (const interdit of ["'ok'", "'okay'", "'close'", "'fermer'", "'dismiss'"]) {
    assert.ok(!libelles.includes(interdit), `${interdit} ne doit pas etre clique a l'aveugle`);
  }
  // Et jamais la fenetre de redaction elle-meme.
  assert.match(lanceur, /!estRedaction\(zone\)/);

  // Une verification humaine s'arrete net et se signale : rien d'automatique
  // n'a a s'en meler, et attendre dix minutes un editeur qui n'arrivera pas
  // n'apprend rien a personne.
  assert.match(lanceur, /const verificationHumaine = \(\) =>/);
  assert.equal(
    (lanceur.match(/X demande une vérification humaine/g) || []).length, 3,
    'la publication et le branding doivent tous deux s\'arreter'
  );
  assert.match(lanceur, /challenges\.cloudflare\.com/);

  // Le journal se tient replie : deplie, il recouvrait l'editeur et le media,
  // et on ne voyait plus rien de ce que le bot faisait. Il reste consultable
  // d'un clic -- c'est lui qui a trouve chacun des defauts du 17 aout 2026.
  assert.equal((lanceur.match(/const CLE_OUVERT = 'spectraJournalOuvert';/g) || []).length, 2);
  assert.match(lanceur, /\(clic pour replier\)/);
  assert.match(lanceur, /boite\.textContent = 'Spectra — ' \+ \(derniere \? derniere\.texte/);
  assert.ok(
    lanceur.indexOf('Le texte n’est pas passé dans l’éditeur') <
      lanceur.indexOf("journal('Clic sur Poster'"),
    'la relecture du texte doit precer le clic'
  );
  // Poster avant la fin de l'envoi publierait le texte sans son media.
  assert.ok(
    lanceur.indexOf('Média prêt') < lanceur.indexOf("journal('Clic sur Poster'"),
    'le media doit avoir fini de se charger avant le clic'
  );
  // Mais on ne cherche la barre de progression que dans l'apercu du media : le
  // compteur de caracteres de X est lui aussi un [role="progressbar"], et il ne
  // disparait jamais tant qu'il y a du texte. Le chercher dans la page entiere
  // bloquait la publication pour toujours.
  assert.match(lanceur, /conteneur\.querySelector\('\[role="progressbar"\]'\)/);
  assert.doesNotMatch(lanceur, /document\.querySelector\('\[role="progressbar"\]'\)/);
  // Et le meme oubli que pour le branding : un champ calcule puis jete en
  // silence par la reconstruction des options.
  assert.match(read('desktop-app/src/main/main.ts'), /massPost: profileData\.massPost/);

  fs.rmSync(base, { recursive: true, force: true });
});

test('a model instance passes its bot settings on, never its identity', () => {
  const lanceur = read('desktop-app/src/main/puppeteer-launcher.ts');
  const tableau = read('desktop-app/src/renderer/pages/Dashboard.tsx');

  // La licence est propre a chaque compte -- verifie dans la base des licences,
  // une par compte X. La recopier ferait tourner deux instances sous la meme
  // identite, et melangerait les compteurs des deux comptes.
  const exclues = lanceur.slice(
    lanceur.indexOf('CLES_PROPRES_AU_COMPTE = ['),
    lanceur.indexOf('cheminModeleBot')
  );
  for (const cle of ['licenseKey', 'currentAccount', 'deviceId']) {
    assert.match(exclues, new RegExp(`'${cle}'`), `${cle} ne doit jamais etre recopie`);
  }
  // L'historique des conversations appartient aussi au compte.
  assert.match(exclues, /'processedConversations'/);
  assert.match(exclues, /'conversationStates'/);

  // Le script tourne dans le contexte de l'extension du robot : c'est le seul
  // endroit d'ou son stockage est lisible.
  assert.match(lanceur, /const modeleFile = 'spectra-bot-template\.js';/);
  assert.match(lanceur, /chrome\.storage\.local\.get\(null, \(tout\)/);
  assert.match(lanceur, /if \(CLES_PROPRES\.includes\(cle\)\) continue;/);
  // Le filtre s'applique aux deux sens : a la publication comme a la copie.
  assert.equal((lanceur.match(/CLES_PROPRES\.includes\(cle\)/g) || []).length, 2);

  // On ne reecrit pas a chaque ouverture : sinon un reglage ajuste sur place
  // serait ecrase sans prevenir.
  assert.match(lanceur, /empreinteDuDossier !== options\.botTemplateApplied/);
  assert.match(lanceur, /empreinte: require\('crypto'\)/);

  // Un dossier n'a qu'un seul modele : en designer un demarque le precedent.
  assert.match(tableau, /const definirModeleBot = \(profil: any\)/);
  assert.match(tableau, /if \(autre\.botTemplate\) onUpdateProfile\(autre\.id, \{ botTemplate: false \}\)/);
  assert.match(tableau, /Utiliser comme modèle/);
});

test('accounts can be ticked and connected one after another', () => {
  const page = read('desktop-app/src/renderer/pages/VaManagerPage.tsx');

  // On coche, et le bouton obeit a la selection. Sans selection il retombe sur
  // « tout ce qui est pret » : une liste vide ne doit pas bloquer le bouton.
  assert.match(page, /const \[comptesCoches, setComptesCoches\]/);
  assert.match(page, /Connecter la sélection \(\$\{selectionTraitable\.length\}\)/);
  assert.match(page, /Créer et connecter les prêts \(\$\{readyCount\}\)/);

  // Seul ce qui a quelque chose a faire est cochable.
  assert.match(page, /categorie === 'a-creer' \|\| categorie === 'a-finir'/);
  assert.match(page, /disabled=\{!estTraitable\(account\)\}/);

  // Tout cocher ne touche qu'aux lignes affichees : selectionner de l'invisible
  // est un piege.
  assert.match(page, /const cochablesVisibles = visibleAccounts\.filter\(estTraitable\)/);
  assert.match(page, /for \(const compte of cochablesVisibles\)/);

  // Deux cas dans une meme selection, deux chemins : creer puis connecter, ou
  // seulement reprendre la connexion. Melanger les deux enverrait les comptes
  // deja crees dans une creation qui les ignore en silence.
  assert.match(page, /const aCreer = cibles\.filter\(/);
  assert.match(page, /const aFinir = cibles\.filter\(/);
  assert.match(page, /await onCreateAndConnect\(aCreer, organizationId, dossierChoisi\)/);
  assert.match(page, /for \(const compte of aFinir\)[\s\S]{0,320}await onRetryConnection\(/);

  // Un compte a la fois : deux connexions X simultanees se genent.
  assert.doesNotMatch(page, /Promise\.all\([\s\S]{0,120}onRetryConnection/);

  // Le branding, lui, peut aller a plusieurs : chaque instance a son profil et
  // son proxy, elles sont independantes. Le nombre se choisit dans le panneau.
  const tableau = read('desktop-app/src/renderer/pages/Dashboard.tsx');
  // Un reglage par action depuis le 20 aout 2026 : un branding pose une photo
  // et deux champs, un mass post televerse une video de 40 Mo et attend X
  // pendant des minutes. Et les deux tiennent au redemarrage.
  assert.match(tableau, /const \[parallelesBranding, setParallelesBranding\] = useState\(\(\) =>/);
  assert.match(tableau, /const \[parallelesPost, setParallelesPost\] = useState\(\(\) =>/);
  assert.match(tableau, /localStorage\.setItem\('spectra-paralleles-post'/);
  assert.match(tableau, /Fenêtres en même temps/);
  // Le mass post ouvre le nombre de fenetres qui lui est propre, pas celui du
  // branding : les deux listes deroulantes doivent commander deux valeurs.
  assert.match(tableau, /total: parallelesPost/);
  assert.match(tableau, /\(fenetres \?\? parallelesBranding\)/);
  // Une file partagee, pas des paquets fixes : personne n'attend pour rien.
  assert.match(tableau, /const profil = enAttente\.shift\(\);/);
  assert.match(tableau, /Promise\.all\(Array\.from\(\{ length: postes \}/);
  // L'arret coupe la file sans tuer ce qui est en cours.
  assert.match(tableau, /while \(!arretBrandingRef\.current\)/);
});

test('a confirmed X login turns the account status to Active', () => {
  // La colonne Account etait posee a la main. Quand Spectra vient d'authentifier
  // le compte lui-meme, il le sait : il n'y a aucune raison de le faire dire par
  // l'utilisateur.
  const app = read('desktop-app/src/renderer/App.tsx');

  // Creation en lot comme reprise de connexion : meme consequence, et nulle
  // part ailleurs.
  assert.equal((app.match(/status: 'active'/g) || []).length, 2);
  assert.match(app, /vaManagerLoginStatus: 'connected',[\s\S]{0,400}status: 'active'/);
  assert.match(app, /result\.status === 'success' \? \{ status: 'active' as const \} : \{\}/);

  // Un echec ne touche pas au statut : il ne dit pas que le compte est mauvais,
  // seulement que la connexion n'a pas abouti cette fois.
  const brancheEchec = app.slice(
    app.indexOf("vaManagerLoginStatus: 'failed',"),
    app.indexOf("vaManagerLoginStatus: 'failed',") + 300
  );
  assert.doesNotMatch(brancheEchec, /status: '(banned|toLogIn|none)'/);
});

test('proxy capacity is gathered in parallel and stops when it is enough', () => {
  // Les proxys etaient testes un par un, tous, avant d'ouvrir la moindre
  // fenetre : 65 proxys, dix secondes d'attente maximum chacun, pour un besoin
  // d'une seule place. Creer un compte demandait plusieurs minutes d'immobilite.
  const app = read('desktop-app/src/renderer/App.tsx');
  const fonction = app.slice(
    app.indexOf('const rassemblerPlacesProxy = async'),
    app.indexOf('const handleImportSessions = async')
  );

  // Les tests partent par lots : ils sont independants les uns des autres.
  assert.match(fonction, /await Promise\.all\(lot\.map\(/);
  assert.match(fonction, /const TAILLE_LOT = \d+;/);

  // On remplit un proxy avant d'en entamer un autre : les plus charges
  // passent en premier. Sans ce tri, l'ordre venait de la base et le parc se
  // consommait bien plus vite que necessaire.
  assert.match(fonction, /const parRemplissage = \[\.\.\.candidats\]\.sort/);
  assert.match(
    fonction,
    /usageByProxy\.get\(proxyIdentityKey\(b\)\) \|\| 0\) -\s*\(usageByProxy\.get\(proxyIdentityKey\(a\)\) \|\| 0\)/
  );
  assert.match(fonction, /parRemplissage\.slice\(debut, debut \+ TAILLE_LOT\)/);

  // Le tri ne dispense pas du test : un proxy muet reste ecarte, si rempli
  // soit-il.
  assert.match(fonction, /window\.electronAPI\.proxy\.test\(proxy\)/);
  assert.match(fonction, /if \(!sain\) continue;/);
  // Et on s'arrete des qu'il y a assez de places.
  assert.match(fonction, /places\.length >= placesVoulues/);
  // Une annulation reste possible entre deux lots.
  assert.match(fonction, /if \(estAnnule\(\) \|\| places\.length >= placesVoulues\) break;/);

  // Les deux chemins de creation passent par cette fonction : aucun ne doit
  // garder sa propre boucle sequentielle.
  assert.equal((app.match(/await rassemblerPlacesProxy\(/g) || []).length, 2);
  assert.doesNotMatch(app, /for \(const proxy of candidates\) \{/);
  assert.doesNotMatch(app, /for \(const proxy of uniqueCandidates\.values\(\)\) \{/);
});

test('the accounts-per-proxy limit is written once', () => {
  // La limite valait 3 a quatre endroits du code et dans un texte affiche.
  // Florent l'a corrigee le 16 aout 2026 : c'est 4. Une regle recopiee cinq
  // fois finit par differer d'un endroit a l'autre.
  const partage = read('desktop-app/src/shared/proxy-identity.ts');
  const app = read('desktop-app/src/renderer/App.tsx');
  const page = read('desktop-app/src/renderer/pages/VaManagerPage.tsx');

  assert.match(partage, /export const COMPTES_MAX_PAR_PROXY = 4;/);
  assert.match(app, /COMPTES_MAX_PAR_PROXY/);
  assert.match(page, /limite de \{COMPTES_MAX_PAR_PROXY\} comptes par proxy/);

  // Plus aucune valeur en dur, ni dans le calcul ni dans les textes.
  assert.doesNotMatch(app, /usageByProxy\.get\(key\) \|\| 0\) < \d/);
  assert.doesNotMatch(app, /Math\.max\(0, \d - \(usageByProxy/);
  assert.doesNotMatch(page, /trois comptes par proxy/);
});

test('Chrome never offers to save the account password', () => {
  // Le 16 aout 2026, la fenetre « Save password? » de Chrome s'ouvrait pile au
  // moment ou X demande le code 2FA. Elle appartient au navigateur, pas a la
  // page : aucun script ne peut la fermer, et elle prend le focus du clavier.
  // La session voyage par les cookies, jamais par le gestionnaire : on demande
  // donc a Chrome de ne plus poser la question.
  const lanceur = read('desktop-app/src/main/puppeteer-launcher.ts');
  const fonction = lanceur.slice(
    lanceur.indexOf('private static desactiverGestionnaireMotsDePasse'),
    lanceur.indexOf('private static assertSafeId')
  );

  assert.match(fonction, /credentials_enable_service = false/);
  assert.match(fonction, /credentials_enable_autosignin = false/);
  assert.match(fonction, /password_manager_enabled: false/);
  assert.match(fonction, /password_manager_leak_detection: false/);

  // Les autres reglages du profil sont conserves.
  assert.match(fonction, /\.\.\.\(preferences\.profile \|\| \{\}\)/);
  // Un fichier illisible n'est pas remplace par un profil vide.
  assert.match(fonction, /catch \{\s*return;\s*\}/);

  // Et la preference est posee avant chaque ouverture, pas seulement a la
  // creation : un profil deja existant doit en beneficier aussi.
  assert.match(lanceur, /this\.desactiverGestionnaireMotsDePasse\(profilePath\);/);
});

test('creating a VA Manager instance asks only where to put it', () => {
  // Un compte sans instance n'offrait qu'un bouton : lier une instance
  // existante. Or le but est justement d'en creer une, vite. Et le dossier
  // n'etait jamais demande : l'instance atterrissait dans celui qui se trouvait
  // selectionne ailleurs dans l'application.
  const page = read('desktop-app/src/renderer/pages/VaManagerPage.tsx');
  const app = read('desktop-app/src/renderer/App.tsx');

  // Creer est propose compte par compte, sans passer par une instance existante.
  assert.match(page, /Créer l’instance/);
  assert.match(page, /setComptesACreer\(\[account\]\)/);

  // Et la seule question posee est celle du dossier.
  assert.match(page, /Où ranger/);
  assert.match(page, /folders\.map\(folder =>/);
  assert.match(page, /value="__none__">Aucun dossier/);

  // Un compte incomplet n'offre aucune action : la connexion echouerait. Cela
  // vaut aussi pour une instance deja creee dont la connexion a echoue --
  // proposer « Reessayer » sans le mot de passe, c'est promettre un echec.
  assert.match(page, /const ilManque = \(\): EtatCompte => \(\{[\s\S]{0,400}?action: null/);
  assert.match(page, /if \(informationsManquantes\.length > 0\) return ilManque\(\);/);
  const apresConnecte = page.slice(page.indexOf("if (profile.vaManagerLoginStatus === 'connected')"));
  assert.match(
    apresConnecte.slice(0, 600),
    /informationsManquantes\.length > 0\) return ilManque\(\)/,
    'le controle des informations doit passer avant de proposer une reprise'
  );

  // Une ligne, une phrase, une action : trois colonnes, plus six.
  assert.match(page, /<span>Où ça en est<\/span>/);
  // Une case a cocher, puis les trois colonnes.
  assert.match(page, /grid-cols-\[34px_minmax\(220px,1\.4fr\)_minmax\(240px,1fr\)_190px\]/);
  assert.doesNotMatch(page, /minmax\(180px,1\.5fr\)_130px_120px/);

  // Le dossier choisi doit vraiment arriver jusqu'a la creation.
  assert.match(page, /onCreateAndConnect\(aCreer, organizationId, dossierChoisi\)/);
  assert.match(app, /folderId: folderId === '__none__' \? undefined : \(folderId \|\| undefined\)/);
  assert.doesNotMatch(
    app.slice(app.indexOf('const handleCreateVaManagerInstances'), app.indexOf('const handleRetryVaManagerConnection')),
    /folderId: selectedFolderId/,
    "le dossier ne doit plus etre pris dans la barre laterale"
  );
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
  assert.match(app, /COMPTES_MAX_PAR_PROXY - \(usageByProxy\.get\(proxyIdentityKey\(proxy\)\) \|\| 0\)/);
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

test('cross-device cookies are restored before Open Post actions and Chrome closes gracefully', () => {
  const launcher = read('desktop-app/src/main/puppeteer-launcher.ts');
  const profileSync = read('desktop-app/src/renderer/services/profile-sync-service.ts');
  // Ce qui est protege ici : un Open Post part d'une page vide, pour que les
  // cookies soient poses avant d'atteindre X. La condition qui precede peut
  // s'allonger -- une publication s'y est ajoutee le 23 aout 2026 -- sans que
  // cette regle change.
  assert.match(launcher, /targetTweetUrl\s*\n?\s*\?\s*'about:blank'/);
  assert.match(launcher, /async function ensureCookiesImported\(\)/);
  // Les cookies restent restaures avant la navigation, mais chaque etape porte
  // desormais un delai : un blocage silencieux laissait le profil inerte une
  // minute entiere sans rien inscrire nulle part.
  assert.match(
    launcher,
    /avecDelai\('import-cookies', ensureCookiesImported\(\)[\s\S]{0,200}avecDelai\('ouverture-adresse', openStartUrl\(\)/
  );
  assert.match(launcher, /Etape "' \+ nom \+ '" bloquee au-dela de/);
  assert.match(launcher, /Promise\.race\(\[\s*chrome\.cookies\.set\(details\)/);
  assert.match(launcher, /Cookie import timed out/);
  assert.match(launcher, /spectra:open-post-bootstrap-page[\s\S]*bootstrap\(\)/);
  assert.match(launcher, /bootstrap\(\)[\s\S]*startOpenPostActions\(tabId\)/);
  assert.match(launcher, /const tabId = await avecDelai\('ouverture-adresse', openStartUrl\(\)/);
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
  // Un demarrage de robot va droit a l'adresse, sans page vide. La condition
  // accepte d'autres cas a cote -- une publication s'y est ajoutee.
  assert.match(launcher, /options\.autoStartTwitterBot[^?]*\?\s*\n?\s*startUrl/);
  assert.match(launcher, /startupTabsMarkerDeadline = Date\.now\(\) \+ 5000/);
  assert.match(launcher, /Single-tab marker delayed; using Requests fallback/);
  assert.doesNotMatch(launcher, /createStartupTabCleanerExtension/);
  assert.match(launcher, /let bootstrapComplete = false/);
  assert.match(launcher, /BOOTSTRAP_ATTEMPTS = 5/);
  assert.match(launcher, /RETRY_DELAYS = \[1000, 2000, 4000, 8000, 12000\]/);
  assert.match(launcher, /WATCHDOG_DEADLINE = Date\.now\(\) \+ \(OPEN_POST_MODE \? 120000 : 60000\)/);
  // Strict necessaire. 'storage' n'a servi qu'aux journaux de diagnostic du
  // 13 aout 2026 ; ceux-ci retires le 15 aout, la permission part avec eux.
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
      create() {},
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
    self: fauxWorker(),
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

test('a rewritten worker replaces the previous one immediately', () => {
  // Le 15 aout 2026, quatre instances tournaient encore avec le script d'une
  // session precedente, adressant un port de Spectra ferme depuis. Le
  // navigateur etait neuf et le fichier sur disque correct : seule la version
  // en memoire etait perimee. Un service worker reecrit s'installe en effet
  // mais attend, et l'ancien reessayait son envoi chaque seconde -- il se
  // maintenait donc en vie et empechait son propre remplacement.
  const source = getCookieSyncBackgroundSource({
    profileId: 'profil_relais',
    profileName: 'Relais',
    launchId: '',
    hasStagedCookies: false,
  });

  assert.match(
    source,
    /addEventListener\('install', \(\) => self\.skipWaiting\(\)\)/,
    'la nouvelle version doit prendre la main sans attendre'
  );
  assert.match(
    source,
    /addEventListener\('activate'[\s\S]{0,80}clients\.claim\(\)/,
    'elle doit aussi reprendre les clients de l ancienne'
  );

  // L'adresse du serveur est propre a chaque demarrage de Spectra : c'est
  // precisement ce qui rend une version perimee inoffensive en apparence et
  // muette en pratique.
  assert.match(source, /const SERVER = 'http:\/\/127\.0\.0\.1:\d+'/);
});

test('no startup step can hang silently', () => {
  // Le 15 aout 2026, quatre instances ne faisaient plus aucun RT. Le demarrage
  // n'echouait pas -- il restait suspendu, sans erreur ni trace, jusqu'a la
  // fermeture forcee a soixante secondes. Un blocage muet ne laisse rien
  // derriere lui : chaque etape doit donc porter un delai et son nom, pour se
  // transformer en echec, qui lui est enregistre.
  const launcher = read('desktop-app/src/main/puppeteer-launcher.ts');

  assert.match(launcher, /async function avecDelai\(nom, promesse, millisecondes = \d+\)/);
  assert.match(launcher, /Etape "' \+ nom \+ '" bloquee au-dela de/);
  assert.match(launcher, /clearTimeout\(minuteur\)/, 'le minuteur doit etre annule');

  for (const etape of [
    'lecture-adresse',
    'liste-onglets',
    'creation-onglet',
    'navigation-onglet',
    'import-cookies',
    'ouverture-adresse',
  ]) {
    assert.match(
      launcher,
      new RegExp(`avecDelai\\(\\s*'${etape}'`),
      `l'etape ${etape} doit porter un delai`
    );
  }

  // Le delai le plus long doit rester sous la minute apres laquelle Spectra
  // ferme l'instance : au-dela, il ne servirait a rien.
  const delais = [...launcher.matchAll(/avecDelai\(\s*'[a-z-]+',[\s\S]{0,160}?,\s*(\d+)\s*\)/g)]
    .map(m => Number(m[1]));
  assert.ok(delais.length >= 5, 'chaque etape doit declarer son delai');
  assert.ok(
    Math.max(...delais) <= 40000,
    'un delai plus long que la fermeture forcee ne protegerait de rien'
  );
});

test('startup no longer depends on reading a file', async () => {
  // Le 15 aout 2026, cinq instances echouaient a chaque tour d'Auto Post sur
  // "Failed to fetch" en relisant start_url.json -- page chargee, un seul
  // onglet. Le demarrage n'aboutissait jamais, donc le script qui aime et
  // republie n'etait jamais injecte. L'adresse est desormais inscrite dans le
  // script lui-meme ; la lecture du fichier n'est plus qu'un secours.
  const adresse = 'https://x.com/georgegould53/status/2087621068882161866';
  const ouverts = [];

  const chrome = {
    runtime: {
      getURL: file => `chrome-extension://cookie-sync/${file}`,
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} },
      onSuspend: { addListener() {} },
    },
    cookies: { set: async () => {}, getAll: async () => [], onChanged: { addListener() {} } },
    tabs: {
      query: async () => [{ id: 1, url: 'about:blank', status: 'complete', active: true }],
      update: async (tabId, properties) => { ouverts.push(properties.url); return { id: tabId }; },
      remove: async () => {},
      onCreated: { addListener() {} },
    },
    alarms: { create() {}, clear: async () => true, onAlarm: { addListener() {} } },
  };

  // Le fichier est injoignable : c'est exactement la panne observee.
  const fetch = async url => {
    if (String(url).endsWith('/start_url.json')) throw new Error('Failed to fetch');
    if (String(url).endsWith('/cookies.json')) {
      return { ok: true, json: async () => [{ name: 'a', value: '1', domain: '.x.com', path: '/' }] };
    }
    if (String(url).endsWith('/api/save-cookies')) return { ok: true };
    return { ok: true, json: async () => ({}) };
  };

  const source = getCookieSyncBackgroundSource({
    profileId: 'profil_demarrage',
    profileName: 'Demarrage',
    launchId: '',
    hasStagedCookies: true,
  }).replace(
    '/*SPECTRA_DEMARRAGE*/null',
    JSON.stringify({ startUrl: adresse, closeOtherTabs: false, likeTargetPost: false, launchId: '' })
  );

  vm.runInNewContext(source, {
    self: fauxWorker(),
    chrome, fetch, console,
    setTimeout: (callback, delay = 0) => setTimeout(callback, Math.min(delay, 5)),
    clearTimeout, setInterval: () => 0, clearInterval() {},
    Promise, JSON, RegExp, String, Error,
  }, { filename: 'cookie-sync-demarrage-integre.js' });

  await new Promise(resolve => setTimeout(resolve, 30));

  assert.ok(
    ouverts.includes(adresse),
    "le demarrage doit aboutir meme si le fichier d'adresse est injoignable"
  );

  // Et Spectra doit reellement inscrire la valeur : sans cela le repere
  // resterait tel quel et le secours serait le seul chemin.
  const launcher = read('desktop-app/src/main/puppeteer-launcher.ts');
  assert.match(launcher, /const repere = '\/\*SPECTRA_DEMARRAGE\*\/null'/);
  assert.match(launcher, /script\.replace\(repere, JSON\.stringify\(donneesDemarrage\)\)/);
  assert.match(launcher, /Repere SPECTRA_DEMARRAGE introuvable/);
});

test('a stale snapshot never overwrites the live browser session', async () => {
  // Le 12 aout 2026, une sauvegarde du 10 aout etait reinjectee sur une session
  // ouverte le jour meme : l'auth_token frais etait remplace par l'ancien et le
  // compte se retrouvait deconnecte. Quand la base du navigateur est plus
  // recente que l'instantane, Spectra passe en mode "completer" et ne remet que
  // les cookies absents.
  const lancer = async (cookieImportMode) => {
    const poses = [];
    const chrome = {
      runtime: {
        getURL: file => `chrome-extension://cookie-sync/${file}`,
        onStartup: { addListener() {} },
        onInstalled: { addListener() {} },
        onSuspend: { addListener() {} },
      },
      cookies: {
        set: async cookie => { poses.push(cookie.name); },
        // Ce que le navigateur possede deja : la session du jour.
        getAll: async () => [
          { name: 'auth_token', value: 'session-du-jour', domain: '.x.com', path: '/' },
          { name: 'ct0', value: 'jeton-du-jour', domain: '.x.com', path: '/' },
        ],
        onChanged: { addListener() {} },
      },
      tabs: {
        query: async () => [],
        update: async () => ({}),
        remove: async () => {},
        onCreated: { addListener() {} },
      },
      alarms: { create() {}, clear: async () => true, onAlarm: { addListener() {} } },
    };

    const fetch = async url => {
      if (String(url).endsWith('/cookies.json')) {
        return {
          ok: true,
          // La sauvegarde perimee : un auth_token deja remplace, et un cookie
          // que le navigateur n'a plus.
          json: async () => [
            { name: 'auth_token', value: 'session-du-10-aout', domain: '.x.com', path: '/' },
            { name: 'lang', value: 'fr', domain: '.x.com', path: '/' },
          ],
        };
      }
      if (String(url).endsWith('/start_url.json')) {
        return { ok: true, json: async () => ({ startUrl: 'https://x.com/home', closeOtherTabs: false }) };
      }
      if (String(url).endsWith('/api/save-cookies')) return { ok: true };
      throw new Error(`Unexpected URL: ${url}`);
    };

    const source = getCookieSyncBackgroundSource({
      profileId: 'profil_session_vivante',
      profileName: 'Session vivante',
      launchId: '',
      hasStagedCookies: true,
      cookieImportMode,
    });
    vm.runInNewContext(source, {
      self: fauxWorker(),
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
    }, { filename: `cookie-sync-${cookieImportMode}.js` });

    await new Promise(resolve => setTimeout(resolve, 30));
    return poses;
  };

  const completer = await lancer('completer');
  assert.ok(
    !completer.includes('auth_token'),
    'la session vivante doit survivre a une sauvegarde plus ancienne'
  );
  assert.ok(completer.includes('lang'), 'les cookies absents doivent quand meme etre restaures');

  // Le garde-fou doit dependre du mode, sinon un profil vraiment vide ne
  // recupererait jamais sa session.
  const remplacer = await lancer('remplacer');
  assert.ok(
    remplacer.includes('auth_token'),
    'en mode remplacer, la sauvegarde reste autoritaire'
  );
});

test('an incomplete local profile is never uploaded over the cloud copy', () => {
  // Le 13 aout 2026, trois profils sont devenus impossibles a retelecharger.
  // Spectra ignorait les fichiers absents a l'envoi mais les exigeait a la
  // restauration : il fabriquait donc une archive qu'il refusait lui-meme
  // d'ouvrir, et elle ecrasait la bonne version. Cause immediate : un profil
  // ouvert quatre secondes par l'Auto Post puis tue avant que Chrome ait ecrit
  // ses preferences.
  const sync = read('desktop-app/src/main/profile-sync.ts');

  // Les deux cotes doivent parler du meme fichier, par la meme constante.
  assert.match(sync, /CHEMIN_REQUIS_DANS_ARCHIVE = 'Default\/Preferences'/);
  const verificationEnvoi = sync.indexOf('throw new ArchiveLocaleIncomplete');
  assert.ok(verificationEnvoi > -1, "l'envoi doit refuser un profil incomplet");
  assert.ok(
    verificationEnvoi < sync.indexOf('const buffer = zip.toBuffer()'),
    "le refus doit tomber avant la construction de l'archive"
  );

  // La restauration, elle, ne doit jamais condamner un profil : refuser une
  // archive sans preferences empechait de l'ouvrir, donc de la reparer. Elle
  // exige desormais seulement de quoi retablir la session.
  assert.ok(
    !/throw new Error\(`Cloud profile archive is incomplete/.test(sync),
    "la restauration ne doit plus rejeter une archive sans preferences"
  );
  assert.match(sync, /no session data: cookies or Local State missing/);
  assert.match(sync, /porteUneSession/);
  assert.match(sync, /CODE_ARCHIVE_INCOMPLETE = 'profile-sync\/incomplete-local'/);

  // Seul le message franchit la frontiere entre les deux processus : le code
  // doit donc y figurer, sinon l'interface ne peut pas reconnaitre le cas.
  assert.match(
    sync,
    /super\(\s*`\[\$\{CODE_ARCHIVE_INCOMPLETE\}\]/,
    'le code doit etre inscrit dans le message'
  );

  // Un envoi refuse ne doit pas laisser le profil verrouille : il serait alors
  // impossible a ouvrir depuis les autres machines.
  const app = read('desktop-app/src/renderer/App.tsx');
  const brancheIncomplet = app.indexOf("errorMessage.includes('profile-sync/incomplete-local')");
  assert.ok(brancheIncomplet > -1, "l'interface doit reconnaitre ce cas");
  const suite = app.slice(brancheIncomplet, brancheIncomplet + 700);
  assert.match(suite, /releaseProfileLock/, 'le verrou doit etre relache');
  assert.match(suite, /uploadQueue\.shift\(\)/, "l'envoi ne doit pas etre repris en boucle");
});

test('the local server lets the cookie-sync extension through its own preflight', () => {
  // Le 12 aout 2026, la verification d'origine n'acceptait que les domaines de
  // X. L'extension de synchronisation appelle pourtant ce serveur depuis son
  // service worker, avec une origine chrome-extension:// : ses envois etaient
  // bloques par le navigateur et plus aucune session n'etait enregistree.
  const serveur = read('desktop-app/src/main/url-server.ts');

  assert.match(
    serveur,
    /chrome-extension:\\\/\\\/\[a-z\]\{32\}/,
    "l'origine d'une extension doit etre acceptee"
  );
  assert.match(
    serveur,
    /access-control-request-private-network/,
    'la demande d acces au reseau prive doit recevoir une reponse'
  );
  assert.match(
    serveur,
    /Access-Control-Allow-Private-Network/,
    'la permission reseau prive doit etre accordee explicitement'
  );

  // L'ordre compte : la requete OPTIONS arrive sans en-tete d'autorisation.
  // Si le controle du jeton passe en premier, elle repart en 401 et la vraie
  // requete n'est jamais emise.
  const indexOptions = serveur.indexOf("req.method === 'OPTIONS'");
  const indexJeton = serveur.indexOf('req.headers.authorization !==');
  assert.ok(indexOptions > -1 && indexJeton > -1);
  assert.ok(
    indexOptions < indexJeton,
    'la requete OPTIONS doit etre traitee avant la verification du jeton'
  );
});

test('an instance stuck at the forced-close limit gets its service worker store reset', () => {
  // Mesure du 15 aout 2026 sur le VPS 128 : six instances sur vingt-deux
  // restaient ouvertes exactement 65 s -- la limite avant fermeture forcee --
  // sans jamais quitter la page blanche, trente fois de suite. Effacer le
  // magasin du service worker du profil a repare : sept echecs a 65 s puis 8 s
  // et un repost au lancement suivant.
  const lanceur = read('desktop-app/src/main/puppeteer-launcher.ts');

  assert.match(
    lanceur,
    /viderCacheServiceWorker/,
    'la remise a neuf doit exister'
  );

  const fonction = lanceur.slice(
    lanceur.indexOf('private static reinitialiserServiceWorkerSiBloque'),
    lanceur.indexOf('private static assertSafeId')
  );

  // Le nettoyage vise le seul dossier fautif. Les cookies sont ailleurs.
  assert.match(fonction, /'Default', 'Service Worker'/);
  assert.doesNotMatch(fonction, /Network|Cookies|Login Data/);

  // On agit sur le symptome, jamais sur la taille : des profils sains portent
  // 2988 fichiers et 1,3 Go la ou les malades en avaient 1370.
  assert.doesNotMatch(fonction, /statSync\([^)]*Service Worker/);
  // Le signal est le silence, pas la duree. Mesure du 17 aout 2026 sur 5820
  // lancements : un retweet reussi prend 8 s en mediane et jamais plus de
  // 25 s. Une fenetre qui depasse 30 s sans avoir charge la moindre page n'a
  // pas demarre son extension.
  //
  // L'ancien seuil, 55 a 95 s, laissait passer 311 lancements muets entre 45
  // et 55 s et ne s'est declenche que 16 fois en 5820 lancements -- alors que
  // 9 de ces 16 ont retweete dans la foulee. Il reparait, mais presque jamais.
  // Le critere est le resultat, pas la duree ni le silence : deux tours de
  // suite sans retweet. Les criteres precedents laissaient passer des
  // instances qui chargeaient bien leur page sans jamais trouver le tweet --
  // le 18 aout 2026, 23 instances bloquees et zero reparation declenchee.
  assert.match(fonction, /deuxDerniers\.some\(\(tour\) => tour\.abouti\)/);
  assert.doesNotMatch(fonction, /duree >= \d+/);
  assert.match(fonction, /entree\.event === 'chrome-open-post-verdict'/);
  assert.match(fonction, /'reposted', 'already-reposted'/);

  // Une fenetre fermee a la main reste ouverte des heures : deux lancements
  // consecutifs restent exiges, pour ne pas prendre une fermeture manuelle
  // pour une instance bloquee.
  assert.match(fonction, /deuxDerniers\.length < 2/);

  // Et seulement pour un tour Open Post, le seul ou la limite s'applique.
  assert.match(fonction, /hasTargetTweet === true/);
  // Le cache doit etre vide avant chaque tour pilote par Spectra : un Open
  // Post comme une publication. Le 23 aout 2026, seul l'Open Post passait par
  // la, et douze instances de mass post sont restees sur la page blanche.
  const garde = lanceur.match(/if \(([^)]*)\) \{\s*this\.viderCacheServiceWorker/);
  assert.ok(garde, 'le cache doit etre vide avant le tour');
  for (const motif of ['targetTweetUrl', 'massPost', 'branding']) {
    assert.ok(
      garde[1].includes(motif),
      `le vidage du cache doit couvrir ${motif}, condition lue : ${garde[1]}`
    );
  }
});

test('Open Post background bootstrap imports staged cookies before managed X navigation', async () => {
  const sequence = [];
  let fakeNow = 1_000_000;
  class FastDate extends Date {
    static now() {
      fakeNow += 30_000;
      return fakeNow;
    }
  }
  const tabs = [{ id: 1, url: 'about:blank', status: 'complete', active: true }];
  let nextTabId = 2;
  const chrome = {
    runtime: {
      getURL: file => `chrome-extension://cookie-sync/${file}`,
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} },
      onSuspend: { addListener() {} },
      onMessage: { addListener() {} },
    },
    cookies: {
      set: async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        sequence.push('cookie-imported');
      },
      getAll: async () => [],
      onChanged: { addListener() {} },
    },
    tabs: {
      query: async () => tabs.map(tab => ({ ...tab })),
      create: async properties => {
        sequence.push(`navigate:${properties.url}`);
        const tab = { id: nextTabId++, url: properties.url, status: 'complete', active: true };
        tabs.push(tab);
        return { ...tab };
      },
      update: async (tabId, properties) => {
        sequence.push(`navigate:${properties.url}`);
        const tab = tabs.find(candidate => candidate.id === tabId);
        Object.assign(tab, properties, { status: 'complete' });
        return { ...tab };
      },
      remove: async tabId => {
        const index = tabs.findIndex(tab => tab.id === tabId);
        if (index >= 0) tabs.splice(index, 1);
      },
      get: async tabId => ({ ...tabs.find(tab => tab.id === tabId) }),
      onCreated: { addListener() {} },
    },
    scripting: { executeScript: async () => [{ result: false }] },
    alarms: {
      create() {},
      clear: async () => true,
      onAlarm: { addListener() {} },
    },
    windows: { onRemoved: { addListener() {} } },
  };
  const fetch = async url => {
    if (String(url).endsWith('/cookies.json')) {
      return {
        ok: true,
        json: async () => [{
          name: 'auth_token', value: 'test', domain: '.x.com', path: '/', secure: true,
        }],
      };
    }
    if (String(url).endsWith('/start_url.json')) {
      return {
        ok: true,
        json: async () => ({
          startUrl: 'https://x.com/example/status/123', closeOtherTabs: true,
        }),
      };
    }
    if (String(url).endsWith('/api/save-cookies')) return { ok: true, json: async () => ({}) };
    throw new Error(`Unexpected URL: ${url}`);
  };

  const source = getCookieSyncBackgroundSource({
    profileId: 'open_post_cookie_order',
    profileName: 'Open Post Cookie Order',
    launchId: '',
    hasStagedCookies: true,
    openPostMode: true,
  });
  vm.runInNewContext(source, {
    self: fauxWorker(),
    chrome,
    fetch,
    console,
    Date: FastDate,
    setTimeout: (callback, delay = 0) => setTimeout(callback, Math.min(delay, 5)),
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    Promise,
    JSON,
    RegExp,
    String,
    Error,
  }, { filename: 'cookie-sync-open-post-order.js' });

  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(sequence[0], 'cookie-imported');
  assert.equal(sequence[1], 'navigate:https://x.com/example/status/123');
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
      self: fauxWorker(),
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
  // Doit suivre le canal stable de Chrome for Testing : la 151.0.7922.47
  // envoyait 18 extensions TLS la ou le Chrome stable en envoie 16.
  assert.match(launcher, /const MANAGED_CHROME_VERSION = '151\.0\.7922\.77'/);
  assert.match(launcher, /cachedVersion === MANAGED_CHROME_VERSION/);
  assert.match(launcher, /alignUserAgentToBrowser/);

  // Chrome gele les trois derniers composants de sa version dans l'User-Agent
  // depuis 2023 : tous annoncent Chrome/<majeure>.0.0.0. S'aligner sur la
  // version complete du binaire produisait une chaine qu'aucun Chrome n'envoie.
  assert.match(launcher, /User-Agent reduit comme le fait Chrome/);
  assert.match(launcher, /const reducedVersion = `\$\{String\(browserVersion\)\.split\('\.'\)\[0\]\}\.0\.0\.0`/);

  assert.match(launcher, /normalizedPath\.startsWith\(`\$\{managedBrowserRoot\}\$\{path\.sep\}`\)/);
  assert.match(launcher, /browserVersions\.get\(normalizedPath\)/);
  assert.match(launcher, /const fp = \{\s*\.\.\.effectiveFingerprint,\s*userAgent,\s*platform,\s*architecture,\s*brands,/);
});

test('client hints follow the profile fingerprint instead of the host OS', () => {
  const launcher = read('desktop-app/src/main/puppeteer-launcher.ts');

  // The platform advertised over HTTP is derived from the fingerprint, not from process.platform.
  assert.match(
    launcher,
    /const clientHintsPlatform = isWindows \? 'Windows' : isMac \? 'macOS' : 'Linux'/
  );
  assert.match(launcher, /buildClientHintsRules\(\s*clientHintsPlatform,/);
  assert.match(launcher, /'client-hints-rules\.json'/);
  assert.match(launcher, /header: 'sec-ch-ua-platform',\s*operation: 'set'/);

  // Navigation requests carry the login, so main_frame must be covered.
  assert.match(launcher, /resourceTypes: \[\s*'main_frame'/);

  // Ces en-tetes etaient supprimes pour que l'OS de la machine ne fuite jamais.
  // Mesure du 11 aout 2026 : un Chrome qui refuse de repondre a une demande de
  // client hints est plus rare, donc plus remarquable, qu'un Chrome qui repond
  // banalement. La suppression devenait elle-meme le signal. Les valeurs sont
  // desormais derivees de l'empreinte du profil, jamais de l'hote.
  for (const header of [
    'sec-ch-ua-platform-version',
    'sec-ch-ua-arch',
    'sec-ch-ua-bitness',
    'sec-ch-ua-model',
    'sec-ch-ua-full-version-list',
  ]) {
    assert.doesNotMatch(launcher, new RegExp(`header: '${header}', operation: 'remove'`));
  }

  // Accept-Language follows the fingerprint too: --lang is ignored on macOS, so a US
  // profile opened on a French Mac used to announce fr-FR behind a US proxy.
  assert.match(launcher, /buildAcceptLanguage\(effectiveFingerprint\)/);
  assert.match(launcher, /header: 'accept-language',\s*operation: 'set'/);
  assert.match(launcher, /fingerprint\?\.language \|\| 'en-US'/);
  assert.match(launcher, /header: 'sec-ch-ua',\s*operation: 'set'/);
  assert.match(launcher, /brand: 'Google Chrome'/);

  // Le pendant JavaScript de ces en-tetes -- la reecriture de
  // navigator.userAgentData -- a ete retire le 15 aout 2026 avec les autres
  // substitutions d'identite : le navigateur compile pour Spectra annonce deja
  // les bonnes valeurs, et cette couche etait mesuree comme la cause du refus
  // de connexion de X. Les en-tetes, eux, restent poses ci-dessus.
  assert.doesNotMatch(launcher, /uaDataProto\.getHighEntropyValues = function\(hints\)/);
  assert.doesNotMatch(launcher, /define\(Navigator\.prototype, 'platform'/);
  // Les hints de haute entropie partent donc tels que Chrome les produit.
  // C'est coherent tant que l'hote et le profil annoncent le meme OS ; sur un
  // hote different il faudrait les FIXER dans les regles d'en-tetes, jamais les
  // retirer. La detection arm/x86 reste calculee et prete pour ce jour-la.
  assert.match(launcher, /effectiveFingerprint\.architecture/);
  assert.match(launcher, /Apple M\\d\/i\.test\(effectiveFingerprint\.webglRenderer/);

  // TZ is ignored by Chromium on Windows. Date and Intl are therefore virtualized in
  // the shared runtime so the same profile keeps its IANA timezone on every device.
  assert.match(launcher, /const DateTimeFormatProxy = new Proxy\(NativeDateTimeFormat/);
  // getTimezoneOffset etait seul reecrit : getHours et toString rendaient
  // l'heure reelle de la machine, six heures d'ecart sur la meme page. Toutes
  // les composantes derivent desormais du meme decalage, via poser().
  assert.match(launcher, /poser\('getTimezoneOffset', function\(\)/);
  assert.match(launcher, /poser\('toString', function\(\)/);
  assert.match(launcher, /timeZone: targetTimezone/);
  assert.match(launcher, /effectiveFingerprint\.timezone = proxy\.timezone/);
  assert.match(launcher, /Based on IP:/);

  // The actual exit is resolved through the proxy before the first browser page.
  assert.match(launcher, /inspectProxyGeo\(proxy\)/);
  assert.match(launcher, /alignFingerprintWithProxyGeo/);
  assert.match(launcher, /proxy_runtime_geo\.json/);
  assert.match(launcher, /language: locale\.language/);
  assert.match(launcher, /latitude: geo\.latitude/);
  assert.match(launcher, /longitude: geo\.longitude/);

  // La substitution des coordonnees a ete retiree le 15 aout 2026 avec le bloc
  // d'identite dont elle faisait partie. Elle ne jouait que si un site demandait
  // la geolocalisation ET que l'utilisateur l'accordait -- Chrome la refuse par
  // defaut. La position du proxy reste calculee et rangee dans l'empreinte,
  // d'ou viennent le fuseau et la langue ; seule la reecriture de
  // navigator.geolocation est partie.
  assert.doesNotMatch(launcher, /nativeGetCurrentPosition\.call/);
  assert.doesNotMatch(launcher, /nativeWatchPosition\.call/);
  assert.match(launcher, /proxyGeo: \{[\s\S]*latitude: geo\.latitude/);

  // The rules ship in the shared per-profile extension, so every launch mode and every
  // tab is covered without per-target wiring.
  assert.match(launcher, /declarative_net_request: \{/);
  assert.match(launcher, /if \(platformFixPath\) extPaths\.push\(platformFixPath\)/);

  // The fix must not reintroduce a debug port on this deliberately CDP-free launcher.
  assert.doesNotMatch(launcher, /remote-debugging-port/);
  assert.doesNotMatch(launcher, /setUserAgentOverride/);
  assert.match(launcher, /SPAWN Chrome — no Puppeteer, no CDP, no debug port/);
});

test('a profile never launches with the fingerprint runtime silently disabled', () => {
  const launcher = read('desktop-app/src/main/puppeteer-launcher.ts');

  // Stable Google Chrome ignores --load-extension, so it can never stand in for the
  // managed browser: doing so would drop the whole fingerprint extension without warning.
  assert.match(launcher, /Managed browser unavailable: \$\{downloadError\.message\}/);
  assert.match(launcher, /ignores --load-extension/);
  assert.doesNotMatch(launcher, /chromePath = systemChrome/);
  assert.doesNotMatch(launcher, /Managed browser unavailable, using system Chrome/);

  // The fingerprint runtime stays mandatory rather than best-effort.
  assert.match(launcher, /if \(platformFixPath\) extPaths\.push\(platformFixPath\)/);
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
  assert.match(launcher, /const fp = \{\s*\.\.\.effectiveFingerprint,\s*userAgent,\s*platform,\s*architecture,\s*brands,/);
  assert.match(launcher, /'fingerprint_override\.json'/);
  assert.match(sync, /'fingerprint_override\.json'/);
});

test('cloud profile restore validates in staging and rolls back failed swaps', () => {
  const sync = read('desktop-app/src/main/profile-sync.ts');
  // La validation porte sur ce qui rend le profil utilisable -- sa session --
  // et non plus sur les preferences, dont l'absence condamnait le profil sans
  // possibilite de reparation.
  assert.match(sync, /Cloud profile archive is unusable/);
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

test('proxy checks persist a complete IP-based geography snapshot', () => {
  const proxyManager = read('desktop-app/src/main/proxy-manager.ts');
  const main = read('desktop-app/src/main/main.ts');
  const page = read('desktop-app/src/renderer/pages/ProxyManager.tsx');

  assert.match(proxyManager, /fields=status,message,countryCode,regionName,city,lat,lon,timezone,query/);
  assert.match(proxyManager, /interface ProxyGeoSnapshot/);
  assert.match(proxyManager, /new Intl\.DateTimeFormat\('en-US', \{ timeZone: data\.timezone \}\)/);
  assert.match(main, /exitIp: proxyConfig\.lastExitIp \|\| null/);
  assert.match(page, /updateData\.timezone = timezone/);
  assert.match(page, /updateData\.latitude = latitude/);
  assert.match(page, /updateData\.longitude = longitude/);
  assert.match(page, /updateData\.lastExitIp = exitIp/);
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

test('Auto Post accepts only authenticated exact X post events', () => {
  const urlServer = read('desktop-app/src/main/url-server.ts');
  const main = read('desktop-app/src/main/main.ts');
  const preload = read('desktop-app/src/main/preload.ts');

  assert.match(urlServer, /req\.url === '\/api\/auto-post-event'/);
  assert.match(urlServer, /const postUrl = normalizeTweetUrl\(data\?\.postUrl\)/);
  assert.match(urlServer, /req\.headers\.authorization !== `Bearer \$\{this\.token\}`/);
  assert.match(urlServer, /createHash\('sha256'\)[\s\S]*postUrl\}\|\$\{sourceProfileId/);
  assert.match(main, /ipcMain\.on\('internal:auto-post-event'/);
  assert.match(preload, /ipcRenderer\.on\('autoPost:event'/);
});

test('Auto Post observes VenusBot asynchronously and reuses the existing Open Post engine', () => {
  const launcher = read('desktop-app/src/main/puppeteer-launcher.ts');
  const app = read('desktop-app/src/renderer/App.tsx');
  const dashboard = read('desktop-app/src/renderer/pages/Dashboard.tsx');
  const main = read('desktop-app/src/main/main.ts');
  const preload = read('desktop-app/src/main/preload.ts');

  assert.match(launcher, /spectra-auto-post-bridge\.js/);
  assert.match(launcher, /const result = await original\(text, media, \.\.\.args\);/);
  assert.match(launcher, /report\(this, text\)\.catch/);
  assert.match(launcher, /if \(result\?\.success\)/);
  assert.match(launcher, /resolvePostUrl\(text, account\)/);
  assert.match(launcher, /api\/client\/post-published/);
  assert.match(launcher, /relayOnly: true/);
  assert.match(launcher, /The cloud relay is authoritative/);
  assert.match(launcher, /catch \(relayError\)[\s\S]*fetch\(SERVER \+ '\/api\/auto-post-event'/);
  assert.match(launcher, /fetch\(SERVER \+ '\/api\/auto-post-event'/);
  assert.match(main, /ipcMain\.handle\('autoPost:claimNext'/);
  assert.match(main, /ipcMain\.handle\('autoPost:complete'/);
  assert.match(preload, /claimNext: \(payload/);
  assert.match(preload, /complete: \(payload/);
  assert.match(app, /window\.electronAPI\.autoPost!\.claimNext/);
  assert.match(app, /window\.electronAPI\.autoPost\.complete/);
  assert.match(app, /claimToken/);
  assert.match(app, /seenAutoPostUrlsRef/);
  assert.match(app, /handleOpenTweetInFolder\(profileIds, event\.postUrl\)/);
  assert.match(dashboard, /Auto Post — en écoute/);
  assert.match(dashboard, /Auto Post — traitement/);
  assert.match(dashboard, /Open post \(\{selectedFolderProfileIds\.length\}\)/);
});

test('no diagnostic scaffolding ships in a released build', () => {
  const launcher = read('desktop-app/src/main/puppeteer-launcher.ts');

  // Quatre outils poses les 12 et 13 aout 2026 pour trouver pourquoi X refusait
  // la connexion, puis pourquoi quatre profils ne republiaient pas. Les deux
  // questions ont leur reponse, inscrite dans le code. Retires le 15 aout.

  // 1-3. Les journaux de secours. Ils ecrivaient a chaque etape, dans chaque
  // profil, et rien ne les relisait en usage normal.
  assert.doesNotMatch(launcher, /spectraJournalOpenPost/);
  assert.doesNotMatch(launcher, /spectraJournalDemarrage/);
  assert.doesNotMatch(launcher, /spectraJournalInjection/);
  assert.doesNotMatch(launcher, /noterSurDisque/);

  // 4. L'interrupteur cache : le fichier temoin `spectra-sans-entetes.flag`,
  // depose dans le dossier personnel et relu a chaque lancement. Selon son
  // contenu -- entetes, sansbot, sansjs, nu, moitiea, moitieb, fuseauseul,
  // sansfuseau -- il eteignait l'empreinte, les en-tetes ou les extensions
  // d'un profil, en silence. Inacceptable dans une version livree.
  assert.doesNotMatch(launcher, /modeDiagnostic/);
  assert.doesNotMatch(launcher, /sans-entetes\.flag/);
  assert.doesNotMatch(launcher, /partieEmpreinte/);
  assert.doesNotMatch(launcher, /sansReecritureEntetes|sansJavaScriptInjecte/);
  assert.doesNotMatch(launcher, /\[Diagnostic\]/);

  // Ce que la suppression ne doit pas emporter : l'empreinte et les en-tetes
  // sont desormais poses sans condition.
  assert.match(launcher, /permissions: \['declarativeNetRequest'\]/);
  assert.match(launcher, /js: \['fingerprint\.js'\]/);
  assert.match(launcher, /path: 'client-hints-rules\.json'/);

  // Les evenements de cycle de vie, eux, restent : ils partent vers Spectra,
  // qui les conserve. Ce sont eux qui remplacent les journaux retires.
  assert.match(launcher, /reportLifecycleEvent\('startup-chain-broken'/);
  assert.match(launcher, /reportLifecycleEvent\('open-post-actions-injection-failed'/);
});

test("le droit d'envoi au cloud se juge sur la session portable, pas sur la base de Chrome", () => {
  const launcher = read('desktop-app/src/main/puppeteer-launcher.ts');

  // Piege verifie le 18 aout 2026, et deja tombe dedans une fois : sur un
  // profil pilote par Open Post, Chrome est tue une seconde apres le retweet.
  // Sa base de cookies reste donc vide sur le disque alors que le compte est
  // parfaitement connecte -- Kirby_Maree et honeymadydy ont retweete et like
  // ce jour-la avec une base vide. Conditionner l'envoi a cette base bloquerait
  // des comptes sains et les empecherait de se synchroniser a jamais.
  const corps = (launcher.split('private static ensureAuthenticatedXSnapshot')[1] || '').slice(0, 1200);
  assert.ok(corps.includes("path.join(profilePath, 'authenticated_cookies.json')"));
  assert.doesNotMatch(corps, /Default', 'Network', 'Cookies'/);

  // Les deux fermetures -- sortie de Chrome et fermeture forcee -- passent par
  // cette meme fonction : c'est le seul point ou le droit d'envoi se decide.
  assert.equal(launcher.split('this.ensureAuthenticatedXSnapshot(').length - 1, 4);
  assert.match(launcher, /missing-authenticated-x-snapshot/);
});

test('le navigateur Spectra est trouve sur macOS comme sur Windows', () => {
  const launcher = read('desktop-app/src/main/puppeteer-launcher.ts');
  const corps = (launcher.split('private static findSpectraBrowser')[1] || '').slice(0, 1600);

  // Sur macOS, une compilation de Chromium produit un paquet `.app` : chercher
  // un fichier `chrome` a la racine ne trouve jamais rien, et le Mac retombe
  // silencieusement sur Chrome for Testing -- le binaire que X refuse, et la
  // cause n°1 des connexions bloquees du 12 aout 2026.
  assert.ok(corps.includes("'Chromium.app', 'Contents', 'MacOS', 'Chromium'"));
  assert.ok(corps.includes("'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'"));

  // Windows ne doit pas changer de comportement : un seul candidat, chrome.exe.
  assert.ok(corps.includes("? ['chrome.exe']"));

  // La reserve de branding et de publications se trouve elle aussi des deux
  // cotes. Le 20 aout 2026, sur le Mac d'un ami, la section Branding s'est
  // ouverte entierement vide : le chemin etait ecrit en dur pour Windows a
  // quatre endroits, et AppData\Local n'existe pas sur macOS.
  const principal = read('desktop-app/src/main/main.ts');
  assert.match(
    principal,
    /function racineBranding\(\)[\s\S]{0,200}process\.platform === 'win32'[\s\S]{0,200}'\.antidetect-browser'/
  );
  // Plus une seule copie ecrite en dur : elles ne suivraient pas la correction.
  assert.doesNotMatch(
    principal,
    /const racine = path\.join\(os\.homedir\(\), 'AppData'/
  );

  // Le fichier nu reste accepte en dernier recours, pour Linux et pour un
  // paquet deja deballe a la main.
  assert.ok(corps.includes("'chrome',"));

  // Tous les chemins de profils hors Windows pointent au meme endroit : trois
  // fichiers en donnent leur propre copie, elles doivent rester d'accord.
  for (const f of [
    'desktop-app/src/main/main.ts',
    'desktop-app/src/main/profile-sync.ts',
    'desktop-app/src/main/puppeteer-launcher.ts',
  ]) {
    assert.ok(read(f).includes("'.antidetect-browser', 'profiles'"), f);
  }
});

test('VA Manager fonctionne meme sans coffre systeme, sans jamais ecrire en clair', () => {
  const client = read('desktop-app/src/main/va-manager-client.ts');

  // Le 18 aout 2026, sur le premier Mac a faire tourner Spectra, le trousseau
  // refusait l'application : safeStorage.isEncryptionAvailable() rendait faux et
  // la connexion VA Manager echouait sur « Le chiffrement securise Windows est
  // indisponible » -- un message qui parlait de Windows sur un Mac, en plus.
  assert.ok(client.includes('let sessionEnMemoire: StoredSession | null = null;'));

  // Le repli garde la session en memoire pour la duree de l'application, et ne
  // leve plus d'exception : c'est le refus pur et simple qui bloquait le Mac.
  const sauve = (client.split('function saveEncryptedSession')[1] || '').slice(0, 700);
  assert.ok(sauve.includes('sessionEnMemoire = session;'));
  assert.doesNotMatch(sauve, /throw new Error/);

  // ...et n'ecrit RIEN sur le disque dans ce cas : ces jetons ouvrent VA
  // Manager, qui detient les mots de passe et les cles 2FA de tous les comptes.
  const avantEcriture = sauve.split('store.set(')[0];
  assert.ok(avantEcriture.includes('return;'));
  assert.ok(sauve.includes('safeStorage.encryptString'));

  // La deconnexion doit vider les deux endroits, pas seulement le disque.
  const deco = (client.split('export function disconnectVaManager')[1] || '').slice(0, 200);
  assert.ok(deco.includes('sessionEnMemoire = null;'));
  assert.ok(deco.includes('store.delete('));

  // Et l'utilisateur doit savoir que sa session ne survivra pas au redemarrage.
  assert.ok(client.includes('memorisee: coffreSystemeDisponible()'));
  assert.match(
    read('desktop-app/src/renderer/pages/VaManagerPage.tsx'),
    /connection\.memorisee === false/
  );
});

test('la page VA Manager montre et filtre par assistant', () => {
  const client = read('desktop-app/src/main/va-manager-client.ts');
  const page = read('desktop-app/src/renderer/pages/VaManagerPage.tsx');

  // VA Manager sait qui tient quel compte ; Spectra ne demandait pas ces deux
  // colonnes, donc creer les instances d'un seul assistant obligeait a les
  // cocher une par une.
  assert.ok(client.includes('va_id,assigned_va_id'));
  assert.ok(client.includes("table: 'vas'"));
  assert.ok(client.includes("columns: 'id,name,organization_id'"));

  // Meme regle de priorite que VA Manager lui-meme
  // (api/scan-shadowban.js : `acc.assigned_va_id || acc.va_id`). L'inverser
  // afficherait le mauvais assistant sur les comptes partages.
  assert.ok(client.includes('account.assigned_va_id || account.va_id || null'));

  // La liste des assistants du menu vient des comptes eux-memes : elle ne
  // propose donc que des VA qui ont vraiment des comptes ici.
  assert.ok(page.includes('const listeVa = useMemo('));
  assert.ok(page.includes("if (filtreVa === 'sans-va') return !account.vaId;"));

  // Le filtre doit etre dans les dependances du calcul, sinon la liste ne se
  // rafraichit pas quand on change d'assistant.
  // On verifie que chaque filtre y figure, sans figer la liste entiere :
  // epingler l'ordre exact faisait echouer ce test a chaque nouveau filtre
  // ajoute, alors que la regle protegee est seulement < tout filtre lu doit
  // etre dans les dependances >. Casse le 23 aout 2026 en ajoutant le
  // masquage des comptes deja en place.
  const debutMemo = page.indexOf('const visibleAccounts = useMemo(');
  assert.ok(debutMemo >= 0, 'visibleAccounts est introuvable');
  const finMemo = page.indexOf('}, [', debutMemo);
  const finDeps = page.indexOf(']);', finMemo);
  assert.ok(finMemo > 0 && finDeps > finMemo, 'les dependances de visibleAccounts sont introuvables');
  const deps = page.slice(finMemo + 4, finDeps);
  for (const nom of ['accounts', 'auditFilter', 'etatParCompte', 'filtreVa', 'montrerEnPlace', 'search', 'sort', 'statusFilter']) {
    assert.ok(deps.includes(nom), nom + ' manque dans les dependances de visibleAccounts');
  }

  // Et le nom s'affiche sur la ligne du compte.
  assert.ok(page.includes('{account.vaName}'));
});

test('le verrou d\'instance de Chrome est retire meme quand le lien est casse', () => {
  const launcher = read('desktop-app/src/main/puppeteer-launcher.ts');
  const corps = (launcher.split('private static clearStaleSingletonFiles')[1] || '').slice(0, 1400);

  // Sur macOS et Linux, SingletonLock est un lien symbolique vers
  // `machine-numero`. Le bot ferme de force a chaque tour, donc la cible
  // disparait et le lien reste. `existsSync` suit le lien et repond "absent" :
  // le verrou n'etait jamais retire et Chrome refusait de rouvrir le profil.
  assert.ok(corps.includes('fs.lstatSync(target)'));
  assert.doesNotMatch(corps, /fs\.existsSync\(target\)/);
  assert.ok(corps.includes("'SingletonLock', 'SingletonCookie', 'SingletonSocket'"));
});

test('les profils encore ouverts sont vus hors Windows aussi', () => {
  const launcher = read('desktop-app/src/main/puppeteer-launcher.ts');
  const corps = (launcher.split('static async getRunningProfiles')[1] || '').slice(0, 2000);

  // Sur Windows, Spectra lit la table des processus : cela rattrape les profils
  // restes ouverts apres un redemarrage de l'application. Hors Windows il s'en
  // tenait a sa memoire interne, donc il les croyait fermes -- et un second
  // navigateur serait parti sur le meme dossier de profil.
  assert.ok(corps.includes('this.lireTableProcessus()'));
  assert.ok(corps.includes("'.antidetect-browser', 'profiles'"));

  // La table doit etre lue une seule fois pour toute la liste, pas une fois par
  // instance : quarante-sept appels systeme a chaque rafraichissement.
  assert.equal(corps.split('lireTableProcessus').length - 1, 1);

  // Et Windows garde exactement son chemin d'avant.
  assert.ok(corps.includes("process.platform !== 'win32'"));
  assert.ok(corps.includes("Name = 'chrome.exe'"));
});
