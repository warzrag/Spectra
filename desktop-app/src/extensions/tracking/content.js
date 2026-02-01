// Inject script to run in page context
const script = document.createElement('script');
script.textContent = `
// Remove webdriver property
Object.defineProperty(navigator, 'webdriver', {
  get: () => undefined
});

// Fix navigator.languages
Object.defineProperty(navigator, 'languages', {
  get: () => ['fr-FR', 'fr', 'en-US', 'en']
});

// Fix navigator.language
Object.defineProperty(navigator, 'language', {
  get: () => 'fr-FR'
});

// Fix navigator.platform
Object.defineProperty(navigator, 'platform', {
  get: () => 'Win32'
});

// Fix navigator.hardwareConcurrency
Object.defineProperty(navigator, 'hardwareConcurrency', {
  get: () => 8
});

// Remove Chrome automation properties
if (window.chrome) {
  window.chrome.app = undefined;
  window.chrome.csi = undefined;
  window.chrome.loadTimes = undefined;
  if (window.chrome.runtime) {
    window.chrome.runtime.sendMessage = undefined;
    window.chrome.runtime.connect = undefined;
  }
}

// Override plugins to look more natural
Object.defineProperty(navigator, 'plugins', {
  get: () => {
    const pluginData = [
      {
        name: 'Chrome PDF Plugin',
        description: 'Portable Document Format',
        filename: 'internal-pdf-viewer'
      },
      {
        name: 'Chrome PDF Viewer',
        description: '',
        filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai'
      },
      {
        name: 'Native Client',
        description: '',
        filename: 'internal-nacl-plugin'
      }
    ];
    
    const plugins = pluginData.map(p => ({
      name: p.name,
      description: p.description,
      filename: p.filename,
      length: 1,
      item: (i) => null,
      namedItem: (name) => null
    }));
    
    plugins.length = pluginData.length;
    return plugins;
  }
});

// Fix permissions API
if (navigator.permissions) {
  const originalQuery = navigator.permissions.query;
  navigator.permissions.query = (parameters) => {
    return Promise.reject(new DOMException('User denied permission'));
  };
}

// Override CDP detection
if (window.chrome && window.chrome.runtime) {
  const runtime = window.chrome.runtime;
  runtime.connect = undefined;
  runtime.sendMessage = undefined;
}

// Fix Cloudflare detection
const originalFetch = window.fetch;
window.fetch = function(...args) {
  const url = args[0];
  if (typeof url === 'string' && (url.includes('beacon.js') || url.includes('cloudflare'))) {
    // Skip Cloudflare beacon requests that might detect automation
    return Promise.reject(new Error('Blocked'));
  }
  return originalFetch.apply(this, args);
};

// Remove automation indicators
delete window.__webdriver_script_fn;
delete window.__driver_evaluate;
delete window.__webdriver_evaluate;
delete window.__selenium_evaluate;
delete window.__fxdriver_evaluate;
delete window.__driver_unwrapped;
delete window.__webdriver_unwrapped;
delete window.__selenium_unwrapped;
delete window.__fxdriver_unwrapped;
delete window.__webdriver_script_func;
delete window.__webdriver_script_fn;
delete window.webdriver;
delete window._phantom;
delete window.phantom;
delete window.callPhantom;
delete window._selenium;
delete window.callSelenium;
delete window.__nightmare;

// Override toString methods to hide modifications
const originalToString = Function.prototype.toString;
Function.prototype.toString = function() {
  if (this === navigator.permissions.query) {
    return 'function query() { [native code] }';
  }
  return originalToString.call(this);
};

`;
(document.head || document.documentElement).appendChild(script);
script.remove();

// Track page visits only if runtime exists
if (window.chrome && window.chrome.runtime && window.chrome.runtime.sendMessage) {
  try {
    chrome.runtime.sendMessage({
      type: 'PAGE_VISIT',
      url: window.location.href,
      timestamp: Date.now()
    });
  } catch (e) {
    // Ignore errors
  }
}

// Listen for URL changes
let lastUrl = window.location.href;
const urlObserver = new MutationObserver(() => {
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href;
    chrome.runtime.sendMessage({
      type: 'URL_CHANGE',
      url: lastUrl,
      timestamp: Date.now()
    });
  }
});

urlObserver.observe(document, { subtree: true, childList: true });