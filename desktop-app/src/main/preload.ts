import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getVersion: () => ipcRenderer.invoke('app:getVersion'),

  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
  },

  profiles: {
    // Legacy: used only for one-time migration to Firestore
    getAll: () => ipcRenderer.invoke('profiles:getAll'),
    getActive: () => ipcRenderer.invoke('profiles:getActive'),
    // Launch/close still go through main process (Puppeteer is local)
    launch: (profileId: string, profileData: any) => ipcRenderer.invoke('profile:launch', profileId, profileData),
    close: (profileId: string) => ipcRenderer.invoke('profile:close', profileId),
    // Clean up local Chrome profile directory
    cleanupLocal: (profileId: string) => ipcRenderer.invoke('profile:cleanupLocal', profileId),
    // Listen for active profiles updates
    onActiveUpdate: (callback: (activeProfiles: string[]) => void) => {
      const listener = (_event: any, activeProfiles: string[]) => callback(activeProfiles);
      ipcRenderer.on('profiles:activeUpdate', listener);
      return () => {
        ipcRenderer.removeListener('profiles:activeUpdate', listener);
      };
    },
    // Listen for URL changes from main process (Puppeteer) to sync to Firestore
    onUrlChanged: (callback: (profileId: string, url: string) => void) => {
      const listener = (_event: any, profileId: string, url: string) => callback(profileId, url);
      ipcRenderer.on('profile:urlChanged', listener);
      return () => {
        ipcRenderer.removeListener('profile:urlChanged', listener);
      };
    },
  },

  folders: {
    // Legacy: used only for one-time migration to Firestore
    getAll: () => ipcRenderer.invoke('folders:getAll'),
  },

  fingerprint: {
    generate: (os?: string, browserType?: string, countryCode?: string) => ipcRenderer.invoke('fingerprint:generate', os, browserType, countryCode),
    getPresets: () => ipcRenderer.invoke('fingerprint:getPresets'),
  },

  proxy: {
    test: (proxyConfig: any) => ipcRenderer.invoke('proxy:test', proxyConfig),
    add: (proxyConfig: any) => ipcRenderer.invoke('proxy:add', proxyConfig),
    addBulk: (proxyText: string) => ipcRenderer.invoke('proxy:addBulk', proxyText),
    getAll: () => ipcRenderer.invoke('proxy:getAll'),
    remove: (proxyId: string) => ipcRenderer.invoke('proxy:remove', proxyId),
    assign: (profileId: string, proxyId: string) => ipcRenderer.invoke('proxy:assign', profileId, proxyId),
    rotate: (profileId: string) => ipcRenderer.invoke('proxy:rotate', profileId),
    healthCheck: () => ipcRenderer.invoke('proxy:healthCheck'),
    getStats: (profileId?: string) => ipcRenderer.invoke('proxy:getStats', profileId),
    autoAssign: (profiles: any[]) => ipcRenderer.invoke('proxy:autoAssign', profiles),
  },

  profileSync: {
    zipForSync: (profileId: string) => ipcRenderer.invoke('profile:zipForSync', profileId),
    unzipFromSync: (profileId: string, zipData: Uint8Array) => ipcRenderer.invoke('profile:unzipFromSync', profileId, zipData),
    hasLocalData: (profileId: string) => ipcRenderer.invoke('profile:hasLocalData', profileId),
    getLocalSyncVersion: (profileId: string) => ipcRenderer.invoke('profile:getLocalSyncVersion', profileId),
    setLocalSyncVersion: (profileId: string, version: number) => ipcRenderer.invoke('profile:setLocalSyncVersion', profileId, version),
    getHostname: () => ipcRenderer.invoke('system:hostname'),
    onProfileClosed: (callback: (profileId: string) => void) => {
      const listener = (_event: any, profileId: string) => callback(profileId);
      ipcRenderer.on('profile:closed', listener);
      return () => ipcRenderer.removeListener('profile:closed', listener);
    },
  },

  network: {
    getConnections: () => ipcRenderer.invoke('network:getConnections'),
    getCurrentIP: () => ipcRenderer.invoke('network:getCurrentIP'),
    getActiveConnection: () => ipcRenderer.invoke('network:getActiveConnection'),
    getInstructions: () => ipcRenderer.invoke('network:getInstructions'),
  },

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (settings: any) => ipcRenderer.invoke('settings:set', settings),
  },

  auth: {
    setUser: (user: { uid: string; email: string; role: string } | null) => ipcRenderer.invoke('auth:setUser', user),
  },

  cookies: {
    import: (profileId: string, cookieData: string, format: 'json' | 'netscape') => ipcRenderer.invoke('cookies:import', profileId, cookieData, format),
    export: (profileId: string) => ipcRenderer.invoke('cookies:export', profileId),
    selectFile: () => ipcRenderer.invoke('cookies:selectFile'),
    saveFile: (cookieData: string, defaultName: string) => ipcRenderer.invoke('cookies:saveFile', cookieData, defaultName),
  },

  extensions: {
    selectFile: () => ipcRenderer.invoke('extensions:selectFile'),
    selectFolder: () => ipcRenderer.invoke('extensions:selectFolder'),
    install: (filePath: string) => ipcRenderer.invoke('extensions:install', filePath),
    update: (extensionId: string, filePath: string) => ipcRenderer.invoke('extensions:update', extensionId, filePath),
    getAll: () => ipcRenderer.invoke('extensions:getAll'),
    remove: (extensionId: string) => ipcRenderer.invoke('extensions:remove', extensionId),
    getPaths: (extensionIds: string[]) => ipcRenderer.invoke('extensions:getPaths', extensionIds),
    zip: (extensionId: string) => ipcRenderer.invoke('extensions:zip', extensionId),
    readZip: (zipPath: string) => ipcRenderer.invoke('extensions:readZip', zipPath),
    downloadAndInstall: (extensionId: string, url: string) => ipcRenderer.invoke('extensions:downloadAndInstall', extensionId, url),
    installFromStore: (storeUrl: string) => ipcRenderer.invoke('extensions:installFromStore', storeUrl),
  },

  browser: {
    onDownloadProgress: (callback: (data: { percent: number; status: string }) => void) => {
      const listener = (_event: any, data: { percent: number; status: string }) => callback(data);
      ipcRenderer.on('browser:downloadProgress', listener);
      return () => {
        ipcRenderer.removeListener('browser:downloadProgress', listener);
      };
    },
  },

  update: {
    onUpdateAvailable: (callback: (data: { version: string }) => void) => {
      const listener = (_event: any, data: { version: string }) => callback(data);
      ipcRenderer.on('app:update-available', listener);
      return () => {
        ipcRenderer.removeListener('app:update-available', listener);
      };
    },
    onDownloadProgress: (callback: (data: { percent: number }) => void) => {
      const listener = (_event: any, data: { percent: number }) => callback(data);
      ipcRenderer.on('app:update-progress', listener);
      return () => {
        ipcRenderer.removeListener('app:update-progress', listener);
      };
    },
    onUpdateDownloaded: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('app:update-downloaded', listener);
      return () => {
        ipcRenderer.removeListener('app:update-downloaded', listener);
      };
    },
    startDownload: () => ipcRenderer.invoke('app:startDownload'),
    installUpdate: () => ipcRenderer.invoke('app:installUpdate'),
    openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
    quit: () => ipcRenderer.invoke('app:quit'),
  },

  recycleBin: {
    // Recycle bin is now managed via Firestore in the renderer
    // These stubs exist for backward compatibility
    getAll: () => Promise.resolve([]),
    restore: (_profileId: string) => Promise.resolve(null),
    permanentDelete: (_profileId: string) => Promise.resolve(true),
    purgeExpired: () => Promise.resolve(0),
  },
});

export {};
