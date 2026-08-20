// Garde-fou sur le script d'empreinte injecte dans chaque page.
//
// Le 11 aout 2026, neuf defauts s'etaient accumules sans que rien ne les
// signale : etiquette sec-ch-ua figee depuis Chrome 131, getters qui avouaient
// leur code source, pixels transparents colores, fuseau incoherent de six
// heures. Chacun se lit en quelques lignes de JavaScript depuis une page web.
//
// Ces tests lisent le vrai script injecte, pas une copie : ils suivent donc le
// code s'il change. Ils tournent avec `npm test`.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const sourcePath = path.resolve(__dirname, '..', 'src', 'main', 'puppeteer-launcher.ts');
const source = fs.readFileSync(sourcePath, 'utf8');

// Les commentaires citent volontairement les anciennes valeurs fautives, pour
// documenter ce qui a ete corrige. Une verification "cette valeur a disparu"
// doit donc porter sur le code seul, sinon la documentation la fait echouer.
const code = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    removeComments: true,
  },
}).outputText;

// --- extraction du script reellement ecrit dans le profil -------------------

const extraireScript = (nomFichier) => {
  const debut = source.indexOf(`'${nomFichier}'), \``);
  assert.notEqual(debut, -1, `script ${nomFichier} introuvable dans la source`);
  const apres = source.indexOf('`', debut + nomFichier.length + 5);
  const fin = source.indexOf('\n`);', apres);
  assert.notEqual(fin, -1, `fin du script ${nomFichier} introuvable`);
  return source.slice(apres + 1, fin);
};

const injecte = extraireScript('fingerprint.js');

// --- comportement reel du bruit canvas --------------------------------------

const chargerBruiter = (graine) => {
  const bloc = injecte.match(/const bruiter = \(data\) => \{[\s\S]*?\n {4}\};/);
  assert.ok(bloc, 'fonction bruiter introuvable dans le script injecte');
  return new Function('graine', 'PAS', `${bloc[0]}\nreturn bruiter;`)(graine, 1024);
};

const canvas = (pixels, remplir) => {
  const data = new Uint8ClampedArray(pixels * 4);
  if (remplir) for (let i = 0; i < data.length; i += 4) remplir(data, i);
  return data;
};

test('un canvas vierge ne rend que des pixels transparents purs', () => {
  // Controle le plus courant : lire un canvas sur lequel rien n'a ete dessine.
  // Tout navigateur renvoie des zeros. L'ancien code ecrivait rouge=255.
  const data = canvas(64 * 64);
  chargerBruiter(12345)(data);
  const fautifs = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0 && (data[i] || data[i + 1] || data[i + 2])) fautifs.push(i / 4);
  }
  assert.deepEqual(fautifs, [], `pixels transparents colores : ${fautifs.slice(0, 5)}`);
});

test('aucune couleur ne saute d une extremite a l autre', () => {
  // L'ancien "& 255" repliait 0 en 255 : un pixel noir devenait rouge vif.
  for (const graine of [1, 2, 3, 7, 12345]) {
    const avant = canvas(64 * 64, (d, i) => { d[i + 3] = 255; });
    const apres = Uint8ClampedArray.from(avant);
    chargerBruiter(graine)(apres);
    for (let i = 0; i < apres.length; i += 4) {
      for (let c = 0; c < 3; c += 1) {
        const ecart = Math.abs(apres[i + c] - avant[i + c]);
        assert.ok(ecart <= 1, `graine ${graine}, pixel ${i / 4} : ecart de ${ecart}`);
      }
    }
  }
});

test('le bruit reste efficace : deux profils ne rendent pas la meme image', () => {
  // Un bruit trop prudent ne servirait plus a rien.
  const gris = () => canvas(64 * 64, (d, i) => {
    d[i] = 128; d[i + 1] = 128; d[i + 2] = 128; d[i + 3] = 255;
  });
  const a = gris(); chargerBruiter(1)(a);
  const b = gris(); chargerBruiter(2)(b);
  const temoin = gris();
  assert.notDeepEqual(Array.from(a), Array.from(temoin), 'le bruit ne modifie rien');
  assert.notDeepEqual(Array.from(a), Array.from(b), 'deux profils rendent la meme image');
});

test('un silence audio reste un silence', () => {
  const bloc = injecte.match(/if \(data\[index\] === 0\) continue;/);
  assert.ok(bloc, 'le bruit audio colore encore les echantillons nuls');
});

// --- toutes les portes de lecture ------------------------------------------

test('toutes les lectures du canvas passent par le meme bruit', () => {
  // Ne bruiter que getImageData rendait les lectures incoherentes entre elles,
  // ce qui se repere plus facilement qu'une absence de bruit.
  for (const porte of ['getImageData', 'toDataURL', 'toBlob', 'readPixels']) {
    assert.match(injecte, new RegExp(`'${porte}'`), `lecture non couverte : ${porte}`);
  }
  assert.match(injecte, /OffscreenCanvasRenderingContext2D/, 'canvas hors ecran non couvert');
});

// --- masquage ---------------------------------------------------------------

test('chaque methode reecrite se fait passer pour native', () => {
  // remplacer() applique commeNatif ; toute reecriture directe y echappe.
  const remplacer = injecte.match(/const remplacer = \(cible, nom, fabrique\)[\s\S]*?\n  \};/);
  assert.ok(remplacer, 'helper remplacer introuvable');
  assert.match(remplacer[0], /commeNatif/, 'remplacer n applique pas le masquage');

  const directes = injecte.match(
    /(?:CanvasRenderingContext2D|WebGLRenderingContext|WebGL2RenderingContext|HTMLCanvasElement|AudioBuffer)\.prototype\.\w+\s*=/g
  );
  assert.equal(directes, null, `reecriture non masquee : ${directes && directes.join(', ')}`);
});

