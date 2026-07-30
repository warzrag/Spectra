export type ProxyIdentityInput = {
  type?: string;
  host?: string;
  port?: string | number;
  username?: string;
};

export function proxyIdentityKey(proxy: ProxyIdentityInput): string {
  return [
    String(proxy.type || 'http').trim().toLowerCase(),
    String(proxy.host || '').trim().toLowerCase(),
    String(proxy.port || '').trim(),
    String(proxy.username || '').trim().toLowerCase(),
  ].join('|');
}

export async function proxyDocumentId(
  teamId: string,
  proxy: ProxyIdentityInput
): Promise<string> {
  const source = `${String(teamId || '').trim()}|${proxyIdentityKey(proxy)}`;
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(source)
  );
  const hex = Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
  return `proxy_${hex}`;
}
