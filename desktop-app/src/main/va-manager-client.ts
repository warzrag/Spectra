import { safeStorage } from 'electron';
import { createHash, randomBytes, webcrypto } from 'crypto';
import {
  VaManagerAccount,
  VaManagerConnectionStatus,
  VaManagerOrganization,
} from '../types';
import { normalizeVaManagerStatus, normalizeXUsername } from '../shared/va-manager';

const VA_MANAGER_ORIGIN = 'https://va-manager-pro.vercel.app';
const SUPABASE_URL = 'https://vjsovnhmjgehqawjmqxn.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_kIgnmS0tIhEty9LiAhtkhA_luo1XGXG';
const SESSION_STORE_KEY = 'vaManagerEncryptedSession';
const SPECTRA_COOKIES_MARKER =
  /\s*\[SPECTRA_COOKIES:v1:([a-f0-9]{64}):([A-Za-z0-9+/=]+)\]/gi;

type StoredSession = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  email: string;
  userId: string;
  role?: string;
  primaryOrganizationId?: string;
};

type StoreLike = {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  delete: (key: string) => void;
};

function assertOk(response: Response, message: string): Promise<any> {
  return response.text().then(text => {
    let payload: any = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }
    if (!response.ok) {
      const detail = payload?.error_description || payload?.message || payload?.error;
      throw new Error(detail ? `${message}: ${detail}` : message);
    }
    return payload;
  });
}

function parseEncryptedSession(store: StoreLike): StoredSession | null {
  const encrypted = store.get(SESSION_STORE_KEY);
  if (!encrypted || typeof encrypted !== 'string' || !safeStorage.isEncryptionAvailable()) return null;
  try {
    const json = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    const parsed = JSON.parse(json);
    if (!parsed?.accessToken || !parsed?.refreshToken || !parsed?.email) return null;
    return parsed as StoredSession;
  } catch {
    store.delete(SESSION_STORE_KEY);
    return null;
  }
}

function saveEncryptedSession(store: StoreLike, session: StoredSession): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Le chiffrement sécurisé Windows est indisponible');
  }
  const encrypted = safeStorage.encryptString(JSON.stringify(session));
  store.set(SESSION_STORE_KEY, encrypted.toString('base64'));
}

async function requestSupabaseSession(body: Record<string, string>, grantType: string): Promise<any> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=${grantType}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return assertOk(response, 'Connexion VA Manager impossible');
}

async function ensureSession(store: StoreLike): Promise<StoredSession> {
  const stored = parseEncryptedSession(store);
  if (!stored) throw new Error('VA Manager n’est pas connecté');
  if (stored.expiresAt > Date.now() + 60_000) return stored;

  try {
    const refreshed = await requestSupabaseSession(
      { refresh_token: stored.refreshToken },
      'refresh_token'
    );
    const session: StoredSession = {
      ...stored,
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token || stored.refreshToken,
      expiresAt: Date.now() + Number(refreshed.expires_in || 3600) * 1000,
      email: refreshed.user?.email || stored.email,
      userId: refreshed.user?.id || stored.userId,
      role: refreshed.user?.user_metadata?.role || stored.role,
      primaryOrganizationId:
        refreshed.user?.user_metadata?.organization_id || stored.primaryOrganizationId,
    };
    saveEncryptedSession(store, session);
    return session;
  } catch (error) {
    store.delete(SESSION_STORE_KEY);
    throw error;
  }
}

