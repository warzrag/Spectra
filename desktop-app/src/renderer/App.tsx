import React, { useState, useEffect, useRef } from 'react';
import Dashboard from './pages/Dashboard';
import ProxyManagerPage from './pages/ProxyManager';
import SettingsPage from './pages/SettingsPage';
import ExtensionsPage from './pages/ExtensionsPage';
import ActivityLogPage from './pages/ActivityLogPage';
import RecycleBinPage from './pages/RecycleBinPage';
import BillingPage from './pages/BillingPage';
import MembersPage from './pages/MembersPage';
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
import { onAuthStateChanged, logout as authLogout } from './services/auth-service';
import {
  logActivity,
  subscribeToProfiles,
  subscribeToFolders,
  subscribeToExtensions,
  createProfile as firestoreCreateProfile,
  updateProfile as firestoreUpdateProfile,
  deleteProfile as firestoreDeleteProfile,
  createFolder as firestoreCreateFolder,
  updateFolder as firestoreUpdateFolder,
  deleteFolder as firestoreDeleteFolder,
  migrateLocalProfiles,
  migrateExistingDataToTeam,
} from './services/firestore-service';
import { Profile, Folder, Extension, AppPage, AppSettings, AppUser } from '../types';
import {
  uploadProfileToCloud,
  downloadProfileFromCloud,
  needsCloudDownload,
  isLockedByOther,
  acquireProfileLock,
  releaseProfileLock,
} from './services/profile-sync-service';

