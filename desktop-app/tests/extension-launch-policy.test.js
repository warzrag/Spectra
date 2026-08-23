const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const sourcePath = path.resolve(
  __dirname,
  '..',
  'src',
  'shared',
  'extension-launch-policy.ts'
);
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const moduleUnderTest = { exports: {} };
new Function('exports', 'module', compiled)(moduleUnderTest.exports, moduleUnderTest);
const { shouldLoadExtensionForLaunch } = moduleUnderTest.exports;

// VenusBot avait ete ecarte des lancements manuels le 11 aout 2026, sur
// l'hypothese qu'il derangeait la connexion a X. La bisection du 12 aout a
// designe d'autres causes -- le binaire Chrome for Testing, puis les
// substitutions d'identite -- et disculpe le robot. La restriction privait
// l'utilisateur de ses extensions en ouverture normale : elle est levee.
test('un lancement manuel garde toutes les extensions du profil', () => {
  assert.equal(shouldLoadExtensionForLaunch({
    extensionName: 'Twitter Auto Reply DM — V4-mini',
    hasTargetTweet: false,
    autoStartTwitterBot: false,
  }), true);
});

test('Open Selected et Open Post les gardent aussi', () => {
  assert.equal(shouldLoadExtensionForLaunch({
    extensionName: 'Twitter Auto Reply DM — V4-mini',
    hasTargetTweet: false,
    autoStartTwitterBot: true,
  }), true);
  assert.equal(shouldLoadExtensionForLaunch({
    extensionName: 'Twitter Auto Reply DM — V4-mini',
    hasTargetTweet: true,
    autoStartTwitterBot: false,
  }), true);
});

test('les autres extensions restent disponibles partout', () => {
  assert.equal(shouldLoadExtensionForLaunch({
    extensionName: 'Shadowban Scanner',
    hasTargetTweet: false,
    autoStartTwitterBot: false,
  }), true);
});
