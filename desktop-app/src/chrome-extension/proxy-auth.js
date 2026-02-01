// Proxy authentication handler
// This script handles HTTP authentication for proxies

// Store proxy credentials
let proxyAuth = null;

// Load proxy configuration from storage or config file
chrome.runtime.onInstalled.addListener(() => {
  // Try to load proxy auth from local storage
  chrome.storage.local.get(['proxyAuth'], (result) => {
    if (result.proxyAuth) {
      proxyAuth = result.proxyAuth;
      console.log('Proxy auth loaded:', proxyAuth ? 'Configured' : 'Not configured');
    }
  });
});

// Handle authentication requests
chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    console.log('Auth required for:', details.url);
    console.log('Challenger:', details.challenger);
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
      console.log('No proxy auth available or not a proxy request');
      callback({});
    }
  },
  { urls: ['<all_urls>'] },
  ['asyncBlocking']
);

// Message handler to update proxy credentials
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SET_PROXY_AUTH') {
    proxyAuth = message.auth;
    // Save to storage
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

// Handle proxy errors
chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (details.error === 'net::ERR_PROXY_AUTH_FAILED' || 
        details.error === 'net::ERR_PROXY_CONNECTION_FAILED') {
      console.error('Proxy error:', details.error, 'for URL:', details.url);
      
      // Send message to content script or popup about proxy failure
      chrome.runtime.sendMessage({
        type: 'PROXY_ERROR',
        error: details.error,
        url: details.url
      });
    }
  },
  { urls: ['<all_urls>'] }
);

// Also intercept and log successful proxy connections
chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.statusCode === 407) {
      console.error('Proxy authentication failed (407)');
      chrome.runtime.sendMessage({
        type: 'PROXY_ERROR',
        error: 'Proxy authentication failed',
        statusCode: 407
      });
    }
  },
  { urls: ['<all_urls>'] }
);

// Load proxy auth from config file if it exists
fetch(chrome.runtime.getURL('../antidetect-config.json'))
  .then(response => response.json())
  .then(config => {
    if (config.proxyAuth) {
      proxyAuth = config.proxyAuth;
      // Save to storage
      chrome.storage.local.set({ proxyAuth: proxyAuth });
      console.log('Proxy auth loaded from config');
    }
  })
  .catch(error => {
    console.log('No config file or error loading:', error);
  });