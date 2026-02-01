// Script to inject directly into Chrome pages
// This runs in the page context, not as an extension

(() => {
  // Override the navigator.webdriver property
  delete Object.getPrototypeOf(navigator).webdriver;
  
  // Fix Chrome properties
  const originalChrome = window.chrome;
  if (originalChrome) {
    window.chrome = {
      ...originalChrome,
      runtime: undefined,
      app: undefined,
      csi: undefined,
      loadTimes: undefined
    };
  }
  
  // Override CDP detection
  const originalToString = Function.prototype.toString;
  Function.prototype.toString = function() {
    if (this === window.chrome) {
      return 'function chrome() { [native code] }';
    }
    return originalToString.call(this);
  };
  
  // Fix permission API
  if (navigator.permissions) {
    const originalQuery = navigator.permissions.query;
    navigator.permissions.query = function(parameters) {
      if (parameters.name === 'notifications') {
        return Promise.resolve({ state: 'prompt' });
      }
      return originalQuery.apply(this, arguments);
    };
  }
  
  // Remove Selenium/WebDriver variables
  const automationVars = [
    '__webdriver_script_fn',
    '__driver_evaluate',
    '__webdriver_evaluate',
    '__selenium_evaluate',
    '__fxdriver_evaluate',
    '__driver_unwrapped',
    '__webdriver_unwrapped',
    '__selenium_unwrapped',
    '__fxdriver_unwrapped',
    '__webdriver_script_func',
    'webdriver',
    '_phantom',
    'phantom',
    'callPhantom',
    '_selenium',
    'callSelenium',
    '__nightmare'
  ];
  
  automationVars.forEach(varName => {
    try {
      delete window[varName];
    } catch (e) {}
  });
})();