const path = require('path');
const os = require('os');
const { app } = require('electron');

app.setName('spectra');
app.setPath('userData', path.join(os.homedir(), 'AppData', 'Roaming', 'spectra'));

app.whenReady().then(async () => {
  try {
    const Store = require('electron-store');
    const client = require('../dist/src/main/va-manager-client.js');
    const store = new Store();
    const organizations = await client.listVaManagerOrganizations(store);
    const requestedOrganizationId = process.argv[2] || '';
    const mode = process.argv[3] || 'audit';
    if (!requestedOrganizationId) {
      process.stdout.write(JSON.stringify({ organizations }));
      return;
    }
    if (mode === 'fill') {
      const records = JSON.parse(require('fs').readFileSync(0, 'utf8'));
      const result = await client.fillMissingVaManagerAccountInformation(
        store,
        requestedOrganizationId,
        records
      );
      process.stdout.write(JSON.stringify(result));
      return;
    }
    if (mode === 'anomalies') {
      const findings = await client.auditVaManagerCredentialPlacement(
        store,
        requestedOrganizationId
      );
      process.stdout.write(JSON.stringify({ findings }));
      return;
    }
    const accounts = await client.listVaManagerAccounts(store, requestedOrganizationId);
    process.stdout.write(JSON.stringify({
      organizationId: requestedOrganizationId,
      accounts: accounts.map(account => ({
        id: account.id,
        organizationId: account.organizationId,
        username: account.username,
        hasPassword: account.hasPassword,
        passwordUsable: account.passwordUsable,
        hasTwoFa: account.hasTwoFa,
        hasEmail: account.hasEmail,
        hasEmailPassword: account.hasEmailPassword,
        emailPasswordUsable: account.emailPasswordUsable,
        hasCookies: account.hasCookies,
      })),
    }));
  } catch (error) {
    process.stderr.write(String(error?.stack || error));
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
