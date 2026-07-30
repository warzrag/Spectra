import { Profile, VaManagerAccount } from '../types';

export function normalizeXUsername(value: string | null | undefined): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//, '')
    .replace(/^x\s*[—–-]\s*/, '')
    .replace(/^twitter\s*[—–-]\s*/, '')
    .replace(/^@/, '')
    .split(/[/?#\s]/)[0]
    .replace(/[^a-z0-9_]/g, '');
}

export function findLinkedProfile(
  account: Pick<VaManagerAccount, 'id' | 'username'>,
  profiles: Profile[]
): Profile | undefined {
  const direct = profiles.find(profile => profile.vaManagerAccountId === account.id);
  if (direct) return direct;

  const username = normalizeXUsername(account.username);
  if (!username) return undefined;
  return profiles.find(
    profile =>
      !profile.vaManagerAccountId &&
      normalizeXUsername(profile.name) === username
  );
}

export function normalizeVaManagerStatus(value: unknown): VaManagerAccount['status'] {
  const status = String(value || 'active').trim().toLowerCase();
  if (status === 'shadowbanned' || status === 'shadow_ban') return 'shadowban';
  if (status === 'ban') return 'banned';
  return status || 'active';
}
