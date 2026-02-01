// Advanced stealth script (similar to commercial antidetect browsers)
(function() {
  'use strict';

  // 1. Remove webdriver property (most basic detection)
  if (navigator.webdriver) {
    delete navigator.__proto__.webdriver;
  }
  Object.defineProperty(navigator, 'webdriver', {
    get: () => false,
    configurable: true
  });

  // 2. Override permissions API to avoid detection
  const originalQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = (parameters) => (
    parameters.name === 'notifications' ?
      Promise.resolve({ state: Notification.permission }) :
      originalQuery(parameters)
  );

  // 3. Override plugins to appear more realistic
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      return [
        {
          0: {type: "application/x-google-chrome-pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: Plugin},
          description: "Portable Document Format",
          filename: "internal-pdf-viewer",
          length: 1,
          name: "Chrome PDF Plugin"
        },
        {
          0: {type: "application/pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: Plugin},
          description: "Portable Document Format", 
          filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai",
          length: 1,
          name: "Chrome PDF Viewer"
        },
        {
          0: {type: "application/x-nacl", suffixes: "", description: "Native Client Executable", enabledPlugin: Plugin},
          1: {type: "application/x-pnacl", suffixes: "", description: "Portable Native Client Executable", enabledPlugin: Plugin},
          description: "Native Client",
          filename: "internal-nacl-plugin", 
          length: 2,
          name: "Native Client"
        }
      ];
    },
    configurable: true
  });

  // 4. Override languages to match profile settings  
  Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en', 'fr'],
    configurable: true
  });

  // 5. Override chrome runtime for stealth
  if (window.chrome) {
    Object.defineProperty(window, 'chrome', {
      get: () => {
        return {
          runtime: {
            onConnect: undefined,
            onMessage: undefined
          },
          app: {
            isInstalled: false
          }
        };
      },
      configurable: true
    });
  }

  // 6. Prevent iframe detection
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    get: function() {
      return window;
    },
    configurable: true
  });

  // 7. Mock realistic screen properties
  const mockScreen = {
    availHeight: screen.height,
    availLeft: 0,
    availTop: 0, 
    availWidth: screen.width,
    colorDepth: 24,
    height: screen.height,
    orientation: {
      angle: 0,
      type: 'landscape-primary'
    },
    pixelDepth: 24,
    width: screen.width
  };

  Object.defineProperties(screen, {
    availHeight: {get: () => mockScreen.availHeight, configurable: true},
    availWidth: {get: () => mockScreen.availWidth, configurable: true},
    colorDepth: {get: () => mockScreen.colorDepth, configurable: true},
    height: {get: () => mockScreen.height, configurable: true},
    pixelDepth: {get: () => mockScreen.pixelDepth, configurable: true},
    width: {get: () => mockScreen.width, configurable: true}
  });

  // 8. Canvas fingerprint randomization
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, attributes) {
    const context = originalGetContext.call(this, type, attributes);
    
    if (type === '2d') {
      // Add subtle noise to canvas fingerprint
      const originalFillText = context.fillText;
      context.fillText = function(text, x, y, maxWidth) {
        // Add tiny random offset to avoid detection
        const randomOffset = Math.random() * 0.0001 - 0.00005;
        return originalFillText.call(this, text, x + randomOffset, y + randomOffset, maxWidth);
      };
    }
    
    return context;
  };

  // 9. WebGL fingerprint spoofing
  const originalGetParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(parameter) {
    // Spoof common WebGL parameters
    if (parameter === 37445) { // UNMASKED_VENDOR_WEBGL
      return 'Intel Inc.';
    }
    if (parameter === 37446) { // UNMASKED_RENDERER_WEBGL  
      return 'Intel Iris OpenGL Engine';
    }
    return originalGetParameter.call(this, parameter);
  };

  // 10. Audio context fingerprint randomization
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (AudioContext) {
    const originalCreateOscillator = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function() {
      const oscillator = originalCreateOscillator.call(this);
      const originalStart = oscillator.start;
      oscillator.start = function(when) {
        // Add tiny random delay to audio fingerprint
        const randomDelay = Math.random() * 0.0001;
        return originalStart.call(this, when + randomDelay);
      };
      return oscillator;
    };
  }

  // 11. Timezone spoofing (basic)
  const originalGetTimezoneOffset = Date.prototype.getTimezoneOffset;
  Date.prototype.getTimezoneOffset = function() {
    // You can customize this based on profile settings
    return -300; // EST timezone offset as example
  };

  // 12. Battery API spoofing
  if (navigator.getBattery) {
    navigator.getBattery = () => Promise.resolve({
      charging: true,
      chargingTime: 0,
      dischargingTime: Infinity,
      level: 0.85
    });
  }

  // 13. Connection API spoofing
  if (navigator.connection) {
    Object.defineProperties(navigator.connection, {
      effectiveType: {get: () => '4g', configurable: true},
      rtt: {get: () => 100, configurable: true},
      downlink: {get: () => 10, configurable: true}
    });
  }

  console.log('🛡️ Stealth mode activated - Commercial-grade anti-detection loaded');

})();