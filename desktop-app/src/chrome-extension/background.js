// Get profile ID from stored config or URL
let profileId = 'unknown';
let lastKnownUrl = null;
let proxyAuth = null;

// Try to get profile ID and proxy auth from storage
chrome.storage.local.get(['profileId', 'lastUrl', 'proxyAuth'], (result) => {
  if (result.profileId) {
    profileId = result.profileId;
  }
  if (result.lastUrl) {
    lastKnownUrl = result.lastUrl;
  }
  if (result.proxyAuth) {
    proxyAuth = result.proxyAuth;
  }
});

// Store the profile ID when we first detect it
chrome.runtime.onInstalled.addListener(() => {
  // Try to extract profile ID from the current tab URL if it contains it
  chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
    if (tabs[0]) {
      const url = new URL(tabs[0].url);
      const urlProfileId = url.searchParams.get('profileId');
      if (urlProfileId) {
        profileId = urlProfileId;
        chrome.storage.local.set({ profileId: urlProfileId });
      }
    }
  });
});

// On startup, restore the last URL if we have one
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get(['lastUrl', 'profileId'], (result) => {
    if (result.lastUrl && result.lastUrl !== 'https://www.google.com') {
      console.log('Restoring last URL on startup:', result.lastUrl);
      // Create a new tab with the last URL if no tabs exist
      chrome.tabs.query({}, (tabs) => {
        if (tabs.length === 0 || (tabs.length === 1 && tabs[0].url === 'chrome://newtab/')) {
          chrome.tabs.create({ url: result.lastUrl });
        }
      });
    }
  });
});

// Track active tab URL changes
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.active && tab.url) {
    saveUrl(tab.url);
  }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (tab.url) {
      saveUrl(tab.url);
    }
  });
});

// Save current URL periodically (every 30 seconds)
setInterval(() => {
  chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
    if (tabs[0] && tabs[0].url) {
      saveUrl(tabs[0].url);
    }
  });
}, 30000);

// Save URL when window/tab closes
chrome.windows.onRemoved.addListener((windowId) => {
  // Save the last known URL
  if (lastKnownUrl) {
    chrome.storage.local.set({ lastUrl: lastKnownUrl, profileId: profileId });
  }
});

// Save URL to local server
function saveUrl(url) {
  if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) {
    return;
  }
  
  // Save to Chrome storage for persistence
  chrome.storage.local.set({ lastUrl: url, profileId: profileId }, () => {
    console.log('URL saved:', url);
    lastKnownUrl = url;
  });
  
  // Try to send to local API (if available)
  fetch('http://localhost:45678/api/save-url', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      profileId: profileId,
      url: url
    })
  }).then(() => {
    console.log('URL sent to server');
  }).catch(() => {
    // Silently fail if API is not available
    console.log('Failed to send URL to server, saved locally');
  });
}

// Proxy authentication handler
chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    console.log('Auth required for:', details.url);
    console.log('Is proxy:', details.isProxy);
    
    if (details.isProxy && proxyAuth) {
      console.log('Providing proxy authentication');
      callback({
        authCredentials: {
          username: proxyAuth.username,
          password: proxyAuth.password
        }
      });
    } else {
      callback({});
    }
  },
  { urls: ['<all_urls>'] },
  ['asyncBlocking']
);

// Handle proxy configuration messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SET_PROXY_AUTH') {
    proxyAuth = message.auth;
    chrome.storage.local.set({ proxyAuth: proxyAuth }, () => {
      console.log('Proxy auth updated');
      sendResponse({ success: true });
    });
    return true;
  } else if (message.type === 'GET_PROXY_AUTH') {
    sendResponse({ auth: proxyAuth });
  } else if (message.type === 'CLEAR_PROXY_AUTH') {
    proxyAuth = null;
    chrome.storage.local.remove('proxyAuth', () => {
      console.log('Proxy auth cleared');
      sendResponse({ success: true });
    });
    return true;
  }
});

// Load proxy auth from profile config if it exists
fetch(chrome.runtime.getURL('antidetect-config.json'))
  .then(response => response.json())
  .then(config => {
    if (config.proxyAuth) {
      proxyAuth = config.proxyAuth;
      chrome.storage.local.set({ proxyAuth: proxyAuth });
      console.log('Proxy auth loaded from config');
    }
  })
  .catch(error => {
    console.log('No config file or error loading:', error);
  });