// This script tracks URL changes and saves them
(function() {
  const profileId = '%PROFILE_ID%';
  const apiEndpoint = 'http://localhost:45678/api/save-url';
  
  let currentUrl = window.location.href;
  
  // Function to save URL
  function saveUrl(url) {
    fetch(apiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        profileId: profileId,
        url: url
      })
    }).catch(err => {
      console.log('Failed to save URL:', err);
    });
  }
  
  // Save initial URL
  saveUrl(currentUrl);
  
  // Monitor URL changes using various methods
  
  // 1. Listen for popstate (back/forward navigation)
  window.addEventListener('popstate', function() {
    if (window.location.href !== currentUrl) {
      currentUrl = window.location.href;
      saveUrl(currentUrl);
    }
  });
  
  // 2. Override pushState and replaceState
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  
  history.pushState = function() {
    originalPushState.apply(history, arguments);
    if (window.location.href !== currentUrl) {
      currentUrl = window.location.href;
      saveUrl(currentUrl);
    }
  };
  
  history.replaceState = function() {
    originalReplaceState.apply(history, arguments);
    if (window.location.href !== currentUrl) {
      currentUrl = window.location.href;
      saveUrl(currentUrl);
    }
  };
  
  // 3. Periodic check for URL changes (fallback)
  setInterval(function() {
    if (window.location.href !== currentUrl) {
      currentUrl = window.location.href;
      saveUrl(currentUrl);
    }
  }, 1000);
  
  // 4. Save URL before page unload
  window.addEventListener('beforeunload', function() {
    saveUrl(currentUrl);
  });
})();