test('toString ne rend jamais le code source d une fonction remplacee', () => {
  assert.match(injecte, /\[native code\]/, 'masque [native code] absent');
  assert.doesNotMatch(injecte, /get: \(\) => value/, 'ancien getter revelateur present');
});

// --- WebGL ------------------------------------------------------------------

test('les quatre questions posees a la carte graphique sont couvertes', () => {
  // 37445/37446 : extension de debogage. 7936/7937 : VENDOR et RENDERER
  // standard, laisses sans reponse jusqu'au 11 aout 2026 -- ils trahissaient
  // SwiftShader sur un serveur alors que l'empreinte annonce une vraie carte.
  for (const code of ['37445', '37446', '7936', '7937']) {
    assert.match(injecte, new RegExp(`=== ${code}`), `parametre WebGL non traite : ${code}`);
  }
});

test('la poignee de main TLS reste celle du Chrome stable', () => {
  // Chrome for Testing active sa configuration d'essais integree, qui ajoute
  // deux extensions TLS experimentales (0x12E0 et 0xCA34) : 18 au lieu de 16.
  // Aucun navigateur reel n'envoie cela, et c'est lu avant tout le reste.
  //
  // Mesure du 11 aout 2026, meme machine, tls.browserleaks.com :
  //   Chrome stable 151       t13d1516h2_8daaf6152771_806a8c22fdea
  //   sans ce drapeau         t13d1518h2_8daaf6152771_4980c97edce0
  //   avec ce drapeau         t13d1516h2_8daaf6152771_806a8c22fdea
  assert.match(code, /--disable-field-trial-config/, 'configuration d essais non desactivee');
});

test('le rendu logiciel est autorise, jamais impose', () => {
  // Force partout, il donne au poste de travail la signature d une machine
  // virtuelle : exactement ce qu on cherche a eviter.
  assert.doesNotMatch(code, /--use-angle=swiftshader/, 'rendu logiciel impose a tous les profils');
  assert.match(code, /--enable-unsafe-swiftshader/, 'repli logiciel non autorise');
});

// --- identite ---------------------------------------------------------------

test('sec-ch-ua est calcule, jamais recopie', () => {
  // L'etiquette etait figee sur celle de Chrome 131. Chromium la derive du
  // numero de version : recopiee, elle contredit le user-agent.
  assert.match(code, /chromeBrandList/, 'generateur sec-ch-ua absent');
  assert.doesNotMatch(code, /Not_A Brand/, 'etiquette figee presente dans le code');
});

test('les client hints ne sont plus supprimes', () => {
  // Un Chrome qui refuse de dire son materiel est plus rare qu un Chrome banal.
  assert.doesNotMatch(code, /operation: ["']remove["']/, 'client hints encore supprimes');
});

test('aucun port de pilotage ne reste ouvert', () => {
  // Tentative du 11 aout 2026 : poser l'identite par le protocole de pilotage
  // de Chrome. Ces substitutions meurent avec la session qui les pose, donc il
  // aurait fallu garder un client attache -- ce qui active le domaine Runtime,
  // qu'une page sait detecter. On echangeait une incoherence contre un
  // marqueur franc. Le lanceur reste sans port.
  for (const interdit of [
    'remote-debugging-port',
    'setUserAgentOverride',
    'setTimezoneOverride',
    'Target.setAutoAttach',
    'puppeteer-core',
  ]) {
    assert.doesNotMatch(code, new RegExp(interdit.replace('.', '\\.')),
      `pilotage reintroduit : ${interdit}`);
  }
});

test('toutes les composantes de Date suivent le fuseau annonce', () => {
  // getTimezoneOffset seul etait reecrit : la page affichait 9h42 d un cote et
  // 15h de l autre, six heures d ecart lisibles en une expression.
  for (const champ of ['getFullYear', 'getMonth', 'getDate', 'getDay', 'getHours',
    'getMinutes', 'getSeconds', 'getMilliseconds']) {
    assert.match(injecte, new RegExp(`${champ}:`), `composante non derivee : ${champ}`);
  }
  for (const rendu of ['toString', 'toDateString', 'toTimeString']) {
    assert.match(injecte, new RegExp(`poser\\('${rendu}'`), `rendu non aligne : ${rendu}`);
  }
});

test('la profondeur de couleur reste celle d un ecran ordinaire', () => {
  // 30 bits n existe quasiment pas sur les postes reels ; c etait un marqueur.
  // La valeur nait dans le generateur d empreintes, pas dans le lanceur.
  const generateur = fs.readFileSync(
    path.resolve(__dirname, '..', 'src', 'main', 'fingerprint-generator.ts'),
    'utf8'
  );
  const codeGenerateur = ts.transpileModule(generateur, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, removeComments: true },
  }).outputText;
  assert.doesNotMatch(codeGenerateur, /\? 30 : 24/, 'colorDepth 30 encore possible');
  assert.match(code, /colorDepth: 24/, 'colorDepth non force cote injection');
});

test('la memoire ne peut plus s empiler sans limite', () => {
  assert.match(source, /BackForwardCache/, 'correctif memoire absent');
});
