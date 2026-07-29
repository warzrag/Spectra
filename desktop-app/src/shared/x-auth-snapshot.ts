export function hasAuthenticatedXSession(
  cookies: any[],
  nowSeconds = Date.now() / 1000
): boolean {
  if (!Array.isArray(cookies)) return false;
  const hasCookie = (name: string) => cookies.some(cookie => {
    const domain = String(cookie?.domain || '').replace(/^\./, '').toLowerCase();
    const expiration = Number(cookie?.expirationDate || cookie?.expires || 0);
    return cookie?.name === name &&
      (domain === 'x.com' || domain === 'twitter.com') &&
      typeof cookie?.value === 'string' &&
      cookie.value.length > 0 &&
      (expiration <= 0 || expiration > nowSeconds);
  });
  return hasCookie('auth_token') && hasCookie('ct0');
}
