export interface SessionImportAccount {
  username: string;
  password: string;
  totpSecret: string;
}

export type SessionImportStatus =
  | 'idle'
  | 'validating'
  | 'creating'
  | 'testing-proxy'
  | 'launching'
  | 'entering-username'
  | 'entering-password'
  | 'entering-totp'
  | 'waiting'
  | 'success'
  | 'manual'
  | 'failed'
  | 'stopped';

export interface SessionImportProgress {
  running: boolean;
  total: number;
  current: number;
  username?: string;
  profileId?: string;
  status: SessionImportStatus;
  message: string;
}

const MAX_FIELD_LENGTH = 512;
const USERNAME_PATTERN = /^@?[A-Za-z0-9_.-]{1,64}$/;
const TOTP_PATTERN = /^[A-Z2-7]+=*$/;

function validateAccount(value: unknown, lineNumber: number): SessionImportAccount {
  if (!value || typeof value !== 'object') {
    throw new Error(`Ligne ${lineNumber} : compte invalide`);
  }
  const input = value as Record<string, unknown>;
  const username = String(input.username ?? '').trim().replace(/^@/, '');
  const password = String(input.password ?? '');
  const totpSecret = String(input.totp_secret ?? input.totpSecret ?? '')
    .replace(/[\s-]/g, '')
    .toUpperCase();

  if (!USERNAME_PATTERN.test(username)) {
    throw new Error(`Ligne ${lineNumber} : identifiant X invalide`);
  }
  if (!password || password.length > MAX_FIELD_LENGTH) {
    throw new Error(`Ligne ${lineNumber} : mot de passe manquant ou trop long`);
  }
  if (!totpSecret || totpSecret.length > 128 || !TOTP_PATTERN.test(totpSecret)) {
    throw new Error(`Ligne ${lineNumber} : secret TOTP Base32 invalide`);
  }
  return { username, password, totpSecret };
}

export function parseSessionImportFile(content: string): SessionImportAccount[] {
  if (typeof content !== 'string' || content.length > 5 * 1024 * 1024) {
    throw new Error('Le fichier de sessions est trop volumineux');
  }
  const trimmed = content.trim();
  if (!trimmed) throw new Error('Le fichier de sessions est vide');

  let rawAccounts: unknown[];
  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('JSON invalide');
    }
    if (!Array.isArray(parsed)) throw new Error('Le JSON doit contenir une liste de comptes');
    rawAccounts = parsed;
  } else {
    rawAccounts = trimmed.split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
      const value = line.trim();
      if (value.startsWith('{')) {
        try {
          return JSON.parse(value);
        } catch {
          throw new Error(`Ligne ${index + 1} : JSON invalide`);
        }
      }
      const parts = value.split('|');
      if (parts.length !== 3) {
        throw new Error(`Ligne ${index + 1} : format attendu username|password|totp_secret`);
      }
      return { username: parts[0], password: parts[1], totp_secret: parts[2] };
    });
  }

  if (rawAccounts.length === 0) throw new Error('Aucun compte détecté');
  if (rawAccounts.length > 500) throw new Error('Un import est limité à 500 comptes');

  const accounts = rawAccounts.map((account, index) => validateAccount(account, index + 1));
  const seen = new Set<string>();
  for (const account of accounts) {
    const key = account.username.toLowerCase();
    if (seen.has(key)) throw new Error(`Identifiant X dupliqué : ${account.username}`);
    seen.add(key);
  }
  return accounts;
}
