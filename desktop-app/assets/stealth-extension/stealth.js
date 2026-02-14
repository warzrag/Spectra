// Stealth script — runs as MAIN world content script (not detectable via CDP)
// This replaces the old CDP-injected buildStealthScript()

(function() {
  'use strict';

  // 1. Remove navigator.webdriver
  Object.defineProperty(navigator, 'webdriver', {
    get: () => false,
    configurable: true,
  });

  // Also delete it from the prototype
  const proto = Object.getPrototypeOf(navigator);
  if (proto && Object.getOwnPropertyDescriptor(proto, 'webdriver')) {
    Object.defineProperty(proto, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });
  }

  // 2. Fix chrome.runtime to look like a normal browser (not automation)
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      connect: function() {},
      sendMessage: function() {},
    };
  }

  // 3. Fix permissions API (Notification permission query)
  const originalQuery = window.Notification && Notification.permission;
  if (navigator.permissions) {
    const originalPermQuery = navigator.permissions.query;
    navigator.permissions.query = function(parameters) {
      if (parameters.name === 'notifications') {
        return Promise.resolve({ state: Notification.permission || 'default' });
      }
      return originalPermQuery.call(this, parameters);
    };
  }

  // 4. Fix plugins and mimeTypes (headless Chrome has 0)
  if (navigator.plugins.length === 0) {
    const pluginData = [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
      { name: 'Chromium PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    ];

    const pluginArray = Object.create(PluginArray.prototype);
    const mimeArray = Object.create(MimeTypeArray.prototype);

    pluginData.forEach((p, i) => {
      const plugin = Object.create(Plugin.prototype, {
        name: { value: p.name },
        filename: { value: p.filename },
        description: { value: p.description },
        length: { value: 1 },
      });
      Object.defineProperty(pluginArray, i, { value: plugin });
    });

    Object.defineProperty(pluginArray, 'length', { value: pluginData.length });
    Object.defineProperty(navigator, 'plugins', { get: () => pluginArray });
    Object.defineProperty(navigator, 'mimeTypes', { get: () => mimeArray });
  }

  // 5. Fix languages
  Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en'],
    configurable: true,
  });

  // 6. Prevent canvas fingerprint detection by adding subtle noise
  const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function(type, quality) {
    const ctx = this.getContext('2d');
    if (ctx && this.width > 0 && this.height > 0) {
      try {
        const imageData = ctx.getImageData(0, 0, Math.min(this.width, 2), Math.min(this.height, 2));
        // Add minimal noise to one pixel
        if (imageData.data.length > 0) {
          imageData.data[0] = imageData.data[0] ^ 1;
          ctx.putImageData(imageData, 0, 0);
        }
      } catch (e) {
        // SecurityError for cross-origin canvas — ignore
      }
    }
    return originalToDataURL.call(this, type, quality);
  };

  const originalToBlob = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function(callback, type, quality) {
    const ctx = this.getContext('2d');
    if (ctx && this.width > 0 && this.height > 0) {
      try {
        const imageData = ctx.getImageData(0, 0, Math.min(this.width, 2), Math.min(this.height, 2));
        if (imageData.data.length > 0) {
          imageData.data[0] = imageData.data[0] ^ 1;
          ctx.putImageData(imageData, 0, 0);
        }
      } catch (e) {}
    }
    return originalToBlob.call(this, callback, type, quality);
  };

  // 7. WebGL vendor/renderer spoofing
  const getParameterProxyHandler = {
    apply: function(target, thisArg, args) {
      const param = args[0];
      const gl = thisArg;

      // UNMASKED_VENDOR_WEBGL
      if (param === 0x9245) return 'Google Inc. (NVIDIA)';
      // UNMASKED_RENDERER_WEBGL
      if (param === 0x9246) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB Direct3D11 vs_5_0 ps_5_0, D3D11)';

      return target.call(thisArg, ...args);
    }
  };

  const origGetParameterWebGL = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = new Proxy(origGetParameterWebGL, getParameterProxyHandler);

  if (typeof WebGL2RenderingContext !== 'undefined') {
    const origGetParameterWebGL2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = new Proxy(origGetParameterWebGL2, getParameterProxyHandler);
  }

  // 8. Fix connection.rtt (automation usually has 0)
  if (navigator.connection) {
    try {
      Object.defineProperty(navigator.connection, 'rtt', { get: () => 50, configurable: true });
    } catch (e) {}
  }

  // 9. Remove automation-related properties from window
  delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
  delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
  delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
  delete window.cdc_adoQpoasnfa76pfcZLmcfl_JSON;
  delete window.cdc_adoQpoasnfa76pfcZLmcfl_Proxy;
  delete window.cdc_adoQpoasnfa76pfcZLmcfl_Object;

  // 10. Fix iframe contentWindow to not leak automation
  try {
    const origContentWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
    if (origContentWindow) {
      Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
        get: function() {
          const win = origContentWindow.get.call(this);
          if (win) {
            try {
              Object.defineProperty(win.navigator, 'webdriver', {
                get: () => false,
                configurable: true,
              });
            } catch (e) {}
          }
          return win;
        }
      });
    }
  } catch (e) {}

  // 11. Spoof screen dimensions to common values
  try {
    Object.defineProperty(screen, 'colorDepth', { get: () => 24, configurable: true });
    Object.defineProperty(screen, 'pixelDepth', { get: () => 24, configurable: true });
  } catch (e) {}

  // 12. Fix toString() for all overridden functions to look native
  const nativeToString = Function.prototype.toString;
  const overrides = new Map();

  function makeNative(fn, nativeName) {
    overrides.set(fn, `function ${nativeName}() { [native code] }`);
  }

  Function.prototype.toString = function() {
    if (overrides.has(this)) return overrides.get(this);
    return nativeToString.call(this);
  };

  makeNative(Function.prototype.toString, 'toString');
  makeNative(HTMLCanvasElement.prototype.toDataURL, 'toDataURL');
  makeNative(HTMLCanvasElement.prototype.toBlob, 'toBlob');
  makeNative(WebGLRenderingContext.prototype.getParameter, 'getParameter');
  if (typeof WebGL2RenderingContext !== 'undefined') {
    makeNative(WebGL2RenderingContext.prototype.getParameter, 'getParameter');
  }
  if (navigator.permissions) {
    makeNative(navigator.permissions.query, 'query');
  }

})();
