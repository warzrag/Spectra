import { safeStorage } from 'electron';
import { webcrypto } from 'crypto';
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
    if (!session.primaryOrganizationId) throw new Error('Aucune organisation VA Manager accessible');
    return [{
      id: session.primaryOrganizationId,
      name: session.email,
    }];
  }
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
        hasEmail: Boolean(gmail?.email || noteEmail),
        hasEmailPassword: Boolean(gmail?.encrypted_password || noteEmailPassword),
        emailPasswordUsable,
      } satisfies VaManagerAccount;
    });
  return Promise.all(accounts);
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
