export function normalizeTweetUrl(value: string | null | undefined): string | null {
  const rawValue = typeof value === 'string' ? value.trim() : '';
  if (!rawValue) return null;

  try {
    const parsed = new URL(rawValue);
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (parsed.protocol !== 'https:' || (hostname !== 'x.com' && hostname !== 'twitter.com')) {
      return null;
    }

    const match = parsed.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)\/?$/);
    if (!match) return null;

    return `https://x.com/${match[1]}/status/${match[2]}`;
  } catch {
    return null;
  }
}
