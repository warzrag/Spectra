// Background service worker — imports cookies from cookies.json at startup
// This file is written by the launcher before Chrome starts.
// Using chrome.cookies API instead of CDP = no detectable debug connection.

async function importCookies() {
  try {
    const response = await fetch(chrome.runtime.getURL('cookies.json'));
    if (!response.ok) return; // No cookies file = nothing to import
    const cookies = await response.json();
    if (!Array.isArray(cookies) || cookies.length === 0) return;

    let imported = 0;
    for (const c of cookies) {
      try {
        const cookieDetails = {
          url: `http${c.secure ? 's' : ''}://${c.domain.replace(/^\./, '')}${c.path || '/'}`,
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          secure: c.secure || false,
          httpOnly: c.httpOnly || false,
          sameSite: c.sameSite === 'None' ? 'no_restriction' : (c.sameSite || 'lax').toLowerCase(),
        };
        // Set expiration (skip session cookies with no expiry)
        if (c.expires && c.expires > 0) {
          cookieDetails.expirationDate = c.expires;
        } else if (c.expirationDate && c.expirationDate > 0) {
          cookieDetails.expirationDate = c.expirationDate;
        }
        await chrome.cookies.set(cookieDetails);
        imported++;
      } catch (e) {
        // Skip individual cookie errors
      }
    }
    console.log(`[Stealth] Imported ${imported}/${cookies.length} cookies via chrome.cookies API`);
  } catch (e) {
    // No cookies.json or parse error — that's fine
  }
}

// Run on extension load
importCookies();
