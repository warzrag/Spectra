export interface CookieData {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export function parseJsonCookies(data: string): CookieData[] {
  const parsed = JSON.parse(data);
  if (!Array.isArray(parsed)) {
    throw new Error('Expected an array of cookies');
  }
  return parsed.map((c: any) => ({
    name: c.name || '',
    value: c.value || '',
    domain: c.domain || '',
    path: c.path || '/',
    expires: c.expires || c.expirationDate || undefined,
    httpOnly: c.httpOnly || false,
    secure: c.secure || false,
    sameSite: c.sameSite || 'Lax',
  }));
}

export function parseNetscapeCookies(data: string): CookieData[] {
  const cookies: CookieData[] = [];
  const lines = data.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const parts = trimmed.split('\t');
    if (parts.length < 7) continue;

    cookies.push({
      domain: parts[0],
      path: parts[2],
      secure: parts[3].toUpperCase() === 'TRUE',
      expires: parseInt(parts[4]) || undefined,
      name: parts[5],
      value: parts[6],
      httpOnly: parts[0].startsWith('#HttpOnly_'),
    });
  }

  return cookies;
}

export function detectCookieFormat(data: string): 'json' | 'netscape' {
  const trimmed = data.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    return 'json';
  }
  return 'netscape';
}

export function cookiesToJson(cookies: CookieData[]): string {
  return JSON.stringify(cookies, null, 2);
}