declare global {
  interface Window {
    electronAPI: {
      getVersion: () => Promise<string>;
      window: {
        minimize: () => void;
        maximize: () => void;
        close: () => void;
      };
      profiles: {
        getAll: () => Promise<Profile[]>;
        getActive: () => Promise<string[]>;
        create: (profileData: any) => Promise<Profile>;
        update: (profileId: string, profileData: any) => Promise<Profile>;
        delete: (profileId: string) => Promise<boolean>;
        launch: (profileId: string, profileData: any) => Promise<{ success: boolean; error?: string; alreadyRunning?: boolean }>;
        close: (profileId: string) => Promise<boolean>;
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
        downloadAndInstall: (extensionId: string, url: string) => Promise<boolean>;
      };
      profileSync?: {
        zipForSync: (profileId: string) => Promise<{ buffer: number[]; size: number }>;
        unzipFromSync: (profileId: string, zipData: number[]) => Promise<boolean>;
        hasLocalData: (profileId: string) => Promise<boolean>;
        getLocalSyncVersion: (profileId: string) => Promise<number>;
        setLocalSyncVersion: (profileId: string, version: number) => Promise<boolean>;
        getHostname: () => Promise<string>;
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
  sortBy: 'created',
  sortOrder: 'desc',
};

function App() {
  const { showToast } = useToast();
  const [user, setUser] = useState<AppUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [loading, setLoading] = useState(true);
  const [activePage, setActivePage] = useState<AppPage>('profiles');
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);

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
        } catch (e) {
          console.error('Migration error:', e);
        }
        localStorage.setItem('spectra-firestore-migrated', 'true');
      }
    };
    migrate();

    // Migration: assign teamId to legacy data without teamId
    const migrateTeam = async () => {
      try {
        await migrateExistingDataToTeam(user.teamId);
      } catch (e) {
        console.error('Team migration error:', e);
      }
    };
    migrateTeam();

    // Subscribe to Firestore collections (real-time, scoped by teamId)
    const unsubProfiles = subscribeToProfiles(user.teamId, (allProfiles) => {
      setProfiles(allProfiles);
      setLoading(false);
    });

    const unsubFolders = subscribeToFolders(user.teamId, (allFolders) => {
      setFolders(allFolders);
    });

    const unsubExtensions = subscribeToExtensions(user.teamId, (allExtensions) => {
      setExtensions(allExtensions);
    });

    return () => {
      unsubProfiles();
      unsubFolders();
      unsubExtensions();
    };
  }, [user]);

  // On startup: release only TRULY stale locks (older than 2h) owned by this user
  const startupLockCleanupDone = useRef(false);
  useEffect(() => {
    if (!user || profiles.length === 0 || startupLockCleanupDone.current) return;
    startupLockCleanupDone.current = true;

    const STALE_LOCK_MS = 2 * 60 * 60 * 1000; // 2 hours
    const cleanupLocks = async () => {
      const myLockedProfiles = profiles.filter(p => p.lockedBy === user.uid && p.lockedAt);
      for (const p of myLockedProfiles) {
        const lockAge = Date.now() - new Date(p.lockedAt!).getTime();
        if (lockAge > STALE_LOCK_MS) {
          try {
            await releaseProfileLock(p.id);
            console.log(`[Startup] Released stale lock on "${p.name}" (${Math.round(lockAge / 60000)}min old)`);
          } catch {}
        }
      }
    };
    cleanupLocks();
  }, [user, profiles.length > 0]);

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

    const uploadQueue: { profileId: string; profileName: string }[] = [];
    let isProcessing = false;

    const processQueue = async () => {
      if (isProcessing || uploadQueue.length === 0) return;
      isProcessing = true;

      while (uploadQueue.length > 0) {
        const { profileId, profileName } = uploadQueue.shift()!;

        // Upload to cloud FIRST, then release lock
        try {
          setSyncProgress({ profileId, percent: 0, type: 'upload', profileName });

          await uploadProfileToCloud(
            profileId,
            { uid: user.uid, email: user.email },
            (percent) => setSyncProgress(prev => prev ? { ...prev, percent } : null)
          );

          setSyncProgress(null);
          showToast(`"${profileName}" synchronisé`, 'success');
        } catch (error) {
          console.error('[ProfileSync] Upload failed:', error);
          setSyncProgress(null);
          showToast(`Échec sync "${profileName}"`, 'error');
        }

        // Release lock AFTER upload is done (or failed)
        try {
          await releaseProfileLock(profileId);
        } catch (error) {
          console.error('[ProfileSync] Failed to release lock:', error);
        }
      }

      isProcessing = false;
    };

    const unsubscribe = window.electronAPI.profileSync.onProfileClosed(async (profileId) => {
      const profile = profilesRef.current.find(p => p.id === profileId);
      const profileName = profile?.name || profileId;
      uploadQueue.push({ profileId, profileName });
      processQueue();
    });

    return () => unsubscribe();
  }, [user]);

  const handleLogout = async () => {
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

  const handleLaunchProfile = async (profile: any) => {
    try {
      // Check if profile is locked by another user
      if (user && isLockedByOther(profile, user.uid)) {
        showToast(`Profil utilisé par ${profile.lockedByEmail || 'un autre utilisateur'} sur ${profile.lockedByDevice || 'un autre PC'}`, 'warning');
        return;
      }

      // Acquire lock
      if (user) {
        await acquireProfileLock(profile.id, { uid: user.uid, email: user.email });
      }

      // Download from cloud if needed
      try {
        const needsDownload = await needsCloudDownload(profile);
        if (needsDownload) {
          setSyncProgress({ profileId: profile.id, percent: 0, type: 'download', profileName: profile.name });
          showToast('Téléchargement du profil depuis le cloud...', 'info');
          await downloadProfileFromCloud(
            profile.id,
            profile.cloudSyncVersion!,
            (percent) => setSyncProgress(prev => prev ? { ...prev, percent } : null)
          );
          setSyncProgress(null);
          showToast('Profil téléchargé', 'success');
        }
      } catch (dlError) {
        console.error('Cloud download failed:', dlError);
        setSyncProgress(null);
        // Continue with local data if available, or show error
        const hasLocal = await window.electronAPI?.profileSync?.hasLocalData(profile.id);
        if (!hasLocal) {
          showToast('Échec du téléchargement du profil', 'error');
          await releaseProfileLock(profile.id).catch(() => {});
          return;
        }
      }

      // Get enabled extensions and auto-download missing ones from cloud
      let extensionPaths: string[] = [];
      const enabledExts = extensions.filter(e => e.enabled);
      const enabledExtIds = enabledExts.map(e => e.id);

      if (enabledExtIds.length > 0 && window.electronAPI?.extensions) {
        const localExts = await window.electronAPI.extensions.getAll();
        const localIds = new Set(localExts.map((e: any) => e.id));
        const missing = enabledExts.filter(e => !localIds.has(e.id) && e.storageUrl);
        for (const ext of missing) {
          try {
            await window.electronAPI.extensions.downloadAndInstall(ext.id, ext.storageUrl!);
          } catch (e) {
            console.error(`Failed to download extension ${ext.name}:`, e);
          }
        }
        extensionPaths = await window.electronAPI.extensions.getPaths(enabledExtIds);
      }

      const result = await window.electronAPI.profiles.launch(profile.id, { ...profile, extensionPaths });
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
      } else {
        if (result.alreadyRunning) {
          showToast(`"${profile.name}" is already running — window focused`, 'info');
        } else {
          console.error('Launch failed:', result.error);
          showToast(`Launch failed: ${result.error}`, 'error');
          await releaseProfileLock(profile.id).catch(() => {});
        }
      }
    } catch (error) {
      console.error('Failed to launch profile:', error);
      showToast('Failed to launch browser', 'error');
      await releaseProfileLock(profile.id).catch(() => {});
    }
  };

  const [bulkLaunching, setBulkLaunching] = useState<{ total: number; current: number; name: string } | null>(null);

  const handleBulkLaunch = async (profileIds: string[]) => {
    const profilesToLaunch = visibleProfiles.filter(p => profileIds.includes(p.id));

    if (profilesToLaunch.length === 0) {
      showToast('Toutes les instances sont déjà lancées', 'info');
      return;
    }

    setBulkLaunching({ total: profilesToLaunch.length, current: 0, name: '' });

    for (let i = 0; i < profilesToLaunch.length; i++) {
      const profile = profilesToLaunch[i];
      setBulkLaunching({ total: profilesToLaunch.length, current: i + 1, name: profile.name });

      await handleLaunchProfile(profile);

      // Small delay between launches to avoid overwhelming the system
      if (i < profilesToLaunch.length - 1) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    setBulkLaunching(null);
    showToast(`${profilesToLaunch.length} instances lancées`, 'success');
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
  const visibleProfiles = profiles.filter(p => {
    if (p.deleted) return false;
    if (user?.role === 'va' && p.assignedTo !== user.uid) return false;
    return true;
  });

  const deletedProfiles = profiles.filter(p => p.deleted);

  const profileCounts = visibleProfiles.reduce((acc, profile) => {
    if (profile.folderId) {
      acc[profile.folderId] = (acc[profile.folderId] || 0) + 1;
      // Also count towards parent folder
      const folder = folders.find(f => f.id === profile.folderId);
      if (folder?.parentId) {
        acc[folder.parentId] = (acc[folder.parentId] || 0) + 1;
      }
    }
    return acc;
  }, {} as { [folderId: string]: number });

  const renderPage = () => {
    switch (activePage) {
      case 'profiles':
        return (
          <Dashboard
            profiles={visibleProfiles}
            folders={folders}
            loading={loading}
            selectedFolderId={selectedFolderId}
            onSelectFolder={setSelectedFolderId}
            settings={settings}
            onCreateProfile={handleCreateProfile}
            onUpdateProfile={handleUpdateProfile}
            onDeleteProfile={handleDeleteProfile}
            onLaunchProfile={handleLaunchProfile}
            onBulkLaunch={handleBulkLaunch}
            bulkLaunching={bulkLaunching}
            onMoveProfile={handleMoveProfile}
            onShowCreateModal={() => setShowCreateModal(true)}
            onEditProfile={(profile) => { setEditingProfile(profile); setShowCreateModal(true); }}
            onCloneProfile={handleCloneProfile}
          />
        );
      case 'proxies':
        return <ProxyManagerPage profiles={visibleProfiles} folders={folders} onUpdateProfile={handleUpdateProfile} userId={user?.uid} teamId={user?.teamId} />;
      case 'extensions':
        return <ExtensionsPage teamId={user?.teamId || ''} />;
      case 'settings':
        return <SettingsPage settings={settings} onSettingsChange={handleSettingsChange} user={user} onLogout={handleLogout} />;
      case 'activity':
        return (user?.role === 'admin' || user?.role === 'owner') ? <ActivityLogPage teamId={user?.teamId || ''} /> : null;
      case 'recycle-bin':
        return (user?.role === 'admin' || user?.role === 'owner') ? (
          <RecycleBinPage
            deletedProfiles={deletedProfiles}
            onRestore={handleRestoreProfile}
            onPermanentDelete={handlePermanentDelete}
            onEmptyBin={handleEmptyBin}
          />
        ) : null;
      case 'billing':
        return (user?.role === 'admin' || user?.role === 'owner') ? <BillingPage /> : null;
      case 'members':
        return (user?.role === 'admin' || user?.role === 'owner') ? <MembersPage teamId={user?.teamId || ''} /> : null;
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
            folders={folders}
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
