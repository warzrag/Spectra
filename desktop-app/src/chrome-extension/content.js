// Content script to track URL changes
(function() {
  // Get profile ID from the user data directory path if possible
  const profileId = new URLSearchParams(window.location.search).get('profileId') || 
                   localStorage.getItem('antidetect_profile_id') || 
                   'default';

  let lastUrl = window.location.href;

  // Save URL to local server
  function saveUrl(url) {
    // Don't save Chrome internal pages
    if (url.startsWith('chrome://') || url.startsWith('chrome-extension://')) {
      return;
    }

    fetch('http://localhost:45678/api/save-url', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        profileId: profileId,
        url: url
      })
    }).catch(() => {
      // Silently fail if server is not available
    });

    // Also save to local storage as backup
    localStorage.setItem('antidetect_last_url', url);
  }

  // Save current URL immediately
  saveUrl(lastUrl);

  // Check for URL changes periodically
  setInterval(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      saveUrl(lastUrl);
    }
  }, 1000);

  // Save before unload
  window.addEventListener('beforeunload', () => {
    saveUrl(window.location.href);
  });
})();