import React, { useState, useEffect, useRef } from 'react';
import Dashboard from './pages/Dashboard';
import ProxyManagerPage from './pages/ProxyManager';
import SettingsPage from './pages/SettingsPage';
import ExtensionsPage from './pages/ExtensionsPage';
import DiagnosticsPage from './pages/DiagnosticsPage';
import ActivityLogPage from './pages/ActivityLogPage';
import RecycleBinPage from './pages/RecycleBinPage';
import BillingPage from './pages/BillingPage';
import MembersPage from './pages/MembersPage';
import AdminPage from './pages/AdminPage';
import LoginPage from './pages/LoginPage';
import TitleBar from './components/TitleBar';
import Sidebar from './components/Sidebar';
import CreateProfileModal from './components/CreateProfileModal';
import QuickCreateModal from './components/QuickCreateModal';
import FolderModal from './components/FolderModal';
import BrowserDownloadNotification from './components/BrowserDownloadNotification';
import ProfileSyncNotification from './components/ProfileSyncNotification';
import ForceUpdateModal from './components/ForceUpdateModal';
import { AuthProvider } from './contexts/AuthContext';
import { useToast } from './contexts/ToastContext';
import { onAuthStateChanged, logout as authLogout, loginWithEmail } from './services/auth-service';
import {
  logActivity,
  subscribeToProfiles,
  subscribeToFolders,
  subscribeToExtensions,
  subscribeToTeams,
  createProfile as firestoreCreateProfile,
  updateProfile as firestoreUpdateProfile,
  deleteProfile as firestoreDeleteProfile,
  createFolder as firestoreCreateFolder,
  updateFolder as firestoreUpdateFolder,
  deleteFolder as firestoreDeleteFolder,
  migrateLocalProfiles,
} from './services/firestore-service';
import { Profile, Folder, Extension, Team, AppPage, AppSettings, AppUser } from '../types';
import {
  uploadProfileToCloud,
  downloadProfileFromCloud,
  needsCloudDownload,
  isLockedByOther,
  acquireProfileLock,
  refreshProfileLock,
  releaseProfileLock,
} from './services/profile-sync-service';
import { normalizeTweetUrl } from '../shared/twitter-url';

declare global {
  interface Window {
    electronAPI: {
      getVersion: () => Promise<string>;
      diagnostics?: {
        getEnvironment: () => Promise<any>;
      };
      window: {
        minimize: () => void;
        maximize: () => void;
        close: () => void;
      };
      profiles: {
        getAll: () => Promise<Profile[]>;
        getActive: () => Promise<string[]>;
        getRunning?: (profileIds: string[]) => Promise<string[]>;
        create: (profileData: any) => Promise<Profile>;
        update: (profileId: string, profileData: any) => Promise<Profile>;
        delete: (profileId: string) => Promise<boolean>;
        launch: (profileId: string, profileData: any) => Promise<{ success: boolean; error?: string; alreadyRunning?: boolean }>;
        close: (profileId: string) => Promise<boolean>;
        forceClose: (profileId: string) => Promise<boolean>;
        moveToFolder: (profileId: string, folderId: string | null) => Promise<Profile>;
        cleanupLocal: (profileId: string) => Promise<boolean>;
        onActiveUpdate: (callback: (activeProfiles: string[]) => void) => () => void;
        onUrlChanged: (callback: (profileId: string, url: string) => void) => () => void;
      };
      folders: {
        getAll: () => Promise<Folder[]>;
        create: (folderData: any) => Promise<Folder>;
        update: (folderId: string, folderData: any) => Promise<Folder>;
        delete: (folderId: string) => Promise<boolean>;
      };
      fingerprint: {
        generate: (os?: string, browserType?: string) => Promise<any>;
        getPresets: () => Promise<any[]>;
      };
      proxy: {
        test: (proxyConfig: any) => Promise<boolean>;
        add: (proxyConfig: any) => Promise<string>;
        addBulk: (proxyText: string) => Promise<number>;
        getAll: () => Promise<any[]>;
        remove: (proxyId: string) => Promise<boolean>;
        assign: (profileId: string, proxyId: string) => Promise<boolean>;
        rotate: (profileId: string) => Promise<any>;
        healthCheck: () => Promise<boolean>;
        getStats: (profileId?: string) => Promise<any[]>;
        autoAssign: (profiles: any[]) => Promise<{ profileId: string; proxy: any }[]>;
      };
      network: {
        getConnections: () => Promise<any[]>;
        getCurrentIP: () => Promise<string>;
        getActiveConnection: () => Promise<any>;
        getInstructions: () => Promise<string>;
      };
      settings?: {
        get: () => Promise<AppSettings>;
        set: (settings: Partial<AppSettings>) => Promise<AppSettings>;
      };
      auth?: {
        setUser: (user: { uid: string; email: string; role: string } | null) => Promise<boolean>;
      };
      cookies?: {
        import: (profileId: string, cookieData: string, format: 'json' | 'netscape') => Promise<{ success: boolean; count: number }>;
        export: (profileId: string) => Promise<{ success: boolean; cookies: any[] }>;
        selectFile: () => Promise<string | null>;
        saveFile: (cookieData: string, defaultName: string) => Promise<boolean>;
      };
      recycleBin?: {
        getAll: () => Promise<Profile[]>;
        restore: (profileId: string) => Promise<Profile>;
        permanentDelete: (profileId: string) => Promise<boolean>;
        purgeExpired: () => Promise<number>;
      };
      extensions?: {
        selectFile: () => Promise<string | null>;
        selectFolder: () => Promise<string | null>;
        install: (filePath: string) => Promise<{ success: boolean; extension?: any; error?: string }>;
        update: (extensionId: string, filePath: string) => Promise<{ success: boolean; extension?: any; error?: string }>;
        getAll: () => Promise<any[]>;
        remove: (extensionId: string) => Promise<boolean>;
        getPaths: (extensionIds: string[]) => Promise<string[]>;
        zip: (extensionId: string) => Promise<string>;
        readZip: (zipPath: string) => Promise<Buffer>;
        downloadAndInstall: (extensionId: string, url: string, updatedAt?: string, expectedVersion?: string) => Promise<boolean>;
      };
      profileSync?: {
        zipForSync: (profileId: string) => Promise<{ buffer: Uint8Array; size: number }>;
        unzipFromSync: (profileId: string, zipData: Uint8Array) => Promise<boolean>;
        hasLocalData: (profileId: string) => Promise<boolean>;
        getLocalSyncVersion: (profileId: string) => Promise<number>;
        setLocalSyncVersion: (profileId: string, version: number) => Promise<boolean>;
        getLocalSyncRevision: (profileId: string) => Promise<string | null>;
        setLocalSyncRevision: (profileId: string, revision: string) => Promise<boolean>;
        setBusy: (busy: boolean) => Promise<boolean>;
        downloadFromCloud: (profileId: string, url: string, idToken: string) => Promise<Uint8Array>;
        onDownloadProgress: (callback: (profileId: string, percent: number) => void) => () => void;
        getHostname: () => Promise<string>;
        getInstallationId: () => Promise<string>;
        onProfileClosed: (callback: (profileId: string) => void) => () => void;
      };
      browser?: {
        onDownloadProgress: (callback: (data: { percent: number; status: string }) => void) => () => void;
      };
      update?: {
        onUpdateAvailable: (callback: (data: { version: string; releaseNotes?: string }) => void) => () => void;
        onDownloadProgress: (callback: (data: { percent: number }) => void) => () => void;
        onUpdateDownloaded: (callback: () => void) => () => void;
        startDownload: () => Promise<void>;
        installUpdate: () => Promise<void>;
        openExternal: (url: string) => Promise<void>;
        quit: () => Promise<void>;
      };
    };
  }
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  language: 'en-US',
  defaultOS: 'windows',
  defaultBrowser: 'chrome',
  sortBy: 'custom',
  sortOrder: 'asc',
};