async function callVaManagerApi(
  session: StoredSession,
  path: string,
  body: Record<string, unknown>
): Promise<any> {
  const response = await fetch(`${VA_MANAGER_ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return assertOk(response, 'VA Manager ne répond pas');
}

async function getOrganizationPasswordKey(
  session: StoredSession,
  organizationId?: string
): Promise<JsonWebKey | null> {
  try {
    const payload = await callVaManagerApi(session, '/api/org-password-key', {
      action: 'get',
      organizationId: organizationId || session.primaryOrganizationId,
    });
    return payload?.keyJwk || null;
  } catch {
    return null;
  }
}

async function canDecryptCredential(value: unknown, keyJwk: JsonWebKey | null): Promise<boolean> {
  const stored = String(value || '');
  if (!stored) return false;
  if (!stored.startsWith('vmp1:')) return true;
  if (!keyJwk) return false;
  try {
    const combined = Buffer.from(stored.slice('vmp1:'.length), 'base64');
    if (combined.length <= 12) return false;
    const iv = combined.subarray(0, 12);
    const encrypted = combined.subarray(12);
    const key = await webcrypto.subtle.importKey(
      'jwk',
      keyJwk,
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );
    const decrypted = await webcrypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      encrypted
    );
    return Buffer.from(decrypted).toString('utf8').length > 0;
  } catch {
    return false;
  }
}

async function decryptCredential(value: unknown, keyJwk: JsonWebKey | null): Promise<string> {
  const stored = String(value || '');
  if (!stored) return '';
  if (stored.startsWith('vmp1:')) {
    if (!keyJwk) throw new Error('Clé de chiffrement VA Manager indisponible');
    try {
      const combined = Buffer.from(stored.slice('vmp1:'.length), 'base64');
      if (combined.length <= 12) throw new Error('invalid encrypted credential');
      const iv = combined.subarray(0, 12);
      const encrypted = combined.subarray(12);
      const key = await webcrypto.subtle.importKey(
        'jwk',
        keyJwk,
        { name: 'AES-GCM' },
        false,
        ['decrypt']
      );
      const decrypted = await webcrypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        encrypted
      );
      return Buffer.from(decrypted).toString('utf8');
    } catch {
      throw new Error('Identifiant VA Manager chiffré mais illisible');
    }
  }

  // Legacy VA Manager values were stored as reversed base64. Plain values are
  // also supported for old records, exactly like VA Manager itself.
  try {
    const decoded = Buffer.from(stored.split('').reverse().join(''), 'base64').toString('utf8');
    if (/^[\x20-\x7E]+$/.test(decoded)) return decoded;
  } catch {}
  return stored;
}

export async function encryptCredential(value: string, keyJwk: JsonWebKey | null): Promise<string> {
  if (!keyJwk) throw new Error('Clé de chiffrement VA Manager indisponible');
  const iv = randomBytes(12);
  const key = await webcrypto.subtle.importKey(
    'jwk',
    keyJwk,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );
  const encrypted = await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    Buffer.from(value, 'utf8')
  );
  return `vmp1:${Buffer.concat([iv, Buffer.from(encrypted)]).toString('base64')}`;
}

export type VaManagerMissingInformationRecord = {
  username: string;
  password?: string;
  twoFa?: string;
  email?: string;
  emailPassword?: string;
};

export async function auditVaManagerCredentialPlacement(
  store: StoreLike,
  organizationId: string
): Promise<Array<{
  username: string;
  xPasswordLooksLikeEmail: boolean;
  xPasswordMissing: boolean;
  emailPasswordLooksLikeEmail: boolean;
}>> {
  const session = await ensureSession(store);
  const key = await getOrganizationPasswordKey(session, organizationId);
  if (!key) throw new Error('Clé de chiffrement VA Manager indisponible');
  const [accountsPayload, gmailPayload] = await Promise.all([
    callVaManagerApi(session, '/api/db', {
      table: 'twitter_accounts',
      action: 'select',
      filters: [['organization_id', 'eq', organizationId]],
      options: {
        columns: 'id,username,encrypted_password,gmail_id,organization_id',
        limit: 5000,
      },
    }),
    callVaManagerApi(session, '/api/db', {
      table: 'gmail_accounts',
      action: 'select',
      filters: [['organization_id', 'eq', organizationId]],
      options: {
        columns: 'id,email,encrypted_password,organization_id',
        limit: 5000,
      },
    }),
  ]);
  const gmailById = new Map(
    (Array.isArray(gmailPayload?.data) ? gmailPayload.data : [])
      .filter((gmail: any) => gmail?.id)
      .map((gmail: any) => [String(gmail.id), gmail])
  );
  const looksLikeEmail = (value: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim());
  const findings = [];
  for (const account of Array.isArray(accountsPayload?.data) ? accountsPayload.data : []) {
    const username = normalizeXUsername(account?.username);
    if (!username) continue;
    const xPassword = account.encrypted_password
      ? await decryptCredential(account.encrypted_password, key).catch(() => '')
      : '';
    const gmail: any = account.gmail_id ? gmailById.get(String(account.gmail_id)) : null;
    const emailPassword = gmail?.encrypted_password
      ? await decryptCredential(gmail.encrypted_password, key).catch(() => '')
      : '';
    const finding = {
      username,
      xPasswordLooksLikeEmail: looksLikeEmail(xPassword),
      xPasswordMissing: !xPassword,
      emailPasswordLooksLikeEmail: looksLikeEmail(emailPassword),
    };
    if (
      finding.xPasswordLooksLikeEmail ||
      finding.xPasswordMissing ||
      finding.emailPasswordLooksLikeEmail
    ) {
      findings.push(finding);
    }
  }
  return findings;
}

export async function fillMissingVaManagerAccountInformation(
  store: StoreLike,
  organizationId: string,
  records: VaManagerMissingInformationRecord[]
): Promise<{
  matched: number;
  updatedAccounts: number;
  addedTwoFa: number;
  addedPasswords: number;
  repairedMisplacedPasswords: number;
  linkedEmails: number;
  addedEmailPasswords: number;
  skipped: number;
}> {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(organizationId)) {
    throw new Error('Identifiant d’organisation VA Manager invalide');
  }
  const session = await ensureSession(store);
  const key = await getOrganizationPasswordKey(session, organizationId);
  if (!key) throw new Error('Clé de chiffrement VA Manager indisponible');

  const [accountsPayload, gmailPayload] = await Promise.all([
    callVaManagerApi(session, '/api/db', {
      table: 'twitter_accounts',
      action: 'select',
      filters: [['organization_id', 'eq', organizationId]],
      options: {
        columns: 'id,username,encrypted_password,notes,gmail_id,organization_id',
        limit: 5000,
      },
    }),
    callVaManagerApi(session, '/api/db', {
      table: 'gmail_accounts',
      action: 'select',
      filters: [['organization_id', 'eq', organizationId]],
      options: {
        columns: 'id,email,encrypted_password,organization_id',
        limit: 5000,
      },
    }),
  ]);

  const accounts = Array.isArray(accountsPayload?.data) ? accountsPayload.data : [];
  const gmailAccounts = Array.isArray(gmailPayload?.data) ? gmailPayload.data : [];
  const accountsByUsername = new Map(
    accounts
      .filter((account: any) => account?.id && normalizeXUsername(account.username))
      .map((account: any) => [normalizeXUsername(account.username), account])
  );
  const gmailById = new Map(
    gmailAccounts
      .filter((gmail: any) => gmail?.id)
      .map((gmail: any) => [String(gmail.id), gmail])
  );
  const gmailByEmail = new Map(
    gmailAccounts
      .filter((gmail: any) => gmail?.id && gmail?.email)
      .map((gmail: any) => [String(gmail.email).trim().toLowerCase(), gmail])
  );

  let matched = 0;
  let updatedAccounts = 0;
  let addedTwoFa = 0;
  let addedPasswords = 0;
  let repairedMisplacedPasswords = 0;
  let linkedEmails = 0;
  let addedEmailPasswords = 0;
  let skipped = 0;

  for (const source of records) {
    const username = normalizeXUsername(source.username);
    const account: any = accountsByUsername.get(username);
    if (!account) {
      skipped++;
      continue;
    }
    matched++;
    const accountUpdate: Record<string, unknown> = {};
    const password = String(source.password || '');
    const twoFa = String(source.twoFa || '').replace(/[\s-]/g, '').toUpperCase();
    const email = String(source.email || '').trim().toLowerCase();
    const emailPassword = String(source.emailPassword || '');

    const currentXPassword = account.encrypted_password
      ? await decryptCredential(account.encrypted_password, key).catch(() => '')
      : '';
    const currentXPasswordIsEmail =
      /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(currentXPassword.trim());
    if ((!account.encrypted_password || currentXPasswordIsEmail) && password) {
      accountUpdate.encrypted_password = await encryptCredential(password, key);
      if (currentXPasswordIsEmail) repairedMisplacedPasswords++;
      else addedPasswords++;
    }
    const currentNotes = String(account.notes || '');
    if (!/\[2FA:[^\]]+\]/i.test(currentNotes) && /^[A-Z2-7]{16,}$/.test(twoFa)) {
      accountUpdate.notes = `${currentNotes}${currentNotes.trim() ? ' ' : ''}[2FA:${twoFa}]`;
      addedTwoFa++;
    }

    let gmail: any = account.gmail_id
      ? gmailById.get(String(account.gmail_id))
      : null;
    if (!gmail && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      gmail = gmailByEmail.get(email);
      if (!gmail) {
        const insertPayload = await callVaManagerApi(session, '/api/db', {
          table: 'gmail_accounts',
          action: 'insert',
          data: {
            email,
            encrypted_password: emailPassword
              ? await encryptCredential(emailPassword, key)
              : null,
            organization_id: organizationId,
          },
        });
        gmail = Array.isArray(insertPayload?.data) ? insertPayload.data[0] : null;
        if (!gmail?.id) throw new Error(`Création de l’email impossible pour @${username}`);
        gmailById.set(String(gmail.id), gmail);
        gmailByEmail.set(email, gmail);
        if (emailPassword) addedEmailPasswords++;
      }
      accountUpdate.gmail_id = gmail.id;
      linkedEmails++;
    } else if (gmail && !gmail.encrypted_password && emailPassword) {
      const gmailId = String(gmail.id);
      await callVaManagerApi(session, '/api/db', {
        table: 'gmail_accounts',
        action: 'update',
        filters: [
          ['organization_id', 'eq', organizationId],
          ['id', 'eq', gmailId],
        ],
        data: {
          encrypted_password: await encryptCredential(emailPassword, key),
        },
      });
      gmail.encrypted_password = true;
      addedEmailPasswords++;
    }

    if (Object.keys(accountUpdate).length > 0) {
      const updatePayload = await callVaManagerApi(session, '/api/db', {
        table: 'twitter_accounts',
        action: 'update',
        filters: [
          ['organization_id', 'eq', organizationId],
          ['id', 'eq', account.id],
        ],
        data: accountUpdate,
      });
      const updated = Array.isArray(updatePayload?.data) ? updatePayload.data : [];
      if (!updated.some((row: any) => String(row?.id) === String(account.id))) {
        throw new Error(`VA Manager n’a pas confirmé la mise à jour de @${username}`);
      }
      Object.assign(account, accountUpdate);
      updatedAccounts++;
    }
  }

  return {
    matched,
    updatedAccounts,
    addedTwoFa,
    addedPasswords,
    repairedMisplacedPasswords,
    linkedEmails,
    addedEmailPasswords,
    skipped,
  };
}

function normalizeXCookies(cookies: unknown[]): Record<string, unknown>[] {
  const allowedFields = [
    'name',
    'value',
    'domain',
    'path',
    'secure',
    'httpOnly',
    'sameSite',
    'expirationDate',
    'session',
  ];
  return cookies
    .filter(cookie => {
      const domain = String((cookie as any)?.domain || '').toLowerCase().replace(/^\./, '');
      return domain === 'x.com' || domain.endsWith('.x.com') ||
        domain === 'twitter.com' || domain.endsWith('.twitter.com');
    })
    .map(cookie => Object.fromEntries(
      allowedFields
        .filter(field => (cookie as any)?.[field] !== undefined)
        .map(field => [field, (cookie as any)[field]])
    ))
    .sort((a, b) =>
      `${a.domain || ''}\0${a.path || ''}\0${a.name || ''}`.localeCompare(
        `${b.domain || ''}\0${b.path || ''}\0${b.name || ''}`
      )
    );
}

async function findVaManagerAccount(
  session: StoredSession,
  accountId: string,
  organizationId?: string
): Promise<{ id: string; organizationId: string; notes: string } | null> {
  const organizationIds = organizationId
    ? [organizationId]
    : (await listVaManagerOrganizationsFromSession(session)).map(organization => organization.id);

  for (const candidateOrganizationId of organizationIds) {
    const payload = await callVaManagerApi(session, '/api/db', {
      table: 'twitter_accounts',
      action: 'select',
      filters: [
        ['organization_id', 'eq', candidateOrganizationId],
        ['id', 'eq', accountId],
      ],
      options: {
        columns: 'id,organization_id,notes',
        limit: 1,
      },
    });
    const account = Array.isArray(payload?.data) ? payload.data[0] : null;
    if (
      account &&
      String(account.id) === accountId &&
      String(account.organization_id) === candidateOrganizationId
    ) {
      return {
        id: accountId,
        organizationId: candidateOrganizationId,
        notes: String(account.notes || ''),
      };
    }
  }
  return null;
}

async function listVaManagerOrganizationsFromSession(
  session: StoredSession
): Promise<VaManagerOrganization[]> {
  try {
    const payload = await callVaManagerApi(session, '/api/admin-users', { op: 'list-orgs' });
    const organizations = Array.isArray(payload?.organizations) ? payload.organizations : [];
    return organizations
      .filter((organization: any) => organization?.id)
      .map((organization: any) => ({
        id: String(organization.id),
        name: String(organization.name || organization.id),
      }));
  } catch {
    if (!session.primaryOrganizationId) return [];
    return [{ id: session.primaryOrganizationId, name: session.email }];
  }
}

export async function connectVaManager(
  store: StoreLike,
  email: string,
  password: string
): Promise<VaManagerConnectionStatus> {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || !password) throw new Error('Email et mot de passe requis');

  const auth = await requestSupabaseSession({ email: cleanEmail, password }, 'password');
  const session: StoredSession = {
    accessToken: auth.access_token,
    refreshToken: auth.refresh_token,
    expiresAt: Date.now() + Number(auth.expires_in || 3600) * 1000,
    email: auth.user?.email || cleanEmail,
    userId: auth.user?.id,
    role: auth.user?.user_metadata?.role,
    primaryOrganizationId: auth.user?.user_metadata?.organization_id,
  };
  saveEncryptedSession(store, session);
  return {
    connected: true,
    email: session.email,
    primaryOrganizationId: session.primaryOrganizationId,
  };
}

export function disconnectVaManager(store: StoreLike): void {
  store.delete(SESSION_STORE_KEY);
}

export function getVaManagerConnectionStatus(store: StoreLike): VaManagerConnectionStatus {
  const session = parseEncryptedSession(store);
  return session
    ? {
        connected: true,
        email: session.email,
        primaryOrganizationId: session.primaryOrganizationId,
      }
    : { connected: false };
}

export async function listVaManagerOrganizations(
  store: StoreLike
): Promise<VaManagerOrganization[]> {
  const session = await ensureSession(store);
  const organizations = await listVaManagerOrganizationsFromSession(session);
  if (organizations.length === 0) throw new Error('Aucune organisation VA Manager accessible');
  return organizations;
}

export async function listVaManagerAccounts(
  store: StoreLike,
  organizationId?: string
): Promise<VaManagerAccount[]> {
  const session = await ensureSession(store);
  const filters = organizationId
    ? [['organization_id', 'eq', organizationId]]
    : [];

  const [accountPayload, statsPayload, gmailPayload, organizationKey] = await Promise.all([
    callVaManagerApi(session, '/api/db', {
      table: 'twitter_accounts',
      action: 'select',
      filters,
      options: {
        columns:
          'id,username,status,organization_id,encrypted_password,notes,gmail_id,created_at,last_scanned_at,last_scan_error',
        order: 'created_at.desc',
        limit: 5000,
      },
    }),
    callVaManagerApi(session, '/api/db', {
      table: 'twitter_stats',
      action: 'select',
      filters,
      options: {
        columns: 'twitter_account_id,username,followers,date,organization_id',
        order: 'date.desc',
        limit: 5000,
      },
    }),
    callVaManagerApi(session, '/api/db', {
      table: 'gmail_accounts',
      action: 'select',
      filters,
      options: {
        columns: 'id,email,encrypted_password,organization_id',
        limit: 5000,
      },
    }),
    getOrganizationPasswordKey(session, organizationId),
  ]);

  const gmailById = new Map(
    (Array.isArray(gmailPayload?.data) ? gmailPayload.data : [])
      .filter((gmail: any) => gmail?.id)
      .map((gmail: any) => [String(gmail.id), gmail])
  );
  const latestStats = new Map<string, any>();
  for (const stat of Array.isArray(statsPayload?.data) ? statsPayload.data : []) {
    const keys = [
      stat?.twitter_account_id ? `id:${stat.twitter_account_id}` : '',
      normalizeXUsername(stat?.username) ? `username:${normalizeXUsername(stat.username)}` : '',
    ].filter(Boolean);
    for (const key of keys) {
      if (!latestStats.has(key)) latestStats.set(key, stat);
    }
  }

  const accounts = (Array.isArray(accountPayload?.data) ? accountPayload.data : [])
    .filter((account: any) => account?.id && normalizeXUsername(account?.username))
    .map(async (account: any) => {
      const username = normalizeXUsername(account.username);
      const stat =
        latestStats.get(`id:${account.id}`) ||
        latestStats.get(`username:${username}`);
      const notes = String(account.notes || '');
      const gmail: any = account.gmail_id ? gmailById.get(String(account.gmail_id)) : null;
      const noteEmail = notes.match(/\[EMAIL:([^\]]+)\]/i)?.[1]?.trim() || '';
      const noteEmailPassword = notes.match(/\[EMAIL_PASS:([^\]]+)\]/i)?.[1] || '';
      const passwordUsable = await canDecryptCredential(
        account.encrypted_password,
        organizationKey
      );
      const emailPasswordUsable = gmail?.encrypted_password
        ? await canDecryptCredential(gmail.encrypted_password, organizationKey)
        : Boolean(noteEmailPassword);
      return {
        id: String(account.id),
        organizationId: account.organization_id || undefined,
        username,
        status: normalizeVaManagerStatus(account.status),
        followers: Number.isFinite(Number(stat?.followers)) ? Number(stat.followers) : null,
        followersUpdatedAt: stat?.date || undefined,
        lastScannedAt: account.last_scanned_at || undefined,
        lastScanError: account.last_scan_error || undefined,
        hasPassword: Boolean(account.encrypted_password),
        passwordUsable,
        hasTwoFa: /\[2FA:[^\]]+\]/i.test(notes),
        hasAuthToken: /\[TOKEN:[^\]]+\]/i.test(notes),
        hasCookies: /\[SPECTRA_COOKIES:v1:[a-f0-9]{64}:[A-Za-z0-9+/=]+\]/i.test(notes),
        hasEmail: Boolean(gmail?.email || noteEmail),
        hasEmailPassword: Boolean(gmail?.encrypted_password || noteEmailPassword),
        emailPasswordUsable,
      } satisfies VaManagerAccount;
    });
  return Promise.all(accounts);
}

export async function syncAuthenticatedXCookiesToVaManager(
  store: StoreLike,
  accountId: string,
  cookies: unknown[],
  organizationId?: string
): Promise<{ synced: boolean; unchanged: boolean; organizationId: string; cookieCount: number }> {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(accountId)) {
    throw new Error('Identifiant de compte VA Manager invalide');
  }
  if (organizationId && !/^[A-Za-z0-9_-]{1,160}$/.test(organizationId)) {
    throw new Error('Identifiant d’organisation VA Manager invalide');
  }

  const xCookies = normalizeXCookies(cookies);
  if (!xCookies.some(cookie => cookie.name === 'auth_token') ||
      !xCookies.some(cookie => cookie.name === 'ct0')) {
    throw new Error('Session X incomplète : auth_token ou ct0 absent');
  }

  const session = await ensureSession(store);
  const account = await findVaManagerAccount(session, accountId, organizationId);
  if (!account) throw new Error('Compte lié introuvable dans VA Manager');

  const serialized = JSON.stringify({
    version: 1,
    source: 'spectra',
    capturedAt: new Date().toISOString(),
    cookies: xCookies,
  });
  const cookieHash = createHash('sha256').update(JSON.stringify(xCookies)).digest('hex');
  const existingMarker = Array.from(account.notes.matchAll(SPECTRA_COOKIES_MARKER))[0];
  SPECTRA_COOKIES_MARKER.lastIndex = 0;
  if (existingMarker?.[1] === cookieHash) {
    return {
      synced: true,
      unchanged: true,
      organizationId: account.organizationId,
      cookieCount: xCookies.length,
    };
  }

  const key = await getOrganizationPasswordKey(session, account.organizationId);
  const encrypted = await encryptCredential(serialized, key);
  const cleanNotes = account.notes.replace(SPECTRA_COOKIES_MARKER, '').trim();
  SPECTRA_COOKIES_MARKER.lastIndex = 0;
  const marker = `[SPECTRA_COOKIES:v1:${cookieHash}:${encrypted.slice('vmp1:'.length)}]`;
  const notes = cleanNotes ? `${cleanNotes} ${marker}` : marker;
  const payload = await callVaManagerApi(session, '/api/db', {
    table: 'twitter_accounts',
    action: 'update',
    filters: [
      ['organization_id', 'eq', account.organizationId],
      ['id', 'eq', account.id],
    ],
    data: { notes },
  });
  const updated = Array.isArray(payload?.data) ? payload.data : [];
  if (!updated.some((row: any) => String(row?.id) === account.id)) {
    throw new Error('VA Manager n’a pas confirmé la mise à jour des cookies');
  }
  return {
    synced: true,
    unchanged: false,
    organizationId: account.organizationId,
    cookieCount: xCookies.length,
  };
}

export async function getVaManagerSessionImportCredentials(
  store: StoreLike,
  organizationId: string,
  accountId: string
): Promise<{ username: string; password: string; totpSecret: string }> {
  const session = await ensureSession(store);
  const payload = await callVaManagerApi(session, '/api/db', {
    table: 'twitter_accounts',
    action: 'select',
    filters: [
      ['organization_id', 'eq', organizationId],
      ['id', 'eq', accountId],
    ],
    options: {
      columns: 'id,username,encrypted_password,notes,organization_id',
      limit: 1,
    },
  });
  const account = Array.isArray(payload?.data) ? payload.data[0] : null;
  if (!account || String(account.id) !== accountId) {
    throw new Error('Compte VA Manager introuvable dans cette organisation');
  }

  const key = await getOrganizationPasswordKey(session, organizationId);
  const password = await decryptCredential(account.encrypted_password, key);
  const totpSecret = String(account.notes || '').match(/\[2FA:([^\]]+)\]/i)?.[1]
    ?.replace(/[\s-]/g, '')
    .toUpperCase() || '';
  const username = normalizeXUsername(account.username);
  if (!username || !password || !totpSecret) {
    throw new Error('Informations de connexion VA Manager incomplètes');
  }
  return { username, password, totpSecret };
}