function App() {
  const { showToast } = useToast();
  const [user, setUser] = useState<AppUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [activePage, setActivePage] = useState<AppPage>('profiles');
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [activeProfiles, setActiveProfiles] = useState<string[]>([]);
  const [currentDeviceName, setCurrentDeviceName] = useState<string | null>(null);
  const [currentInstallationId, setCurrentInstallationId] = useState<string | null>(null);

  // Lifted states from Dashboard
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showQuickCreateModal, setShowQuickCreateModal] = useState(false);
  const [showFolderModal, setShowFolderModal] = useState(false);
  const [editingFolder, setEditingFolder] = useState<Folder | null>(null);
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);
  const [updateInfo, setUpdateInfo] = useState<{ version: string; releaseNotes?: string } | null>(null);
  const [updatePercent, setUpdatePercent] = useState<number | null>(null);
  const [updateDownloaded, setUpdateDownloaded] = useState(false);
  const [syncProgress, setSyncProgress] = useState<{ profileId: string; percent: number; type: 'upload' | 'download'; profileName?: string } | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    const saved = localStorage.getItem('spectra-sidebar-collapsed');
    return saved === 'true';
  });

  const toggleSidebar = () => {
    setSidebarCollapsed(prev => {
      const next = !prev;
      localStorage.setItem('spectra-sidebar-collapsed', String(next));
      return next;
    });
  };

  // Auto-collapse sidebar on narrow windows
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < 1024 && !sidebarCollapsed) {
        setSidebarCollapsed(true);
        localStorage.setItem('spectra-sidebar-collapsed', 'true');
      }
    };
    window.addEventListener('resize', handleResize);
    handleResize();
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Listen for auto-update events
  useEffect(() => {
    const cleanups: (() => void)[] = [];

    const c1 = window.electronAPI.update?.onUpdateAvailable((data) => {
      setUpdateInfo(data);
    });
    if (c1) cleanups.push(c1);

    const c2 = window.electronAPI.update?.onDownloadProgress((data) => {
      setUpdatePercent(data.percent);
    });
    if (c2) cleanups.push(c2);

    const c3 = window.electronAPI.update?.onUpdateDownloaded(() => {
      setUpdateDownloaded(true);
    });
    if (c3) cleanups.push(c3);

    return () => { cleanups.forEach(c => c()); };
  }, []);

  useEffect(() => {
    window.electronAPI.profiles.getActive().then(setActiveProfiles).catch(() => {});
    const cleanup = window.electronAPI.profiles.onActiveUpdate((nextActiveProfiles) => {
      setActiveProfiles(nextActiveProfiles);
    });
    return () => cleanup();
  }, []);

  useEffect(() => {
    window.electronAPI.profileSync?.getHostname?.()
      .then(setCurrentDeviceName)
      .catch(() => setCurrentDeviceName(null));
    window.electronAPI.profileSync?.getInstallationId?.()
      .then(setCurrentInstallationId)
      .catch(() => setCurrentInstallationId(null));
  }, []);

  // Auth state listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(async (appUser) => {
      setUser(appUser);
      setAuthLoading(false);
      // Sync user to main process
      if (window.electronAPI?.auth?.setUser) {
        await window.electronAPI.auth.setUser(
          appUser ? { uid: appUser.uid, email: appUser.email, role: appUser.role } : null
        ).catch(() => {});
      }
    });
    return unsubscribe;
  }, []);

  // Apply theme
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', settings.theme);
  }, [settings.theme]);

  // Load settings from store
  useEffect(() => {
    const savedTheme = localStorage.getItem('spectra-theme') as 'dark' | 'light' | null;
    if (savedTheme) {
      setSettings(prev => ({ ...prev, theme: savedTheme }));
    }
    if (window.electronAPI?.settings?.get) {
      window.electronAPI.settings.get().then(s => {
        if (s) setSettings(prev => ({ ...prev, ...s }));
      }).catch(() => {});
    }
  }, []);

  // Firestore real-time sync for profiles and folders (scoped by teamId)
  useEffect(() => {
    if (!user) return;
    setLoading(true);

    // One-time migration: move local profiles to Firestore if needed
    const migrate = async () => {
      const migrated = localStorage.getItem('spectra-firestore-migrated');
      if (!migrated) {
        try {
          const [localProfiles, localFolders] = await Promise.all([
            window.electronAPI.profiles.getAll(),
            window.electronAPI.folders.getAll(),
          ]);
          await migrateLocalProfiles(localProfiles, localFolders, user.uid, user.teamId);
          localStorage.setItem('spectra-firestore-migrated', 'true');
        } catch (e) {
          console.error('Migration error:', e);
        }
      }
    };
    migrate();

    const scopeTeamId = user.role === 'super_admin' ? null : user.teamId;
    const assignedFolderScope = user.role === 'va' ? user.assignedFolderId : null;

    // Subscribe to Firestore collections (super admin = global, others = scoped by teamId)
    const unsubProfiles = subscribeToProfiles(scopeTeamId, (allProfiles) => {
      setProfiles(allProfiles);
      setLoading(false);
    }, assignedFolderScope);

    const unsubFolders = subscribeToFolders(scopeTeamId, (allFolders) => {
      setFolders(allFolders);
    }, assignedFolderScope);

    const unsubExtensions = subscribeToExtensions(scopeTeamId, (allExtensions) => {
      setExtensions(allExtensions);
    });

    const unsubTeams = user.role === 'super_admin'
      ? subscribeToTeams(setTeams)
      : () => setTeams([]);

    return () => {
      unsubProfiles();
      unsubFolders();
      unsubExtensions();
      unsubTeams();
    };
  }, [user]);

  // Release only this device/user's own stale local locks. Never clear another user's lock.
  const lockCleanupKey = useRef<string | null>(null);
  useEffect(() => {
    if (!user || !currentDeviceName || profiles.length === 0) return;
    const cleanupKey = `${user.uid}:${currentInstallationId || currentDeviceName}`;
    if (lockCleanupKey.current === cleanupKey) return;
    lockCleanupKey.current = cleanupKey;

    const cleanupLocks = async () => {
      let activeIds: string[] = [];
      try {
        const locallyLockedIds = profiles
          .filter(p => p.lockedBy === user.uid)
          .map(p => p.id);
        if (window.electronAPI?.profiles?.getRunning) {
          activeIds = await window.electronAPI.profiles.getRunning(locallyLockedIds);
        } else if (window.electronAPI?.profiles?.getActive) {
          activeIds = await window.electronAPI.profiles.getActive();
        }
      } catch (error) {
        console.error('[LockCleanup] Could not inspect local Chrome processes; locks retained:', error);
        return;
      }

      for (const p of profiles) {
        const lockedByThisDevice = p.lockedBy === user.uid && (
          p.lockedByInstallationId
            ? p.lockedByInstallationId === currentInstallationId
            : p.lockedByDevice === currentDeviceName
        );
        if (lockedByThisDevice && !activeIds.includes(p.id)) {
          try {
            await releaseProfileLock(p.id, { uid: user.uid, deviceName: currentDeviceName, installationId: currentInstallationId });
            console.log(`[LockCleanup] Released lock on "${p.name}" (was ${p.lockedByEmail || p.lockedBy})`);
          } catch (e) {
            console.error(`[LockCleanup] Failed to release lock on "${p.name}":`, e);
          }
        }
      }
    };

    cleanupLocks();
  }, [user, currentDeviceName, currentInstallationId, profiles.length > 0]);

  useEffect(() => {
    if (!user || !currentDeviceName || activeProfiles.length === 0) return;

    const refreshOwnActiveLocks = () => {
      activeProfiles.forEach(profileId => {
        refreshProfileLock(profileId, { uid: user.uid, deviceName: currentDeviceName, installationId: currentInstallationId }).catch((error) => {
          console.error('[LockHeartbeat] Failed to refresh lock:', error);
        });
      });
    };

    refreshOwnActiveLocks();
    const interval = window.setInterval(refreshOwnActiveLocks, 30000);
    return () => window.clearInterval(interval);
  }, [user, currentDeviceName, currentInstallationId, activeProfiles]);

  // Keep a ref of profile IDs so the URL listener always has the latest
  const profileIdsRef = useRef<Set<string>>(new Set());
  const profilesRef = useRef<Profile[]>([]);
  useEffect(() => {
    profileIdsRef.current = new Set(profiles.map(p => p.id));
    profilesRef.current = profiles;
  }, [profiles]);

  // Listen for URL changes from main process and sync to Firestore
  useEffect(() => {
    if (!user) return;
    if (!window.electronAPI?.profiles?.onUrlChanged) return;

    const unsubscribe = window.electronAPI.profiles.onUrlChanged((profileId, url) => {
      if (profileIdsRef.current.has(profileId)) {
        firestoreUpdateProfile(profileId, { lastUrl: url }).catch(() => {});
      }
    });

    return () => unsubscribe();
  }, [user]);

  // Listen for profile:closed events → queue uploads one by one
  useEffect(() => {
    if (!user) return;
    if (!window.electronAPI?.profileSync?.onProfileClosed) return;

    const queueStorageKey = `spectra-profile-upload-queue:${user.uid}`;
    let uploadQueue: { profileId: string; profileName: string }[] = [];
    try {
      const storedQueue = JSON.parse(localStorage.getItem(queueStorageKey) || '[]');
      if (Array.isArray(storedQueue)) uploadQueue = storedQueue;
    } catch {}
    let isProcessing = false;
    let retryTimer: number | null = null;

    const persistQueue = () => {
      localStorage.setItem(queueStorageKey, JSON.stringify(uploadQueue));
    };

    const processQueue = async () => {
      if (isProcessing || uploadQueue.length === 0) return;
      isProcessing = true;
      await window.electronAPI.profileSync?.setBusy(true).catch(() => {});

      try {
        while (uploadQueue.length > 0) {
          const { profileId, profileName } = uploadQueue[0];
          try {
            setSyncProgress({ profileId, percent: 0, type: 'upload', profileName });
            await uploadProfileToCloud(
              profileId,
              { uid: user.uid, email: user.email },
              (percent) => setSyncProgress(prev => prev ? { ...prev, percent } : null)
            );
            await releaseProfileLock(profileId, {
              uid: user.uid,
              deviceName: currentDeviceName,
              installationId: currentInstallationId,
            });
            uploadQueue.shift();
            persistQueue();
            setSyncProgress(null);
            showToast(`"${profileName}" synchronized`, 'success');
          } catch (error) {
            console.error('[ProfileSync] Upload failed; lock retained:', error);
            setSyncProgress(null);
            showToast(`Sync failed for "${profileName}" - retry scheduled`, 'error');
            retryTimer = window.setTimeout(processQueue, 30000);
            break;
          }
        }
      } finally {
        isProcessing = false;
        await window.electronAPI.profileSync?.setBusy(false).catch(() => {});
      }
    };

    const unsubscribe = window.electronAPI.profileSync.onProfileClosed(async (profileId) => {
      const profile = profilesRef.current.find(p => p.id === profileId);
      const profileName = profile?.name || profileId;
      if (!uploadQueue.some(item => item.profileId === profileId)) {
        uploadQueue.push({ profileId, profileName });
        persistQueue();
      }
      processQueue();
    });

    processQueue();

    return () => {
      unsubscribe();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [user, currentDeviceName, currentInstallationId]);

  const handleLogout = async () => {
    if (activeProfiles.length > 0) {
      showToast('Fermez les instances ouvertes et attendez leur synchronisation avant de vous déconnecter', 'warning');
      return;
    }
    if (syncProgress) {
      showToast('Synchronisation en cours : attendez sa fin avant de vous déconnecter', 'warning');
      return;
    }
    if (user) {
      logActivity({
        teamId: user.teamId,
        userId: user.uid,
        userName: user.email,
        action: 'user_logout',
        timestamp: new Date().toISOString(),
      }).catch(() => {});
    }
    await authLogout();
    setUser(null);
    setActivePage('profiles');
  };

  const handleSwitchAccount = async (email: string, password: string) => {
    if (activeProfiles.length > 0 || syncProgress) {
      showToast('Fermez les instances et attendez leur synchronisation avant de changer de compte', 'warning');
      return;
    }
    try {
      await authLogout();
      setUser(null);
      const newUser = await loginWithEmail(email, password);
      setUser(newUser);
      setActivePage('profiles');
      showToast(`Switched to ${email}`, 'success');
    } catch (error: any) {
      showToast(`Switch failed: ${error.message}`, 'error');
    }
  };

  const handleCreateProfile = async (profileData: any) => {
    try {
      const newProfile = await firestoreCreateProfile(profileData, user!.uid, user!.teamId);
      showToast(`"${newProfile.name}" created`, 'success');
      if (user) {
        logActivity({
          teamId: user.teamId,
          userId: user.uid, userName: user.email,
          action: 'profile_created', targetProfileId: newProfile.id, targetProfileName: newProfile.name,
          timestamp: new Date().toISOString(),
        }).catch(() => {});
      }
    } catch (error) {
      console.error('Failed to create profile:', error);
      showToast('Failed to create profile', 'error');
    }
  };

  const handleUpdateProfile = async (profileId: string, profileData: any) => {
    try {
      await firestoreUpdateProfile(profileId, profileData);
      showToast(`"${profileData.name || 'Profile'}" updated`, 'success');
    } catch (error) {
      console.error('Failed to update profile:', error);
      showToast('Failed to update profile', 'error');
    }
  };

  const handleCloneProfile = async (profile: Profile) => {
    try {
      const cloneData: any = {
        name: `${profile.name} (Copy)`,
        userAgent: profile.userAgent,
        proxy: profile.proxy,
        connectionType: profile.connectionType,
        connectionConfig: profile.connectionConfig,
        timezone: profile.timezone,
        language: profile.language,
        screenResolution: profile.screenResolution,
        hardwareConcurrency: profile.hardwareConcurrency,
        deviceMemory: profile.deviceMemory,
        webglVendor: profile.webglVendor,
        webglRenderer: profile.webglRenderer,
        os: profile.os,
        browserType: profile.browserType,
        tags: profile.tags ? [...profile.tags] : [],
        notes: profile.notes,
        status: profile.status,
        preset: profile.preset,
        fingerprint: profile.fingerprint ? { ...profile.fingerprint } : {},
        folderId: profile.folderId,
        platform: profile.platform,
        createdAt: new Date().toISOString(),
      };
      const newProfile = await firestoreCreateProfile(cloneData, user!.uid, user!.teamId);
      showToast(`"${profile.name}" cloned as "${newProfile.name}"`, 'success');
      if (user) {
        logActivity({
          teamId: user.teamId,
          userId: user.uid, userName: user.email,
          action: 'profile_created', targetProfileId: newProfile.id, targetProfileName: newProfile.name,
          timestamp: new Date().toISOString(),
          metadata: { clonedFrom: profile.id },
        }).catch(() => {});
      }
    } catch (error) {
      console.error('Failed to clone profile:', error);
      showToast('Failed to clone profile', 'error');
    }
  };

  const handleDeleteProfile = async (profileId: string) => {
    try {
      const profile = profiles.find(p => p.id === profileId);
      await firestoreUpdateProfile(profileId, {
        deleted: true,
        deletedAt: new Date().toISOString(),
        deletedBy: user?.uid,
      });
      showToast(`"${profile?.name}" moved to recycle bin`, 'success');
      if (user && profile) {
        logActivity({
          teamId: user.teamId,
          userId: user.uid, userName: user.email,
          action: 'profile_deleted', targetProfileId: profileId, targetProfileName: profile.name,
          timestamp: new Date().toISOString(),
        }).catch(() => {});
      }
    } catch (error) {
      console.error('Failed to delete profile:', error);
      showToast('Failed to delete profile', 'error');
    }
  };

  const handleRestoreProfile = async (profileId: string) => {
    try {
      const profile = profiles.find(p => p.id === profileId);
      await firestoreUpdateProfile(profileId, {
        deleted: false,
        deletedAt: null,
        deletedBy: null,
      } as any);
      showToast(`"${profile?.name}" restored`, 'success');
      if (user && profile) {
        logActivity({
          teamId: user.teamId,
          userId: user.uid, userName: user.email,
          action: 'profile_restored', targetProfileId: profileId, targetProfileName: profile.name,
          timestamp: new Date().toISOString(),
        }).catch(() => {});
      }
    } catch (error) {
      console.error('Failed to restore profile:', error);
      showToast('Failed to restore profile', 'error');
    }
  };

  const handlePermanentDelete = async (profileId: string) => {
    try {
      const profile = profiles.find(p => p.id === profileId);
      // Delete from Firestore
      await firestoreDeleteProfile(profileId);
      // Clean up local Chrome profile directory
      if (window.electronAPI?.profiles?.cleanupLocal) {
        await window.electronAPI.profiles.cleanupLocal(profileId);
      }
      // onSnapshot handles state update
      if (user && profile) {
        logActivity({
          teamId: user.teamId,
          userId: user.uid, userName: user.email,
          action: 'profile_permanently_deleted', targetProfileId: profileId, targetProfileName: profile.name,
          timestamp: new Date().toISOString(),
        }).catch(() => {});
      }
    } catch (error) {
      console.error('Failed to permanently delete profile:', error);
    }
  };

  const handleEmptyBin = async () => {
    const deletedProfiles = profiles.filter(p => p.deleted);
    for (const p of deletedProfiles) {
      await handlePermanentDelete(p.id);
    }
  };

  const handleLaunchProfile = async (profile: any): Promise<boolean> => {
    try {
      // Check if profile is locked by another user
      if (user && isLockedByOther(profile, user.uid, currentDeviceName, currentInstallationId)) {
        showToast(`Profil utilisé par ${profile.lockedByEmail || 'un autre utilisateur'} sur ${profile.lockedByDevice || 'un autre PC'}`, 'warning');
        return false;
      }

      // Acquire lock
      if (user) {
        await acquireProfileLock(profile.id, { uid: user.uid, email: user.email }, currentInstallationId);
      }

      // Download from cloud if needed
      try {
        const needsDownload = await needsCloudDownload(profile);
        if (needsDownload) {
          setSyncProgress({ profileId: profile.id, percent: 0, type: 'download', profileName: profile.name });
          showToast('Téléchargement du profil depuis le cloud...', 'info');
          await downloadProfileFromCloud(
            profile,
            (percent) => setSyncProgress(prev => prev ? { ...prev, percent } : null)
          );
          setSyncProgress(null);
          showToast('Profil téléchargé', 'success');
        }
      } catch (dlError) {
        console.error('Cloud download failed:', dlError);
        setSyncProgress(null);
        // Never upload a stale local copy over a newer cloud revision.
        const downloadErrorMessage = dlError instanceof Error
          ? dlError.message
          : 'erreur inconnue';
        showToast(
          `Échec du téléchargement du profil - ${downloadErrorMessage}`,
          'error'
        );
        if (user) {
          await releaseProfileLock(profile.id, {
            uid: user.uid,
            deviceName: currentDeviceName,
            installationId: currentInstallationId,
          }).catch(() => {});
        }
        return false;
      }

      // Get enabled extensions and auto-download missing ones from cloud
      let extensionPaths: string[] = [];
      const enabledExts = extensions.filter(e => e.enabled && (!e.teamId || !profile.teamId || e.teamId === profile.teamId));
      const enabledExtIds = enabledExts.map(e => e.id);

      if (enabledExtIds.length > 0 && window.electronAPI?.extensions) {
        const cloudExtensions = enabledExts.filter(e => e.storageUrl);
        let extensionSyncFailed = false;
        for (const ext of cloudExtensions) {
          try {
            await window.electronAPI.extensions.downloadAndInstall(
              ext.id,
              ext.storageUrl!,
              ext.updatedAt,
              ext.version
            );
          } catch (e) {
            console.error(`Failed to synchronize extension ${ext.name}:`, e);
            extensionSyncFailed = true;
          }
        }
        if (extensionSyncFailed) {
          showToast('Extension update failed - launch cancelled', 'error');
          if (user) {
            await releaseProfileLock(profile.id, {
              uid: user.uid,
              deviceName: currentDeviceName,
              installationId: currentInstallationId,
            }).catch(() => {});
          }
          return false;
        }
        extensionPaths = await window.electronAPI.extensions.getPaths(enabledExtIds);
      }

      const shouldCancelLaunch = typeof profile.__shouldCancel === 'function'
        ? profile.__shouldCancel
        : () => false;
      if (shouldCancelLaunch()) {
        if (user) {
          await releaseProfileLock(profile.id, {
            uid: user.uid,
            deviceName: currentDeviceName,
            installationId: currentInstallationId,
          }).catch(() => {});
        }
        return false;
      }
      const { __shouldCancel, ...serializableProfile } = profile;
      const result = await window.electronAPI.profiles.launch(
        profile.id,
        { ...serializableProfile, extensionPaths }
      );
      if (result.success) {
        await firestoreUpdateProfile(profile.id, { lastUsed: new Date().toISOString() });
        showToast(`"${profile.name}" launched successfully`, 'success');
        if (user) {
          logActivity({
            teamId: user.teamId,
            userId: user.uid, userName: user.email,
            action: 'profile_launched', targetProfileId: profile.id, targetProfileName: profile.name,
            timestamp: new Date().toISOString(),
          }).catch(() => {});
        }
        return true;
      } else {
        if (result.alreadyRunning) {
          showToast(`"${profile.name}" is already running`, 'info');
          return true;
        } else {
          console.error('Launch failed:', result.error);
          showToast(`Launch failed: ${result.error}`, 'error');
          if (user) {
            await releaseProfileLock(profile.id, {
              uid: user.uid,
              deviceName: currentDeviceName,
              installationId: currentInstallationId,
            }).catch(() => {});
          }
          return false;
        }
      }
    } catch (error) {
      console.error('Failed to launch profile:', error);
      showToast('Failed to launch browser', 'error');
      if (user) {
        await releaseProfileLock(profile.id, {
          uid: user.uid,
          deviceName: currentDeviceName,
          installationId: currentInstallationId,
        }).catch(() => {});
      }
      return false;
    }
  };

  const [bulkLaunching, setBulkLaunching] = useState<{ total: number; current: number; name: string } | null>(null);
  const [isOpenPostRunning, setIsOpenPostRunning] = useState(false);
  const openPostRunRef = useRef<{
    cancelled: boolean;
    activeProfileIds: Set<string>;
    candidateProfileIds: string[];
  } | null>(null);

  const handleStopOpenPost = async () => {
    const run = openPostRunRef.current;
    if (!run || run.cancelled) return;

    run.cancelled = true;
    setBulkLaunching(null);
    setIsOpenPostRunning(false);
    const detectedRunningIds = window.electronAPI.profiles.getRunning
      ? await window.electronAPI.profiles.getRunning(run.candidateProfileIds).catch(() => [])
      : [];
    const profileIds = Array.from(new Set([
      ...run.activeProfileIds,
      ...detectedRunningIds,
    ]));
    await Promise.allSettled(
      profileIds.map(profileId => window.electronAPI.profiles.forceClose(profileId))
    );
    showToast('Open post stopped — current instance closed', 'warning');
  };

  const handleBulkLaunch = async (profileIds: string[]) => {
    const profilesToLaunch = visibleProfiles.filter(p =>
      profileIds.includes(p.id) &&
      !activeProfiles.includes(p.id) &&
      !(user && isLockedByOther(p, user.uid, currentDeviceName, currentInstallationId))
    );

    if (profilesToLaunch.length === 0) {
      showToast('Aucune instance disponible à lancer', 'info');
      return;
    }

    setBulkLaunching({ total: profilesToLaunch.length, current: 0, name: '' });

    let launchedCount = 0;
    for (let i = 0; i < profilesToLaunch.length; i++) {
      const profile = profilesToLaunch[i];
      setBulkLaunching({ total: profilesToLaunch.length, current: i + 1, name: profile.name });

      const launched = await handleLaunchProfile({
        ...profile,
        lastUrl: 'https://x.com/i/chat/requests',
        autoStartTwitterBot: true,
        windowLayout: { index: i, total: profilesToLaunch.length },
      });
      if (launched) launchedCount++;

      // Small delay between launches to avoid overwhelming the system
      if (i < profilesToLaunch.length - 1) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    setBulkLaunching(null);
    const failedCount = profilesToLaunch.length - launchedCount;
    showToast(
      failedCount === 0
        ? `${launchedCount} instances launched`
        : `${launchedCount} launched, ${failedCount} failed`,
      failedCount === 0 ? 'success' : 'warning'
    );
  };

  const handleOpenTweetInFolder = async (profileIds: string[], tweetUrl: string) => {
    const normalizedUrl = normalizeTweetUrl(tweetUrl);
    if (!normalizedUrl) {
      showToast('Enter a valid X post URL', 'warning');
      return;
    }

    const profilesToLaunch = visibleProfiles.filter(p =>
      profileIds.includes(p.id) &&
      !activeProfiles.includes(p.id) &&
      !(user && isLockedByOther(p, user.uid, currentDeviceName, currentInstallationId))
    );
    const skippedCount = profileIds.length - profilesToLaunch.length;

    if (profilesToLaunch.length === 0) {
      showToast('No available instance in this folder', 'info');
      return;
    }

    const runState = {
      cancelled: false,
      activeProfileIds: new Set<string>(),
      candidateProfileIds: profilesToLaunch.map(profile => profile.id),
    };
    openPostRunRef.current = runState;
    setIsOpenPostRunning(true);
    setBulkLaunching({ total: profilesToLaunch.length, current: 0, name: '' });
    let launchedCount = 0;
    let completedCount = 0;
    let timedOutCount = 0;
    const launchBatchSize = 1;
    const launchStaggerMs = 0;

    const waitForBatchToClose = async (profileIds: string[], timeoutMs = 60000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const runningIds = window.electronAPI.profiles.getRunning
          ? await window.electronAPI.profiles.getRunning(profileIds)
          : (await window.electronAPI.profiles.getActive()).filter(id => profileIds.includes(id));
        if (runningIds.length === 0) return true;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      return false;
    };

    for (let batchStart = 0; batchStart < profilesToLaunch.length; batchStart += launchBatchSize) {
      if (runState.cancelled) break;
      const batch = profilesToLaunch.slice(batchStart, batchStart + launchBatchSize);
      const batchResults = await Promise.all(
        batch.map(async (profile, batchIndex) => {
          if (runState.cancelled) return false;
          runState.activeProfileIds.add(profile.id);
          if (batchIndex > 0) {
            await new Promise(resolve => setTimeout(resolve, batchIndex * launchStaggerMs));
          }
          if (runState.cancelled) {
            runState.activeProfileIds.delete(profile.id);
            return false;
          }
          setBulkLaunching({
            total: profilesToLaunch.length,
            current: completedCount,
            name: profile.name,
          });
          const launched = await handleLaunchProfile({
            ...profile,
            lastUrl: normalizedUrl,
            targetTweetUrl: normalizedUrl,
            autoStartTwitterBot: false,
            __shouldCancel: () => runState.cancelled,
            windowLayout: { index: batchIndex, total: batch.length },
          });
          if (launched) {
            launchedCount++;
            if (runState.cancelled) {
              await window.electronAPI.profiles.forceClose(profile.id);
            }
          } else {
            runState.activeProfileIds.delete(profile.id);
          }
          completedCount++;
          setBulkLaunching({
            total: profilesToLaunch.length,
            current: completedCount,
            name: profile.name,
          });
          return launched;
        })
      );

      const launchedBatchIds = batch
        .filter((_, index) => batchResults[index])
        .map(profile => profile.id);
      if (runState.cancelled) {
        await Promise.allSettled(
          launchedBatchIds.map(profileId => window.electronAPI.profiles.forceClose(profileId))
        );
        break;
      }
      if (launchedBatchIds.length === 0) continue;

      setBulkLaunching({
        total: profilesToLaunch.length,
        current: completedCount,
        name: `Waiting for batch ${Math.floor(batchStart / launchBatchSize) + 1}`,
      });
      const batchClosed = await waitForBatchToClose(launchedBatchIds);
      launchedBatchIds.forEach(profileId => runState.activeProfileIds.delete(profileId));
      if (runState.cancelled) break;
      if (!batchClosed) {
        timedOutCount += launchedBatchIds.length;
        const timedOutProfile = batch.find(profile => launchedBatchIds.includes(profile.id));
        setBulkLaunching({
          total: profilesToLaunch.length,
          current: completedCount,
          name: `${timedOutProfile?.name || 'Instance'} — proxy too slow`,
        });
        showToast(
          `"${timedOutProfile?.name || 'Instance'}" ignored: proxy too slow`,
          'warning'
        );
        await Promise.allSettled(
          launchedBatchIds.map(profileId => window.electronAPI.profiles.forceClose(profileId))
        );
      }
    }

    const wasCancelled = runState.cancelled;
    if (openPostRunRef.current === runState) openPostRunRef.current = null;
    setIsOpenPostRunning(false);
    setBulkLaunching(null);
    if (wasCancelled) return;
    const failedCount = profilesToLaunch.length - launchedCount;
    const summary = [
      `${launchedCount} opened`,
      timedOutCount > 0 ? `${timedOutCount} ignored (timeout)` : '',
      failedCount > 0 ? `${failedCount} failed` : '',
      skippedCount > 0 ? `${skippedCount} already open or unavailable` : '',
    ].filter(Boolean).join(', ');
    showToast(summary, failedCount === 0 ? 'success' : 'warning');
  };

  const handleCreateFolder = async (folderData: any) => {
    try {
      await firestoreCreateFolder(folderData, user!.uid, user!.teamId);
      // onSnapshot handles state update
    } catch (error) {
      console.error('Failed to create folder:', error);
    }
  };

  const handleUpdateFolder = async (folderId: string, folderData: any) => {
    try {
      await firestoreUpdateFolder(folderId, folderData);
      // onSnapshot handles state update
    } catch (error) {
      console.error('Failed to update folder:', error);
    }
  };

  const handleDeleteFolder = async (folderId: string) => {
    try {
      await firestoreDeleteFolder(folderId);
      // onSnapshot handles state update (profiles in folder get folderId=null via batch)
    } catch (error) {
      console.error('Failed to delete folder:', error);
    }
  };

  const handleMoveProfile = async (profileId: string, folderId: string | null) => {
    try {
      await firestoreUpdateProfile(profileId, { folderId: folderId || (null as any) });
      // onSnapshot handles state update
    } catch (error) {
      console.error('Failed to move profile:', error);
    }
  };

  const handleSettingsChange = (newSettings: Partial<AppSettings>) => {
    const updated = { ...settings, ...newSettings };
    setSettings(updated);
    if (newSettings.theme) {
      localStorage.setItem('spectra-theme', newSettings.theme);
    }
    if (window.electronAPI?.settings?.set) {
      window.electronAPI.settings.set(newSettings).catch(() => {});
    }
  };

  // Filter profiles: exclude deleted, and for VA only show assigned
  const vaAssignedFolderIds = (() => {
    if (user?.role !== 'va' || !user.assignedFolderId) return new Set<string>();
    const allowed = new Set<string>([user.assignedFolderId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const folder of folders) {
        if (folder.parentId && allowed.has(folder.parentId) && !allowed.has(folder.id)) {
          allowed.add(folder.id);
          changed = true;
        }
      }
    }
    return allowed;
  })();

  const visibleProfiles = profiles.filter(p => {
    if (p.deleted) return false;
    if (user?.role === 'va') {
      if (user.assignedFolderId) {
        return Boolean(p.folderId && vaAssignedFolderIds.has(p.folderId));
      }
      if (p.assignedTo !== user.uid) return false;
    }
    return true;
  });

  const visibleFolders = user?.role === 'va' && user.assignedFolderId
    ? folders.filter(folder => vaAssignedFolderIds.has(folder.id))
    : folders;

  const deletedProfiles = profiles.filter(p => p.deleted);

  const profileCounts = visibleProfiles.reduce((acc, profile) => {
    if (profile.folderId) {
      acc[profile.folderId] = (acc[profile.folderId] || 0) + 1;
      // Also count towards parent folder
      const folder = visibleFolders.find(f => f.id === profile.folderId);
      if (folder?.parentId) {
        acc[folder.parentId] = (acc[folder.parentId] || 0) + 1;
      }
    }
    return acc;
  }, {} as { [folderId: string]: number });

  const renderPage = () => {
    const hasAdminAccess = user?.role === 'super_admin' || user?.role === 'admin' || user?.role === 'owner';

    switch (activePage) {
      case 'profiles':
        return (
          <Dashboard
            profiles={visibleProfiles}
            folders={visibleFolders}
            teams={teams}
            loading={loading}
            selectedFolderId={selectedFolderId}
            onSelectFolder={setSelectedFolderId}
            settings={settings}
            onCreateProfile={handleCreateProfile}
            onUpdateProfile={handleUpdateProfile}
            onDeleteProfile={handleDeleteProfile}
            onLaunchProfile={handleLaunchProfile}
            onBulkLaunch={handleBulkLaunch}
            onOpenTweetInFolder={handleOpenTweetInFolder}
            bulkLaunching={bulkLaunching}
            isOpenPostRunning={isOpenPostRunning}
            onStopOpenPost={handleStopOpenPost}
            onMoveProfile={handleMoveProfile}
            onShowCreateModal={() => setShowCreateModal(true)}
            onEditProfile={(profile) => { setEditingProfile(profile); setShowCreateModal(true); }}
            onCloneProfile={handleCloneProfile}
            currentDeviceName={currentDeviceName}
          />
        );
      case 'proxies':
        return <ProxyManagerPage profiles={visibleProfiles} folders={visibleFolders} onUpdateProfile={handleUpdateProfile} userId={user?.uid} teamId={user?.teamId} />;
      case 'extensions':
        return hasAdminAccess ? <ExtensionsPage teamId={user?.role === 'super_admin' ? null : user?.teamId || null} teams={teams} /> : null;
      case 'diagnostics':
        return <DiagnosticsPage user={user} profiles={visibleProfiles} activeProfiles={activeProfiles} />;
      case 'settings':
        return <SettingsPage settings={settings} onSettingsChange={handleSettingsChange} user={user} onLogout={handleLogout} />;
      case 'activity':
        return hasAdminAccess ? <ActivityLogPage teamId={user?.role === 'super_admin' ? '' : user?.teamId || ''} /> : null;
      case 'recycle-bin':
        return hasAdminAccess ? (
          <RecycleBinPage
            deletedProfiles={deletedProfiles}
            onRestore={handleRestoreProfile}
            onPermanentDelete={handlePermanentDelete}
            onEmptyBin={handleEmptyBin}
          />
        ) : null;
      case 'billing':
        return hasAdminAccess ? <BillingPage /> : null;
      case 'members':
        return hasAdminAccess ? <MembersPage teamId={user?.teamId || ''} folders={folders} /> : null;
      case 'admin-panel':
        return user?.role === 'super_admin' ? <AdminPage /> : null;
      default:
        return null;
    }
  };

  // Auth loading
  if (authLoading) {
    return (
      <div className="h-screen flex flex-col" style={{ background: 'var(--bg-base)' }}>
        <TitleBar />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="w-10 h-10 border-2 border-t-transparent rounded-full animate-spin mx-auto mb-3" style={{ borderColor: 'var(--accent)', borderTopColor: 'transparent' }} />
            <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>Loading...</p>
          </div>
        </div>
      </div>
    );
  }

  // Not authenticated
  if (!user) {
    return (
      <div className="h-screen flex flex-col" style={{ background: 'var(--bg-base)' }}>
        <TitleBar />
        <LoginPage onLogin={() => {}} />
      </div>
    );
  }

  // Authenticated
  return (
    <AuthProvider user={user}>
      <div className="h-screen flex flex-col" style={{ background: 'var(--bg-base)' }}>
        <TitleBar />
        <BrowserDownloadNotification />
        <ProfileSyncNotification syncProgress={syncProgress} onDismiss={() => setSyncProgress(null)} />
        <div className="flex-1 flex overflow-hidden">
          <Sidebar
            activePage={activePage}
            onNavigate={setActivePage}
            folders={visibleFolders}
            teams={teams}
            selectedFolderId={selectedFolderId}
            profileCounts={profileCounts}
            totalProfiles={visibleProfiles.length}
            onSelectFolder={setSelectedFolderId}
            onCreateFolder={() => setShowFolderModal(true)}
            onEditFolder={(folder) => { setEditingFolder(folder); setShowFolderModal(true); }}
            onDeleteFolder={handleDeleteFolder}
            onCreateProfile={() => setShowCreateModal(true)}
            onQuickCreate={() => setShowQuickCreateModal(true)}
            onMoveProfile={handleMoveProfile}
            onLogout={handleLogout}
            onSwitchAccount={handleSwitchAccount}
            collapsed={sidebarCollapsed}
            onToggleCollapse={toggleSidebar}
          />
          <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
            {renderPage()}
          </main>
        </div>

        {showCreateModal && (
          <CreateProfileModal
            onClose={() => { setShowCreateModal(false); setEditingProfile(null); }}
            onCreate={(data) => { handleCreateProfile(data); setShowCreateModal(false); setEditingProfile(null); }}
            onUpdate={(id, data) => { handleUpdateProfile(id, data); setShowCreateModal(false); setEditingProfile(null); }}
            folders={folders}
            defaultFolderId={selectedFolderId === '__none__' ? null : selectedFolderId}
            editProfile={editingProfile}
          />
        )}

        {showQuickCreateModal && (
          <QuickCreateModal
            onClose={() => setShowQuickCreateModal(false)}
            onCreate={handleCreateProfile}
            folders={folders}
          />
        )}

        {showFolderModal && (
          <FolderModal
            isOpen={showFolderModal}
            onClose={() => { setShowFolderModal(false); setEditingFolder(null); }}
            onSubmit={editingFolder
              ? (data) => { handleUpdateFolder(editingFolder.id, data); setEditingFolder(null); setShowFolderModal(false); }
              : (data) => { handleCreateFolder(data); setShowFolderModal(false); }
            }
            folder={editingFolder || undefined}
            folders={folders}
          />
        )}

        {updateInfo && (
          <ForceUpdateModal version={updateInfo.version} releaseNotes={updateInfo.releaseNotes} downloadPercent={updatePercent} downloaded={updateDownloaded} />
        )}
      </div>
    </AuthProvider>
  );
}

export default App;
