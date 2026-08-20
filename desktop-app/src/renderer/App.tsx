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
import VaManagerPage from './pages/VaManagerPage';
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
  subscribeToProxies,
  findUserByEmail,
  getTeamById,
  getTeamsByOwnerId,
  FirestoreProxy,
  createProfile as firestoreCreateProfile,
  updateProfile as firestoreUpdateProfile,
  deleteProfile as firestoreDeleteProfile,
  createFolder as firestoreCreateFolder,
  updateFolder as firestoreUpdateFolder,
  deleteFolder as firestoreDeleteFolder,
  migrateLocalProfiles,
} from './services/firestore-service';
import {
  Profile,
  Folder,
  Extension,
  Team,
  AppPage,
  AppSettings,
  AppUser,
  VaManagerAccount,
  VaManagerConnectionStatus,
  VaManagerOrganization,
} from '../types';
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
import {
  parseSessionImportFile,
  SessionImportProgress,
} from '../shared/session-import';
import { proxyIdentityKey, COMPTES_MAX_PAR_PROXY } from '../shared/proxy-identity';
import { auth } from './services/firebase';

interface AutoPostEvent {
  id: string;
  postUrl: string;
  sourceProfileId: string;
  account?: string;
  receivedAt: number;
  claimToken?: string;
}

declare global {
  interface Window {
    electronAPI: {
      getVersion: () => Promise<string>;
      diagnostics?: {
        getEnvironment: () => Promise<any>;
      };
      vaManager: {
        status: () => Promise<VaManagerConnectionStatus>;
        connect: (email: string, password: string) => Promise<VaManagerConnectionStatus>;
        disconnect: () => Promise<boolean>;
        listOrganizations: () => Promise<VaManagerOrganization[]>;
        listAccounts: (organizationId?: string) => Promise<VaManagerAccount[]>;
        syncProfileCookies: (
          profileId: string,
          accountId: string,
          organizationId?: string
        ) => Promise<{ success: boolean; reason?: string }>;
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
      sessionImport?: {
        run: (
          profileData: any,
          credentials: { username: string; password: string; totpSecret: string }
        ) => Promise<{ status: 'success' | 'manual' | 'failed'; message: string }>;
        runVaManager: (
          profileData: any,
          organizationId: string,
          accountId: string
        ) => Promise<{ status: 'success' | 'manual' | 'failed'; message: string }>;
        stop: (profileId?: string) => Promise<boolean>;
        onStatus: (callback: (payload: {
          profileId: string;
          attemptId: string;
          status: SessionImportProgress['status'];
          message: string;
        }) => void) => () => void;
      };
      /** Ce que chaque instance fait pendant un tour Open Post. */
      openPost?: {
        onEvent: (callback: (payload: {
          profileId: string;
          event: string;
          status: string;
          raison: string;
          cause?: string;
          apercu?: string;
          retweet?: boolean;
          like?: boolean;
        }) => void) => () => void;
        dejaFait: (tweet: string) => Promise<string[]>;
        registre: (tweet: string) => Promise<any>;
      };
      /** La sante des proxys, testee avant chaque tour. */
      proxysSante?: {
        tester: (proxy: any) => Promise<{ cle: string; ok: boolean; enPanne: boolean }>;
        etat: () => Promise<Record<string, any>>;
        enPanne: (proxy: any) => Promise<boolean>;
      };
      autoPost?: {
        onEvent: (callback: (payload: AutoPostEvent) => void) => () => void;
        claimNext: (payload: {
          idToken: string;
          teamId: string;
          installationId: string;
        }) => Promise<{ ok: true; event: AutoPostEvent | null }>;
        complete: (payload: {
          idToken: string;
          teamId: string;
          installationId: string;
          eventId: string;
          claimToken: string;
          success: boolean;
        }) => Promise<{ ok: true }>;
      };
      folders: {
        getAll: () => Promise<Folder[]>;
        create: (folderData: any) => Promise<Folder>;
        update: (folderId: string, folderData: any) => Promise<Folder>;
        delete: (folderId: string) => Promise<boolean>;
      };
      fingerprint: {
        generate: (os?: string, browserType?: string, countryCode?: string) => Promise<any>;
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
        hasAuthenticatedXSnapshot: (profileId: string) => Promise<boolean>;
        getLocalSyncVersion: (profileId: string) => Promise<number>;
        setLocalSyncVersion: (profileId: string, version: number) => Promise<boolean>;
        getLocalSyncRevision: (profileId: string) => Promise<string | null>;
        setLocalSyncRevision: (profileId: string, revision: string) => Promise<boolean>;
        setBusy: (busy: boolean) => Promise<boolean>;
        downloadFromCloud: (profileId: string, url: string, idToken: string) => Promise<Uint8Array>;
        onDownloadProgress: (callback: (profileId: string, percent: number) => void) => () => void;
        getHostname: () => Promise<string>;
        getInstallationId: () => Promise<string>;
        onProfileClosed: (
          callback: (
            profileId: string,
            details?: {
              syncEligible?: boolean;
              launchMode?: string;
              requiresPortableAuth?: boolean;
              reason?: string;
            }
          ) => void
        ) => () => void;
        onAuthenticatedXSnapshotSaved: (
          callback: (profileId: string) => void
        ) => () => void;
        onVaManagerCookieSync: (
          callback: (payload: {
            profileId: string;
            success: boolean;
            cookieCount?: number;
            error?: string;
          }) => void
        ) => () => void;
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
  autoPostEnabled: false,
};

function App() {
  const { showToast } = useToast();
  const [user, setUser] = useState<AppUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [activeWorkspaceTeamId, setActiveWorkspaceTeamId] = useState<string | null>(null);
  const [activeWorkspaceTeamIds, setActiveWorkspaceTeamIds] = useState<string[]>([]);
  const [activeWorkspaceLabel, setActiveWorkspaceLabel] = useState('');
  const [proxies, setProxies] = useState<FirestoreProxy[]>([]);
  const [loading, setLoading] = useState(true);
  const [activePage, setActivePage] = useState<AppPage>('profiles');
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [activeProfiles, setActiveProfiles] = useState<string[]>([]);
  const runtimeDetectedProfilesRef = useRef<Set<string>>(new Set());
  const confirmedXSessionProfilesRef = useRef<Set<string>>(new Set());
  const [sessionImportProgress, setSessionImportProgress] = useState<SessionImportProgress | null>(null);
  const sessionImportRunRef = useRef<{ cancelled: boolean; profileId?: string } | null>(null);
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
      for (const profileId of nextActiveProfiles) {
        confirmedXSessionProfilesRef.current.delete(profileId);
      }
      setActiveProfiles(Array.from(new Set([
        ...nextActiveProfiles,
        ...runtimeDetectedProfilesRef.current,
      ])));
    });
    return () => cleanup();
  }, []);

  useEffect(() => {
    const subscribe = window.electronAPI.profileSync?.onAuthenticatedXSnapshotSaved;
    if (!subscribe) return;

    return subscribe((profileId) => {
      if (confirmedXSessionProfilesRef.current.has(profileId)) return;
      confirmedXSessionProfilesRef.current.add(profileId);
      const profile = profiles.find(candidate => candidate.id === profileId);
      showToast(
        `"${profile?.name || profileId}" : session X enregistrée`,
        'success'
      );
    });
  }, [profiles, showToast]);

  useEffect(() => {
    const subscribe = window.electronAPI.profileSync?.onVaManagerCookieSync;
    if (!subscribe) return;

    return subscribe((payload) => {
      const profile = profiles.find(candidate => candidate.id === payload.profileId);
      if (payload.success) {
        window.dispatchEvent(new CustomEvent('spectra:va-manager-cookies-synced'));
        showToast(
          `"${profile?.name || payload.profileId}" : cookies envoyés à VA Manager`,
          'success'
        );
      } else {
        showToast(
          `"${profile?.name || payload.profileId}" : ${payload.error || 'envoi VA Manager impossible'}`,
          'error'
        );
      }
    });
  }, [profiles, showToast]);

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

  useEffect(() => {
    if (!user) {
      setActiveWorkspaceTeamId(null);
      setActiveWorkspaceTeamIds([]);
      return;
    }
    if (user.role !== 'super_admin') {
      setActiveWorkspaceTeamId(user.teamId);
      setActiveWorkspaceTeamIds([user.teamId]);
      setActiveWorkspaceLabel(user.displayName ? `${user.displayName} — ${user.email}` : user.email);
      return;
    }
    const saved = localStorage.getItem(`spectra-active-workspace:${user.uid}`);
    const primaryTeamId = saved || user.teamId;
    const savedTeamIds = localStorage.getItem(`spectra-active-workspace-teams:${user.uid}`);
    let parsedTeamIds: string[] = [];
    try {
      parsedTeamIds = savedTeamIds ? JSON.parse(savedTeamIds) : [];
    } catch {}
    setActiveWorkspaceTeamId(primaryTeamId);
    setActiveWorkspaceTeamIds(parsedTeamIds.length ? parsedTeamIds : [primaryTeamId]);
    setActiveWorkspaceLabel(
      localStorage.getItem(`spectra-active-workspace-label:${user.uid}`) ||
      (user.displayName ? `${user.displayName} — ${user.email}` : user.email)
    );
  }, [user]);

  useEffect(() => {
    if (!activeWorkspaceTeamId) {
      setTeams([]);
      return;
    }
    let cancelled = false;
    getTeamById(activeWorkspaceTeamId)
      .then(async team => {
        if (!team || cancelled) {
          if (!cancelled) setTeams([]);
          return;
        }
        const workspaceTeams = user?.role === 'super_admin'
          ? await getTeamsByOwnerId(team.ownerId)
          : [team];
        if (cancelled) return;
        const resolvedTeams = workspaceTeams.length ? workspaceTeams : [team];
        const resolvedTeamIds = Array.from(new Set(resolvedTeams.map(item => item.id)));
        setTeams(resolvedTeams);
        setActiveWorkspaceTeamIds(resolvedTeamIds);
        if (user?.role === 'super_admin') {
          localStorage.setItem(`spectra-active-workspace-teams:${user.uid}`, JSON.stringify(resolvedTeamIds));
        }
      })
      .catch(() => {
        if (!cancelled) setTeams([]);
      });
    return () => { cancelled = true; };
  }, [activeWorkspaceTeamId, user]);

  useEffect(() => {
    const workspaceEmail = settings.activeWorkspaceEmail?.trim().toLowerCase();
    if (!user || user.role !== 'super_admin' || !workspaceEmail) return;
    let cancelled = false;
    const openConfiguredWorkspace = async () => {
      try {
        const workspaceUser = await findUserByEmail(workspaceEmail);
        if (!workspaceUser?.teamId || cancelled) return;
        const currentTeam = await getTeamById(workspaceUser.teamId);
        const ownerId = currentTeam?.ownerId || workspaceUser.uid;
        const ownerTeams = await getTeamsByOwnerId(ownerId);
        if (cancelled) return;
        const workspaceTeamIds = Array.from(new Set([
          workspaceUser.teamId,
          ...ownerTeams.map(team => team.id),
        ]));
        const label = workspaceUser.displayName
          ? `${workspaceUser.displayName} — ${workspaceUser.email}`
          : workspaceUser.email;
        setActiveWorkspaceTeamId(workspaceUser.teamId);
        setActiveWorkspaceTeamIds(workspaceTeamIds);
        setActiveWorkspaceLabel(label);
        localStorage.setItem(`spectra-active-workspace:${user.uid}`, workspaceUser.teamId);
        localStorage.setItem(`spectra-active-workspace-teams:${user.uid}`, JSON.stringify(workspaceTeamIds));
        localStorage.setItem(`spectra-active-workspace-label:${user.uid}`, label);
        setSelectedFolderId(null);
        setActivePage('profiles');
      } catch (error) {
        console.error('Failed to open configured workspace:', error);
      }
    };
    openConfiguredWorkspace();
    return () => { cancelled = true; };
  }, [user, settings.activeWorkspaceEmail]);

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
    if (!user || !activeWorkspaceTeamId) return;
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

    const scopeTeamId = activeWorkspaceTeamIds.length ? activeWorkspaceTeamIds : [activeWorkspaceTeamId];
    const assignedFolderScope = user.role === 'va' ? user.assignedFolderId : null;

    // Subscribe to Firestore collections (super admin = global, others = scoped by teamId)
    const unsubProfiles = subscribeToProfiles(scopeTeamId, (allProfiles) => {
      setProfiles(allProfiles);
      setLoading(false);
    }, assignedFolderScope);

    const unsubFolders = subscribeToFolders(scopeTeamId, (allFolders) => {
      setFolders(allFolders);
    }, assignedFolderScope);

    const unsubExtensions = subscribeToExtensions(activeWorkspaceTeamId, (allExtensions) => {
      setExtensions(allExtensions);
    });
    const unsubProxies = subscribeToProxies(scopeTeamId, setProxies);

    return () => {
      unsubProfiles();
      unsubFolders();
      unsubExtensions();
      unsubProxies();
    };
  }, [user, activeWorkspaceTeamId, activeWorkspaceTeamIds]);

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

  const profileRuntimeScopeKey = profiles.map(profile => profile.id).sort().join('|');
  useEffect(() => {
    if (
      !user ||
      !currentDeviceName ||
      profiles.length === 0 ||
      !window.electronAPI.profiles.getRunning
    ) return;

    let disposed = false;

    const reconcileLocalRuntimePresence = async () => {
      const currentProfiles = profilesRef.current;
      const profileIds = currentProfiles.map(profile => profile.id);
      if (profileIds.length === 0) return;

      try {
        const [trackedProfileIds, detectedProfileIds] = await Promise.all([
          window.electronAPI.profiles.getActive(),
          window.electronAPI.profiles.getRunning!(profileIds),
        ]);
        if (disposed) return;

        runtimeDetectedProfilesRef.current = new Set(detectedProfileIds);
        setActiveProfiles(Array.from(new Set([
          ...trackedProfileIds,
          ...detectedProfileIds,
        ])));

        await Promise.allSettled(detectedProfileIds.map(async profileId => {
          const profile = profilesRef.current.find(item => item.id === profileId);
          if (!profile) return;

          const lockOwnedByThisInstallation = profile.lockedBy === user.uid && (
            profile.lockedByInstallationId
              ? profile.lockedByInstallationId === currentInstallationId
              : (!profile.lockedByDevice || profile.lockedByDevice === currentDeviceName)
          );
          if (lockOwnedByThisInstallation) return;
          if (isLockedByOther(profile, user.uid, currentDeviceName, currentInstallationId)) return;

          await acquireProfileLock(
            profileId,
            { uid: user.uid, email: user.email },
            currentInstallationId
          );
          console.log(`[RuntimePresence] Restored cloud presence for "${profile.name}"`);
        }));
      } catch (error) {
        console.error('[RuntimePresence] Could not reconcile local Chrome processes:', error);
      }
    };

    reconcileLocalRuntimePresence();
    const interval = window.setInterval(reconcileLocalRuntimePresence, 30000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [
    user?.uid,
    user?.email,
    currentDeviceName,
    currentInstallationId,
    profileRuntimeScopeKey,
  ]);

  // Non-destructive migration: promote existing portable authenticated cookies
  // to the protected snapshot format. Cloud data is not changed here; the next
  // verified profile close uploads it through sync protocol v2.
  const authSnapshotBackfillKey = useRef('');
  useEffect(() => {
    if (!window.electronAPI.profileSync?.hasAuthenticatedXSnapshot || profiles.length === 0) return;
    const xProfileIds = profiles
      .filter(profile =>
        profile.platform === 'twitter' ||
        /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(profile.lastUrl || '')
      )
      .map(profile => profile.id)
      .sort();
    const migrationKey = xProfileIds.join(',');
    if (!migrationKey || authSnapshotBackfillKey.current === migrationKey) return;
    authSnapshotBackfillKey.current = migrationKey;

    Promise.allSettled(
      xProfileIds.map(profileId =>
        window.electronAPI.profileSync!.hasAuthenticatedXSnapshot(profileId)
      )
    ).then(results => {
      const protectedCount = results.filter(
        result => result.status === 'fulfilled' && result.value === true
      ).length;
      console.log(
        `[ProfileSync] Protected authentication migration: ${protectedCount}/${xProfileIds.length}`
      );
    });
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
    const notifiedSyncFailures = new Set<string>();

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
            const queuedProfile = profilesRef.current.find(p => p.id === profileId);
            const localVersion = Number(
              await window.electronAPI.profileSync.getLocalSyncVersion(profileId) || 0
            );
            const localRevision = await window.electronAPI.profileSync.getLocalSyncRevision(profileId);
            const cloudVersion = Number(queuedProfile?.cloudSyncVersion || 0);
            const cloudRevision = queuedProfile?.cloudSyncRevision || null;
            const hasNoActiveLock = !queuedProfile?.lockedBy;
            const alreadyCommitted = hasNoActiveLock &&
              localVersion === cloudVersion &&
              Boolean(localRevision) &&
              localRevision === cloudRevision;

            // A successful upload can be acknowledged by Firestore while the
            // renderer misses the final queue cleanup (shutdown/network loss).
            // Do not retry that stale item forever once local and cloud point
            // to the exact same immutable revision and no device owns the lock.
            if (alreadyCommitted) {
              uploadQueue.shift();
              persistQueue();
              notifiedSyncFailures.delete(profileId);
              setSyncProgress(null);
              console.log(`[ProfileSync] Removed already committed queue item for ${profileId}`);
              continue;
            }
            const requiresPortableAuth = queuedProfile?.platform === 'twitter' ||
              /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(queuedProfile?.lastUrl || '');
            if (requiresPortableAuth) {
              const portableAuthReady =
                await window.electronAPI.profileSync.hasAuthenticatedXSnapshot(profileId);
              if (!portableAuthReady) {
                uploadQueue.shift();
                persistQueue();
                await releaseProfileLock(profileId, {
                  uid: user.uid,
                  deviceName: currentDeviceName,
                  installationId: currentInstallationId,
                }).catch(() => {});
                showToast(
                  `"${profileName}" non envoyé : pas de session X dans ce profil. ` +
                  `La version du cloud est préservée.`,
                  'warning'
                );
                continue;
              }
            }
            setSyncProgress({ profileId, percent: 0, type: 'upload', profileName });
            await uploadProfileToCloud(
              profileId,
              {
                uid: user.uid,
                email: user.email,
                deviceName: currentDeviceName,
                installationId: currentInstallationId,
              },
              (percent) => setSyncProgress(prev => prev ? { ...prev, percent } : null)
            );
            await releaseProfileLock(profileId, {
              uid: user.uid,
              deviceName: currentDeviceName,
              installationId: currentInstallationId,
            });
            uploadQueue.shift();
            persistQueue();
            notifiedSyncFailures.delete(profileId);
            setSyncProgress(null);
            showToast(`"${profileName}" synchronized`, 'success');
          } catch (error) {
            console.error('[ProfileSync] Upload failed; lock retained:', error);
            setSyncProgress(null);
            const errorCode = (error as { code?: string })?.code;
            const errorMessage = error instanceof Error ? error.message : '';
            const isConflict = errorCode === 'profile-sync/conflict' ||
              errorMessage.includes('changed on another device');
            if (isConflict) {
              uploadQueue.shift();
              persistQueue();
              await releaseProfileLock(profileId, {
                uid: user.uid,
                deviceName: currentDeviceName,
                installationId: currentInstallationId,
              }).catch(() => {});
              showToast(
                `"${profileName}" changed on another device — stale local data was not uploaded`,
                'warning'
              );
              continue;
            }
            // Un profil local incomplet ne guerira pas en reessayant : Chrome
            // n'a pas ecrit ses preferences et ne les ecrira plus, le profil
            // etant ferme. On abandonne l'envoi pour preserver la version du
            // cloud, mais on relache le verrou -- sinon le profil deviendrait
            // impossible a ouvrir sur les autres machines.
            // Le code d'erreur ne traverse pas la frontiere entre les deux
            // processus : seul le message arrive. On reconnait donc les deux.
            if (
              errorCode === 'profile-sync/incomplete-local' ||
              errorMessage.includes('profile-sync/incomplete-local')
            ) {
              uploadQueue.shift();
              persistQueue();
              await releaseProfileLock(profileId, {
                uid: user.uid,
                deviceName: currentDeviceName,
                installationId: currentInstallationId,
              }).catch(() => {});
              showToast(
                `"${profileName}" non synchronisé : données locales incomplètes. ` +
                "La version du cloud est intacte, rouvrez puis refermez l'instance normalement.",
                'warning'
              );
              continue;
            }
            if (!notifiedSyncFailures.has(profileId)) {
              notifiedSyncFailures.add(profileId);
              showToast(`Sync failed for "${profileName}" - retry scheduled`, 'error');
            }
            retryTimer = window.setTimeout(processQueue, 30000);
            break;
          }
        }
      } finally {
        isProcessing = false;
        await window.electronAPI.profileSync?.setBusy(false).catch(() => {});
      }
    };

    const unsubscribe = window.electronAPI.profileSync.onProfileClosed(async (profileId, details) => {
      if (details?.syncEligible === false) {
        console.warn(`[ProfileSync] Ignored ineligible close event for ${profileId}: ${details.reason || 'unknown'}`);
        uploadQueue = uploadQueue.filter(item => item.profileId !== profileId);
        persistQueue();
        await releaseProfileLock(profileId, {
          uid: user.uid,
          deviceName: currentDeviceName,
          installationId: currentInstallationId,
        }).catch(() => {});
        if (details.reason === 'missing-authenticated-x-snapshot') {
          const profile = profilesRef.current.find(p => p.id === profileId);
          showToast(
            `"${profile?.name || profileId}" non envoyé : pas de session X dans ce profil. ` +
            `La version du cloud est préservée.`,
            'warning'
          );
        }
        return;
      }
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

  useEffect(() => {
    if (!window.electronAPI.sessionImport?.onStatus) return;
    return window.electronAPI.sessionImport.onStatus((payload) => {
      setSessionImportProgress(previous => {
        if (!previous?.running || previous.profileId !== payload.profileId) return previous;
        return {
          ...previous,
          status: payload.status,
          message: payload.message || previous.message,
        };
      });
    });
  }, []);

  const handleStopSessionImport = async () => {
    const run = sessionImportRunRef.current;
    if (!run) return;
    run.cancelled = true;
    setSessionImportProgress(previous => previous ? {
      ...previous,
      running: false,
      status: 'stopped',
      message: 'Import arrêté',
    } : previous);
    await window.electronAPI.sessionImport?.stop(run.profileId).catch(() => {});
    showToast('Import des sessions arrêté', 'info');
  };

  /**
   * Rassemble assez de places proxy pour les comptes a creer.
   *
   * Les proxys etaient testes un par un, tous, avant d'ouvrir la moindre
   * fenetre. Avec 65 proxys et dix secondes d'attente maximum chacun, creer un
   * seul compte pouvait demander plusieurs minutes d'immobilite -- pour un
   * besoin d'une place.
   *
   * Deux changements : les tests partent par lots, puisqu'ils sont
   * independants, et on s'arrete des qu'il y a assez de places.
   */
  const rassemblerPlacesProxy = async (
    candidats: FirestoreProxy[],
    usageByProxy: Map<string, number>,
    placesVoulues: number,
    estAnnule: () => boolean
  ): Promise<FirestoreProxy[]> => {
    const TAILLE_LOT = 8;
    const places: FirestoreProxy[] = [];

    // On termine ce qui est commence avant d'entamer du neuf : les proxys les
    // plus remplis passent en premier. Sans ce tri, l'ordre venait de la base
    // de donnees et Spectra pouvait ouvrir un proxy vierge alors qu'un autre
    // n'attendait qu'un compte pour etre plein -- le parc se consommait bien
    // plus vite que necessaire.
    //
    // Le tri ne dispense de rien : chaque proxy est teste avant d'etre
    // attribue, et un proxy muet est ecarte quel que soit son remplissage.
    const parRemplissage = [...candidats].sort((a, b) =>
      (usageByProxy.get(proxyIdentityKey(b)) || 0) - (usageByProxy.get(proxyIdentityKey(a)) || 0)
    );

    for (let debut = 0; debut < parRemplissage.length; debut += TAILLE_LOT) {
      if (estAnnule() || places.length >= placesVoulues) break;
      const lot = parRemplissage.slice(debut, debut + TAILLE_LOT);
      const resultats = await Promise.all(lot.map(async (proxy) => {
        try {
          const reponse: any = await window.electronAPI.proxy.test(proxy);
          const sain = typeof reponse === 'boolean' ? reponse : reponse?.isHealthy === true;
          return { proxy, sain };
        } catch {
          return { proxy, sain: false };
        }
      }));
      for (const { proxy, sain } of resultats) {
        if (!sain) continue;
        const restant = Math.max(
          0,
          COMPTES_MAX_PAR_PROXY - (usageByProxy.get(proxyIdentityKey(proxy)) || 0)
        );
        for (let index = 0; index < restant; index++) places.push(proxy);
      }
    }
    return places;
  };

  const handleImportSessions = async (content: string, fileName: string) => {
    if (!user || !window.electronAPI.sessionImport || sessionImportRunRef.current) {
      showToast('Un import de sessions est déjà en cours', 'warning');
      return;
    }

    let accounts;
    try {
      accounts = parseSessionImportFile(content);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Fichier de sessions invalide', 'error');
      return;
    }

    const usageByProxy = new Map<string, number>();
    for (const profile of profiles.filter(profile => !profile.deleted && profile.proxy?.host)) {
      const key = proxyIdentityKey(profile.proxy!);
      usageByProxy.set(key, (usageByProxy.get(key) || 0) + 1);
    }
    const uniqueCandidates = new Map<string, FirestoreProxy>();
    for (const proxy of proxies) {
      const key = proxyIdentityKey(proxy);
      if ((usageByProxy.get(key) || 0) < COMPTES_MAX_PAR_PROXY && !uniqueCandidates.has(key)) {
        uniqueCandidates.set(key, proxy);
      }
    }
    const candidates = Array.from(uniqueCandidates.values());

    setSessionImportProgress({
      running: true,
      total: accounts.length,
      current: 0,
      status: 'testing-proxy',
      message: 'Test des proxies disponibles',
    });
    const run = { cancelled: false, profileId: undefined as string | undefined };
    sessionImportRunRef.current = run;

    try {
      const validSlots = await rassemblerPlacesProxy(
        candidates, usageByProxy, accounts.length, () => run.cancelled
      );
      if (validSlots.length < accounts.length) {
        setSessionImportProgress({
          running: false,
          total: accounts.length,
          current: 0,
          status: 'failed',
          message: `Capacité proxy insuffisante (${validSlots.length}/${accounts.length})`,
        });
        showToast(
          `Import annulé : capacité insuffisante de proxies valides (${COMPTES_MAX_PAR_PROXY} comptes maximum par proxy)`,
          'error'
        );
        return;
      }

      let successful = 0;
      let failed = 0;
      for (let index = 0; index < accounts.length; index++) {
        if (run.cancelled) return;
        const account = accounts[index];
        const proxy = validSlots[index];
        setSessionImportProgress({
          running: true,
          total: accounts.length,
          current: index + 1,
          username: account.username,
          status: 'creating',
          message: `Création du profil ${index + 1}/${accounts.length}`,
        });

        const fingerprint = await window.electronAPI.fingerprint.generate(
          'windows',
          'chrome',
          proxy.country || 'US'
        );
        const usFingerprint = {
          ...(fingerprint || {}),
          language: 'en-US',
          languages: ['en-US', 'en'],
        };
        const proxyData = {
          type: proxy.type,
          host: proxy.host,
          port: proxy.port,
          username: proxy.username,
          password: proxy.password,
          country: proxy.country || 'US',
        };
        const profile = await firestoreCreateProfile({
          name: `X — ${account.username}`,
          platform: 'twitter',
          userAgent: usFingerprint.userAgent || '',
          timezone: usFingerprint.timezone || 'UTC',
          language: 'en-US',
          screenResolution: usFingerprint.screenResolution || '1920x1080',
          fingerprint: usFingerprint,
          os: (usFingerprint as any).os || 'windows',
          browserType: 'chrome',
          connectionType: 'proxy',
          connectionConfig: { type: 'proxy', proxy: proxyData },
          proxy: proxyData,
          folderId: selectedFolderId || undefined,
          lastUrl: 'https://x.com/home',
          status: 'none',
          tags: ['session-import'],
          createdAt: new Date().toISOString(),
        } as any, user.uid, activeWorkspaceTeamId || user.teamId);
        run.profileId = profile.id;
        await acquireProfileLock(
          profile.id,
          { uid: user.uid, email: user.email },
          currentInstallationId
        );

        setSessionImportProgress(previous => previous ? {
          ...previous,
          profileId: profile.id,
          status: 'launching',
          message: 'Ouverture de X',
        } : previous);
        const result = await window.electronAPI.sessionImport.run(profile, account);
        account.password = '';
        account.totpSecret = '';

        if (result.status === 'manual') {
          setSessionImportProgress(previous => previous ? {
            ...previous,
            running: false,
            status: 'manual',
            message: result.message || 'Vérification manuelle requise — fenêtre laissée ouverte',
          } : previous);
          showToast('Import en pause : terminez la vérification manuellement dans la fenêtre ouverte', 'warning');
          return;
        }
        if (result.status === 'success') successful++;
        else failed++;
        run.profileId = undefined;
      }

      setSessionImportProgress({
        running: false,
        total: accounts.length,
        current: accounts.length,
        status: failed ? 'failed' : 'success',
        message: `${successful} session(s) importée(s), ${failed} échec(s)`,
      });
      showToast(
        `${successful} session(s) importée(s) depuis ${fileName}${failed ? `, ${failed} échec(s)` : ''}`,
        failed ? 'warning' : 'success'
      );
    } catch (error) {
      console.error('[SessionImport] Import failed without credential details:', error);
      setSessionImportProgress(previous => previous ? {
        ...previous,
        running: false,
        status: 'failed',
        message: 'Import interrompu par une erreur',
      } : previous);
      showToast('L’import des sessions a échoué', 'error');
      if (run.profileId) {
        await window.electronAPI.sessionImport.stop(run.profileId).catch(() => {});
      }
    } finally {
      for (const account of accounts) {
        account.password = '';
        account.totpSecret = '';
      }
      if (sessionImportRunRef.current === run) sessionImportRunRef.current = null;
    }
  };

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
        teamId: activeWorkspaceTeamId || user.teamId,
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
      const newProfile = await firestoreCreateProfile(profileData, user!.uid, activeWorkspaceTeamId || user!.teamId);
      showToast(`"${newProfile.name}" created`, 'success');
      if (user) {
        logActivity({
          teamId: activeWorkspaceTeamId || user.teamId,
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

  const handleUpdateVaManagerLink = async (
    profileId: string,
    profileData: Partial<Profile>
  ) => {
    try {
      await firestoreUpdateProfile(profileId, profileData);
      showToast(
        profileData.vaManagerAccountId ? 'Liaison VA Manager enregistrée' : 'Liaison VA Manager supprimée',
        'success'
      );
    } catch (error) {
      console.error('Failed to update VA Manager link:', error);
      showToast('Impossible d’enregistrer la liaison VA Manager', 'error');
      throw error;
    }
  };

  const handleCreateVaManagerInstances = async (
    accounts: VaManagerAccount[],
    organizationId: string,
    // Le dossier est demande au moment de creer. Avant, l'instance atterrissait
    // dans celui qui se trouvait selectionne dans la barre de gauche, sans que
    // personne ne l'ait choisi ni ne le voie.
    folderId?: string | null
  ): Promise<{ successful: number; failed: number; manual: boolean; message: string }> => {
    if (!user || !window.electronAPI.sessionImport?.runVaManager) {
      throw new Error('Connexion automatique VA Manager indisponible');
    }
    if (sessionImportRunRef.current) {
      throw new Error('Une création ou connexion est déjà en cours');
    }

    const existingAccountIds = new Set(
      profiles
        .filter(profile => !profile.deleted && profile.vaManagerAccountId)
        .map(profile => profile.vaManagerAccountId as string)
    );
    const pendingAccounts = accounts.filter(account => !existingAccountIds.has(account.id));
    if (pendingAccounts.length === 0) {
      return {
        successful: 0,
        failed: 0,
        manual: false,
        message: 'Toutes les instances sélectionnées existent déjà',
      };
    }

    const usageByProxy = new Map<string, number>();
    for (const profile of profiles.filter(profile => !profile.deleted && profile.proxy?.host)) {
      const key = proxyIdentityKey(profile.proxy!);
      usageByProxy.set(key, (usageByProxy.get(key) || 0) + 1);
    }
    const uniqueCandidates = new Map<string, FirestoreProxy>();
    for (const proxy of proxies) {
      const key = proxyIdentityKey(proxy);
      if ((usageByProxy.get(key) || 0) < COMPTES_MAX_PAR_PROXY && !uniqueCandidates.has(key)) {
        uniqueCandidates.set(key, proxy);
      }
    }

    setSessionImportProgress({
      running: true,
      total: pendingAccounts.length,
      current: 0,
      status: 'testing-proxy',
      message: 'Vérification de la capacité des proxies',
    });
    const run = { cancelled: false, profileId: undefined as string | undefined };
    let currentCreatedProfile: Profile | null = null;
    sessionImportRunRef.current = run;

    try {
      const validSlots = await rassemblerPlacesProxy(
        Array.from(uniqueCandidates.values()),
        usageByProxy,
        pendingAccounts.length,
        () => run.cancelled
      );
      if (validSlots.length === 0) {
        throw new Error(
          'Aucune place proxy valide disponible'
        );
      }

      const accountsToProcess = pendingAccounts.slice(0, validSlots.length);
      const deferredCount = pendingAccounts.length - accountsToProcess.length;
      let successful = 0;
      let failed = 0;
      for (let index = 0; index < accountsToProcess.length; index++) {
        if (run.cancelled) break;
        const account = accountsToProcess[index];
        const proxy = validSlots[index];
        setSessionImportProgress({
          running: true,
          total: accountsToProcess.length,
          current: index + 1,
          username: account.username,
          status: 'creating',
          message: `Création de @${account.username} (${index + 1}/${accountsToProcess.length})`,
        });

        const fingerprint = await window.electronAPI.fingerprint.generate(
          'windows',
          'chrome',
          proxy.country || 'US'
        );
        const usFingerprint = {
          ...(fingerprint || {}),
          language: 'en-US',
          languages: ['en-US', 'en'],
        };
        const proxyData = {
          type: proxy.type,
          host: proxy.host,
          port: proxy.port,
          username: proxy.username,
          password: proxy.password,
          country: proxy.country || 'US',
        };
        const profile = await firestoreCreateProfile({
          name: `X — ${account.username}`,
          platform: 'twitter',
          vaManagerAccountId: account.id,
          vaManagerOrganizationId: account.organizationId || organizationId,
          vaManagerLoginStatus: 'pending',
          vaManagerLoginMessage: 'Première connexion en attente',
          userAgent: usFingerprint.userAgent || '',
          timezone: usFingerprint.timezone || 'UTC',
          language: 'en-US',
          screenResolution: usFingerprint.screenResolution || '1920x1080',
          fingerprint: usFingerprint,
          os: (usFingerprint as any).os || 'windows',
          browserType: 'chrome',
          connectionType: 'proxy',
          connectionConfig: { type: 'proxy', proxy: proxyData },
          proxy: proxyData,
          // '__none__' veut dire « hors dossier » : c'est un choix explicite,
          // pas une absence de reponse.
          folderId: folderId === '__none__' ? undefined : (folderId || undefined),
          lastUrl: 'https://x.com/home',
          status: 'none',
          tags: ['va-manager'],
          createdAt: new Date().toISOString(),
        } as any, user.uid, activeWorkspaceTeamId || user.teamId);
        currentCreatedProfile = profile;
        run.profileId = profile.id;

        logActivity({
          teamId: activeWorkspaceTeamId || user.teamId,
          userId: user.uid,
          userName: user.email,
          action: 'profile_created',
          targetProfileId: profile.id,
          targetProfileName: profile.name,
          timestamp: new Date().toISOString(),
          metadata: { source: 'va-manager', vaManagerAccountId: account.id },
        }).catch(() => {});

        await acquireProfileLock(
          profile.id,
          { uid: user.uid, email: user.email },
          currentInstallationId
        );
        setSessionImportProgress(previous => previous ? {
          ...previous,
          profileId: profile.id,
          status: 'launching',
          message: `Première connexion de @${account.username}`,
        } : previous);

        let result: { status: 'success' | 'manual' | 'failed'; message: string };
        try {
          result = await window.electronAPI.sessionImport.runVaManager(
            profile,
            organizationId,
            account.id
          );
        } catch (connectionError) {
          failed++;
          const connectionMessage = connectionError instanceof Error
            ? connectionError.message
            : 'Connexion X interrompue';
          await firestoreUpdateProfile(profile.id, {
            vaManagerLoginStatus: 'failed',
            vaManagerLoginMessage: connectionMessage,
            vaManagerLastLoginAt: new Date().toISOString(),
          }).catch(() => {});
          await window.electronAPI.sessionImport.stop(profile.id).catch(() => {});
          run.profileId = undefined;
          currentCreatedProfile = null;
          continue;
        }
        if (result.status === 'manual') {
          await firestoreUpdateProfile(profile.id, {
            vaManagerLoginStatus: 'manual',
            vaManagerLoginMessage: result.message || 'Vérification manuelle requise',
            vaManagerLastLoginAt: new Date().toISOString(),
          });
          setSessionImportProgress(previous => previous ? {
            ...previous,
            running: false,
            status: 'manual',
            message: result.message || 'Vérification manuelle requise',
          } : previous);
          return {
            successful,
            failed,
            manual: true,
            message: `Vérification manuelle requise pour @${account.username}`,
          };
        }
        if (result.status === 'success') {
          successful++;
          await firestoreUpdateProfile(profile.id, {
            vaManagerLoginStatus: 'connected',
            vaManagerLoginMessage: result.message || 'Connexion X confirmée',
            vaManagerLastLoginAt: new Date().toISOString(),
            // Le compte est authentifie et utilisable : la colonne Account le
            // dit sans qu'on ait a le poser a la main.
            status: 'active',
          });
        } else {
          failed++;
          await firestoreUpdateProfile(profile.id, {
            vaManagerLoginStatus: 'failed',
            vaManagerLoginMessage: result.message || 'Connexion X non confirmée',
            vaManagerLastLoginAt: new Date().toISOString(),
          });
        }
        run.profileId = undefined;
        currentCreatedProfile = null;
      }

      const message = `${successful} instance(s) créée(s) et connectée(s)` +
        (failed ? `, ${failed} échec(s)` : '') +
        (deferredCount ? `, ${deferredCount} en attente de proxy` : '');
      setSessionImportProgress({
        running: false,
        total: accountsToProcess.length,
        current: accountsToProcess.length,
        status: failed ? 'failed' : 'success',
        message,
      });
      showToast(message, failed ? 'warning' : 'success');
      return { successful, failed, manual: false, message };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Création VA Manager interrompue';
      setSessionImportProgress(previous => previous ? {
        ...previous,
        running: false,
        status: 'failed',
        message,
      } : previous);
      showToast(message, 'error');
      if (currentCreatedProfile) {
        await firestoreUpdateProfile(currentCreatedProfile.id, {
          vaManagerLoginStatus: 'failed',
          vaManagerLoginMessage: message,
          vaManagerLastLoginAt: new Date().toISOString(),
        }).catch(() => {});
      }
      if (run.profileId) {
        await window.electronAPI.sessionImport.stop(run.profileId).catch(() => {});
      }
      throw error;
    } finally {
      if (sessionImportRunRef.current === run) sessionImportRunRef.current = null;
    }
  };

  const handleRetryVaManagerConnection = async (
    account: VaManagerAccount,
    organizationId: string,
    profile: Profile
  ): Promise<{ status: 'success' | 'manual' | 'failed'; message: string }> => {
    if (!user || !window.electronAPI.sessionImport?.runVaManager) {
      throw new Error('Connexion automatique VA Manager indisponible');
    }
    if (!profile.proxy?.host) {
      throw new Error('Un proxy doit être assigné avant de relancer la connexion');
    }
    if (sessionImportRunRef.current) {
      throw new Error('Une création ou connexion est déjà en cours');
    }

    const run = { cancelled: false, profileId: profile.id };
    sessionImportRunRef.current = run;
    setSessionImportProgress({
      running: true,
      total: 1,
      current: 1,
      profileId: profile.id,
      username: account.username,
      status: 'launching',
      message: `Nouvelle tentative de connexion pour @${account.username}`,
    });
    await firestoreUpdateProfile(profile.id, {
      vaManagerLoginStatus: 'pending',
      vaManagerLoginMessage: 'Nouvelle tentative en cours',
    });

    try {
      await acquireProfileLock(
        profile.id,
        { uid: user.uid, email: user.email },
        currentInstallationId
      );
      const result = await window.electronAPI.sessionImport.runVaManager(
        profile,
        organizationId,
        account.id
      );
      await firestoreUpdateProfile(profile.id, {
        vaManagerLoginStatus: result.status === 'success'
          ? 'connected'
          : result.status === 'manual'
            ? 'manual'
            : 'failed',
        vaManagerLoginMessage: result.message,
        vaManagerLastLoginAt: new Date().toISOString(),
        // Une reprise reussie vaut une premiere connexion reussie : meme
        // consequence sur la colonne Account. Un echec, lui, ne touche a rien
        // -- il ne dit pas que le compte est mauvais, seulement que la
        // connexion n'a pas abouti cette fois.
        ...(result.status === 'success' ? { status: 'active' as const } : {}),
      });
      setSessionImportProgress({
        running: false,
        total: 1,
        current: 1,
        profileId: profile.id,
        username: account.username,
        status: result.status,
        message: result.message,
      });
      showToast(
        result.message,
        result.status === 'success' ? 'success' : result.status === 'manual' ? 'warning' : 'error'
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Nouvelle tentative interrompue';
      await firestoreUpdateProfile(profile.id, {
        vaManagerLoginStatus: 'failed',
        vaManagerLoginMessage: message,
        vaManagerLastLoginAt: new Date().toISOString(),
      }).catch(() => {});
      setSessionImportProgress({
        running: false,
        total: 1,
        current: 1,
        profileId: profile.id,
        username: account.username,
        status: 'failed',
        message,
      });
      await window.electronAPI.sessionImport.stop(profile.id).catch(() => {});
      throw error;
    } finally {
      if (sessionImportRunRef.current === run) sessionImportRunRef.current = null;
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
      const newProfile = await firestoreCreateProfile(cloneData, user!.uid, activeWorkspaceTeamId || user!.teamId);
      showToast(`"${profile.name}" cloned as "${newProfile.name}"`, 'success');
      if (user) {
        logActivity({
          teamId: activeWorkspaceTeamId || user.teamId,
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
          teamId: activeWorkspaceTeamId || user.teamId,
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
          teamId: activeWorkspaceTeamId || user.teamId,
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
          teamId: activeWorkspaceTeamId || user.teamId,
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
        const extensionSyncResults = await Promise.allSettled(cloudExtensions.map(async ext => {
          try {
            await window.electronAPI.extensions.downloadAndInstall(
              ext.id,
              ext.storageUrl!,
              ext.updatedAt,
              ext.version
            );
          } catch (e) {
            console.error(`Failed to synchronize extension ${ext.name}:`, e);
            throw e;
          }
        }));
        const extensionSyncFailed = extensionSyncResults.some(
          result => result.status === 'rejected'
        );
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
            teamId: activeWorkspaceTeamId || user.teamId,
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
  /**
   * Ce que chaque instance a reellement fait pendant le tour en cours.
   *
   * Le bot annonce deja tout -- page chargee, tweet trouve, retweet, like --
   * mais ces annonces n'allaient que dans le journal du profil, sur le disque
   * de la machine qui tournait. Savoir quelles instances avaient retweete
   * demandait d'ouvrir une session distante et de lire des fichiers a la main.
   */
  type ResultatTour = {
    nom: string;
    pageChargee: boolean;
    tweetTrouve: boolean;
    retweet: boolean;
    like: boolean;
    panne: string;
  };
  const resultatsTourRef = useRef(new Map<string, ResultatTour>());
  const [recapTour, setRecapTour] = useState<{
    quand: string;
    postUrl: string;
    resultats: Array<{ profileId: string } & ResultatTour>;
  } | null>(null);

  useEffect(() => {
    if (!window.electronAPI.openPost?.onEvent) return;
    return window.electronAPI.openPost.onEvent((e: any) => {
      const id = String(e?.profileId || '');
      if (!id) return;
      const actuel = resultatsTourRef.current.get(id) || {
        nom: '', pageChargee: false, tweetTrouve: false, retweet: false, like: false, panne: '',
      };
      switch (String(e?.event || '')) {
        case 'open-post-content-loaded': actuel.pageChargee = true; break;
        case 'open-post-target-found': actuel.tweetTrouve = true; break;
        case 'open-post-target-not-found': {
          // Le bot dit maintenant ce qu'il avait a l'ecran : trois pannes tres
          // differentes produisaient toutes « tweet introuvable ».
          const causes: Record<string, string> = {
            'verification-humaine': 'X demande une vérification humaine',
            'deconnecte': 'Le compte est déconnecté',
            'compte-suspendu': 'Compte suspendu par X',
            'post-indisponible': 'Le post n’est plus accessible',
            'erreur-x': 'X a renvoyé une erreur',
          };
          const cause = String(e?.cause || '');
          actuel.panne = causes[cause]
            || (cause === 'inconnu' && e?.apercu
              ? `Tweet introuvable — « ${String(e.apercu).slice(0, 60)} »`
              : 'Tweet introuvable dans la page');
          break;
        }
        // « deja retweete » est une reussite, pas un echec : le compteur ne
        // retenait que « reposted » et comptait pour rate tout ce qui l'etait
        // deja. C'est une des raisons pour lesquelles le tweet affichait 24
        // retweets quand le recapitulatif en annoncait 7.
        case 'open-post-repost-result':
          if (['reposted', 'already-reposted'].includes(String(e?.status || ''))) {
            actuel.retweet = true;
          }
          break;
        case 'open-post-like-result':
          if (['liked', 'already-liked'].includes(String(e?.status || ''))) actuel.like = true;
          break;
        // Le verdict lu sur la page fait foi : il arrive en direct, sans le
        // relais qui perdait des messages.
        case 'open-post-verdict':
          if (e?.retweet) actuel.retweet = true;
          if (e?.like) actuel.like = true;
          break;
        case 'bootstrap-failed':
          // « Frame with ID 0 is showing error page » : la page n'a pas pu se
          // charger du tout. C'est le proxy, neuf fois sur dix.
          actuel.panne = /error page/i.test(String(e?.raison || ''))
            ? 'Proxy injoignable — la page ne charge pas'
            : String(e?.raison || 'Démarrage impossible');
          break;
      }
      resultatsTourRef.current.set(id, actuel);
    });
  }, []);

  const [autoPostQueue, setAutoPostQueue] = useState<AutoPostEvent[]>([]);
  const [autoPostProcessing, setAutoPostProcessing] = useState(false);
  const [autoPostNotice, setAutoPostNotice] = useState<{
    postUrl: string;
    account?: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
  } | null>(null);
  const autoPostEnabledRef = useRef(false);
  const seenAutoPostUrlsRef = useRef<Set<string>>(new Set());
  const openPostRunRef = useRef<{
    cancelled: boolean;
    activeProfileIds: Set<string>;
    candidateProfileIds: string[];
  } | null>(null);

  useEffect(() => {
    autoPostEnabledRef.current = Boolean(
      settings.autoPostEnabled && settings.autoPostFolderId
    );
  }, [settings.autoPostEnabled, settings.autoPostFolderId]);

  useEffect(() => {
    if (!autoPostNotice) return;
    const dismissAfterMs = autoPostNotice.status === 'completed'
      ? 5000
      : autoPostNotice.status === 'failed'
        ? 10000
        : null;
    if (!dismissAfterMs) return;

    const noticeUrl = autoPostNotice.postUrl;
    const noticeStatus = autoPostNotice.status;
    const timer = window.setTimeout(() => {
      setAutoPostNotice(current =>
        current?.postUrl === noticeUrl && current.status === noticeStatus
          ? null
          : current
      );
    }, dismissAfterMs);

    return () => window.clearTimeout(timer);
  }, [autoPostNotice?.postUrl, autoPostNotice?.status]);

  useEffect(() => {
    if (!window.electronAPI.autoPost?.onEvent) return;
    return window.electronAPI.autoPost.onEvent((event) => {
      const normalizedUrl = normalizeTweetUrl(event?.postUrl);
      if (!autoPostEnabledRef.current || !normalizedUrl) return;
      if (seenAutoPostUrlsRef.current.has(normalizedUrl)) return;
      seenAutoPostUrlsRef.current.add(normalizedUrl);
      if (seenAutoPostUrlsRef.current.size > 500) {
        const oldest = seenAutoPostUrlsRef.current.values().next().value;
        if (oldest) seenAutoPostUrlsRef.current.delete(oldest);
      }
      setAutoPostQueue(current => [
        ...current,
        { ...event, postUrl: normalizedUrl },
      ]);
      setAutoPostNotice({
        postUrl: normalizedUrl,
        account: event.account,
        status: 'pending',
      });
      showToast(
        `Auto Post: nouvelle publication${event.account ? ` de @${event.account}` : ''}`,
        'info'
      );
    });
  }, [showToast]);

  useEffect(() => {
    if (
      !settings.autoPostEnabled ||
      !settings.autoPostFolderId ||
      !activeWorkspaceTeamId ||
      !currentInstallationId ||
      !window.electronAPI.autoPost?.claimNext
    ) return;

    let stopped = false;
    let inFlight = false;
    const poll = async () => {
      if (stopped || inFlight || autoPostProcessing || autoPostQueue.length > 0) return;
      const currentAuthUser = auth.currentUser;
      if (!currentAuthUser) return;
      inFlight = true;
      try {
        const idToken = await currentAuthUser.getIdToken();
        const result = await window.electronAPI.autoPost!.claimNext({
          idToken,
          teamId: activeWorkspaceTeamId,
          installationId: currentInstallationId,
        });
        const event = result?.event;
        const normalizedUrl = normalizeTweetUrl(event?.postUrl);
        if (!event || !normalizedUrl || stopped) return;
        if (seenAutoPostUrlsRef.current.has(normalizedUrl)) {
          if (event.claimToken) {
            await window.electronAPI.autoPost!.complete({
              idToken,
              teamId: activeWorkspaceTeamId,
              installationId: currentInstallationId,
              eventId: event.id,
              claimToken: event.claimToken,
              success: true,
            });
          }
          return;
        }
        seenAutoPostUrlsRef.current.add(normalizedUrl);
        setAutoPostQueue(current => [...current, { ...event, postUrl: normalizedUrl }]);
        setAutoPostNotice({
          postUrl: normalizedUrl,
          account: event.account,
          status: 'pending',
        });
        showToast(
          `Auto Post Telegram reçu${event.account ? ` pour @${event.account}` : ''}`,
          'info'
        );
      } catch (error) {
        console.warn('Auto Post relay poll failed:', error);
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = window.setInterval(poll, 4000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [
    settings.autoPostEnabled,
    settings.autoPostFolderId,
    activeWorkspaceTeamId,
    currentInstallationId,
    autoPostProcessing,
    autoPostQueue.length,
    showToast,
  ]);

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
        launchMode: 'automation',
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

    // Le registre dit qui a deja retweete ce tweet precis. Sans lui, un post
    // renvoye par le relais rouvrait les 47 instances, y compris les 25 qui
    // l'avaient deja fait -- 50 secondes perdues chacune, pendant qu'un post
    // plus recent attendait son tour.
    const idTweet = normalizedUrl.match(/\/status\/(\d+)/)?.[1] || '';
    let dejaFaits: string[] = [];
    if (idTweet && window.electronAPI.openPost?.dejaFait) {
      dejaFaits = await window.electronAPI.openPost.dejaFait(idTweet).catch(() => []);
    }

    const disponibles = visibleProfiles.filter(p =>
      profileIds.includes(p.id) &&
      !activeProfiles.includes(p.id) &&
      !(user && isLockedByOther(p, user.uid, currentDeviceName, currentInstallationId))
    );
    const restants = disponibles.filter(p => !dejaFaits.includes(p.id));
    const dejaCount = disponibles.length - restants.length;

    // Les proxys en panne : on teste chacun une fois, puis on saute leurs
    // instances. Un proxy injoignable fait perdre 65 secondes par instance
    // et par tour -- et il revient souvent tout seul une heure plus tard,
    // donc on ne change surtout pas l'adresse du compte pour autant.
    let profilesToLaunch = restants;
    let proxyCount = 0;
    if (window.electronAPI.proxysSante?.tester) {
      const testes = new Map<string, boolean>();
      const vivants: typeof restants = [];
      for (const profil of restants) {
        const cle = profil.proxy?.host ? `${profil.proxy.host}:${profil.proxy.port}` : '';
        if (!cle) { vivants.push(profil); continue; }
        if (!testes.has(cle)) {
          const r = await window.electronAPI.proxysSante.tester(profil.proxy).catch(() => null);
          testes.set(cle, r ? r.ok : true);
        }
        if (testes.get(cle)) vivants.push(profil); else proxyCount++;
      }
      profilesToLaunch = vivants;
    }
    if (proxyCount > 0) {
      showToast(`${proxyCount} instance(s) sautée(s) — proxy injoignable`, 'warning');
    }
    if (dejaCount > 0) {
      showToast(`${dejaCount} instance(s) ont déjà retweeté ce post — sautées`, 'info');
    }
    const skippedCount = profileIds.length - disponibles.length;

    if (profilesToLaunch.length === 0) {
      showToast('No available instance in this folder', 'info');
      return;
    }

    // Table rase avant le tour : sinon le recapitulatif melangerait deux tours.
    resultatsTourRef.current = new Map();
    for (const profil of profilesToLaunch) {
      resultatsTourRef.current.set(profil.id, {
        nom: profil.name, pageChargee: false, tweetTrouve: false,
        retweet: false, like: false, panne: '',
      });
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
            launchMode: 'open-post',
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

    // Le recapitulatif du tour : qui a retweete, qui n'a pas, et pourquoi.
    // Une instance ouverte n'est pas une instance qui a agi -- c'est toute la
    // difference que ce tableau rend visible.
    const resultats = profilesToLaunch.map(profil => {
      const r = resultatsTourRef.current.get(profil.id) || {
        nom: profil.name, pageChargee: false, tweetTrouve: false,
        retweet: false, like: false, panne: '',
      };
      const panne = r.panne
        || (r.retweet ? '' : !r.pageChargee ? 'Jamais arrivée jusqu’à la page'
          : !r.tweetTrouve ? 'Tweet introuvable dans la page'
          : 'Tweet vu, retweet non confirmé');
      return { profileId: profil.id, ...r, nom: profil.name, panne };
    });

    setRecapTour({ quand: new Date().toISOString(), postUrl: normalizedUrl, resultats });

    // Ecrit sur la fiche de l'instance : le tour se joue sur le VPS, on le
    // regarde depuis le PC. Sans passer par Firebase, ce resultat resterait
    // sur la machine qui a tourne.
    void Promise.allSettled(resultats.map(r => firestoreUpdateProfile(r.profileId, {
      lastOpenPost: {
        quand: new Date().toISOString(),
        postUrl: normalizedUrl,
        retweet: r.retweet,
        like: r.like,
        panne: r.panne,
      },
    } as any))).catch(() => {});

    const retweets = resultats.filter(r => r.retweet).length;
    const rates = resultats.length - retweets;
    showToast(
      [
        `Tour terminé — ${retweets} retweet(s), ${rates} en échec`,
        timedOutCount > 0 ? `${timedOutCount} ignored (timeout)` : '',
        skippedCount > 0 ? `${skippedCount} non disponible(s)` : '',
      ].filter(Boolean).join(', '),
      rates === 0 ? 'success' : 'warning'
    );
  };

  const handleCreateFolder = async (folderData: any) => {
    try {
      await firestoreCreateFolder(folderData, user!.uid, activeWorkspaceTeamId || user!.teamId);
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

  /* Mass post automatique : un lot toutes les N heures sur un dossier.
     A ne pas confondre avec Auto Post juste au-dessus, qui reagit a une
     publication du bot. Celui-ci n'attend rien : il publie tout seul. */
  const handleToggleMassPostAuto = (folderId: string) => {
    const disabling = Boolean(
      settings.massPostAutoEnabled && settings.massPostAutoFolderId === folderId
    );
    handleSettingsChange({
      massPostAutoEnabled: !disabling,
      massPostAutoFolderId: folderId,
      massPostAutoHours: settings.massPostAutoHours || 6,
      /* On repart de maintenant : allumer le bouton ne doit pas declencher
         un lot dans la seconde a cause d'un ancien horodatage. */
      massPostAutoLastRun: disabling ? settings.massPostAutoLastRun : Date.now(),
    });
    showToast(
      disabling
        ? 'Mass post automatique désactivé'
        : `Mass post automatique : un lot toutes les ${settings.massPostAutoHours || 6} h`,
      disabling ? 'warning' : 'success'
    );
  };

  const handleMassPostAutoRan = (quand: number) => {
    handleSettingsChange({ massPostAutoLastRun: quand });
  };

  const handleToggleAutoPost = (folderId: string) => {
    const disabling = Boolean(
      settings.autoPostEnabled && settings.autoPostFolderId === folderId
    );
    handleSettingsChange({
      autoPostEnabled: !disabling,
      autoPostFolderId: folderId,
    });
    if (disabling) {
      autoPostEnabledRef.current = false;
      setAutoPostQueue([]);
      setAutoPostNotice(null);
      showToast('Auto Post désactivé', 'warning');
    } else {
      autoPostEnabledRef.current = true;
      showToast('Auto Post en écoute', 'success');
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

  useEffect(() => {
    if (
      !settings.autoPostEnabled ||
      !settings.autoPostFolderId ||
      autoPostProcessing ||
      isOpenPostRunning ||
      autoPostQueue.length === 0
    ) return;

    const event = autoPostQueue[0];
    const completeRelayEvent = async (success: boolean) => {
      if (
        !event.claimToken ||
        !activeWorkspaceTeamId ||
        !currentInstallationId ||
        !window.electronAPI.autoPost?.complete ||
        !auth.currentUser
      ) return;
      const idToken = await auth.currentUser.getIdToken();
      await window.electronAPI.autoPost.complete({
        idToken,
        teamId: activeWorkspaceTeamId,
        installationId: currentInstallationId,
        eventId: event.id,
        claimToken: event.claimToken,
        success,
      });
    };
    const folderIds = new Set<string>([settings.autoPostFolderId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const folder of visibleFolders) {
        if (folder.parentId && folderIds.has(folder.parentId) && !folderIds.has(folder.id)) {
          folderIds.add(folder.id);
          changed = true;
        }
      }
    }
    const profileIds = visibleProfiles
      .filter(profile => Boolean(profile.folderId && folderIds.has(profile.folderId)))
      .map(profile => profile.id);

    if (profileIds.length === 0) {
      setAutoPostQueue(current => current.slice(1));
      showToast('Auto Post: le dossier configuré ne contient aucune instance', 'warning');
      void completeRelayEvent(false).catch(() => {});
      return;
    }

    setAutoPostProcessing(true);
    const startAutomaticOpenPost = async () => {
      // Leave the received state visible long enough for the operator to see
      // the URL being filled before the existing Open Post action starts.
      await new Promise(resolve => setTimeout(resolve, 750));
      if (!autoPostEnabledRef.current) throw new Error('Auto Post disabled');
      setAutoPostNotice(current =>
        current?.postUrl === event.postUrl
          ? { ...current, status: 'processing' }
          : current
      );
      await handleOpenTweetInFolder(profileIds, event.postUrl);
      await completeRelayEvent(true);
      setAutoPostNotice(current =>
        current?.postUrl === event.postUrl
          ? { ...current, status: 'completed' }
          : current
      );
    };

    void startAutomaticOpenPost()
      .catch(async (error) => {
        console.error('Auto Post failed:', error);
        await completeRelayEvent(false).catch(() => {});
        setAutoPostNotice(current =>
          current?.postUrl === event.postUrl
            ? { ...current, status: 'failed' }
            : current
        );
      })
      .finally(() => {
        setAutoPostQueue(current => current.filter(item => item.id !== event.id));
        setAutoPostProcessing(false);
      });
  }, [
    settings.autoPostEnabled,
    settings.autoPostFolderId,
    autoPostProcessing,
    isOpenPostRunning,
    autoPostQueue,
    visibleFolders,
    visibleProfiles,
    activeWorkspaceTeamId,
    currentInstallationId,
  ]);

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
            workspaceLabel={activeWorkspaceLabel}
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
            autoPostEnabled={Boolean(settings.autoPostEnabled)}
            autoPostFolderId={settings.autoPostFolderId || null}
            autoPostProcessing={autoPostProcessing}
            autoPostQueueCount={autoPostQueue.length}
            autoPostNotice={autoPostNotice}
            onDismissAutoPostNotice={() => setAutoPostNotice(null)}
            onToggleAutoPost={handleToggleAutoPost}
            massPostAutoEnabled={Boolean(settings.massPostAutoEnabled)}
            massPostAutoFolderId={settings.massPostAutoFolderId || null}
            massPostAutoHours={Number(settings.massPostAutoHours) || 6}
            massPostAutoLastRun={Number(settings.massPostAutoLastRun) || 0}
            onToggleMassPostAuto={handleToggleMassPostAuto}
            onMassPostAutoRan={handleMassPostAutoRan}
            sessionImportProgress={sessionImportProgress}
            onImportSessions={handleImportSessions}
            onStopSessionImport={handleStopSessionImport}
            onMoveProfile={handleMoveProfile}
            onShowCreateModal={() => setShowCreateModal(true)}
            onEditProfile={(profile) => { setEditingProfile(profile); setShowCreateModal(true); }}
            onCloneProfile={handleCloneProfile}
            currentDeviceName={currentDeviceName}
            currentInstallationId={currentInstallationId}
          />
        );
      case 'proxies':
        return (
          <ProxyManagerPage
            profiles={visibleProfiles}
            folders={visibleFolders}
            onUpdateProfile={handleUpdateProfile}
            userId={user?.uid}
            teamId={activeWorkspaceTeamId}
            teamScope={activeWorkspaceTeamIds}
          />
        );
      case 'va-manager':
        return hasAdminAccess ? (
          <VaManagerPage
            profiles={visibleProfiles}
            folders={visibleFolders}
            onUpdateProfile={handleUpdateVaManagerLink}
            onCreateAndConnect={handleCreateVaManagerInstances}
            onRetryConnection={handleRetryVaManagerConnection}
            importProgress={sessionImportProgress}
            onStopImport={handleStopSessionImport}
          />
        ) : null;
      case 'extensions':
        return hasAdminAccess ? <ExtensionsPage teamId={activeWorkspaceTeamId} teams={teams} /> : null;
      case 'diagnostics':
        return <DiagnosticsPage user={user} profiles={visibleProfiles} activeProfiles={activeProfiles} />;
      case 'settings':
        return <SettingsPage settings={settings} onSettingsChange={handleSettingsChange} user={user} onLogout={handleLogout} />;
      case 'activity':
        return hasAdminAccess ? <ActivityLogPage teamId={activeWorkspaceTeamId || ''} /> : null;
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
        return hasAdminAccess ? <MembersPage teamId={activeWorkspaceTeamId || ''} folders={folders} /> : null;
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
            activeWorkspaceTeamId={activeWorkspaceTeamId || undefined}
            activeWorkspaceLabel={activeWorkspaceLabel}
            onOpenWorkspace={async (email) => {
              try {
                const workspaceUser = await findUserByEmail(email);
                if (!workspaceUser?.teamId) return false;
                const currentTeam = await getTeamById(workspaceUser.teamId);
                const ownerId = currentTeam?.ownerId || workspaceUser.uid;
                const ownerTeams = await getTeamsByOwnerId(ownerId);
                const workspaceTeamIds = Array.from(new Set([
                  workspaceUser.teamId,
                  ...ownerTeams.map(team => team.id),
                ]));
                const label = workspaceUser.displayName
                  ? `${workspaceUser.displayName} — ${workspaceUser.email}`
                  : workspaceUser.email;
                setActiveWorkspaceTeamId(workspaceUser.teamId);
                setActiveWorkspaceTeamIds(workspaceTeamIds);
                setActiveWorkspaceLabel(label);
                localStorage.setItem(`spectra-active-workspace:${user.uid}`, workspaceUser.teamId);
                localStorage.setItem(`spectra-active-workspace-teams:${user.uid}`, JSON.stringify(workspaceTeamIds));
                localStorage.setItem(`spectra-active-workspace-label:${user.uid}`, label);
                setSettings(current => ({ ...current, activeWorkspaceEmail: workspaceUser.email }));
                await window.electronAPI.settings.set({ activeWorkspaceEmail: workspaceUser.email });
                setSelectedFolderId(null);
                setActivePage('profiles');
                return true;
              } catch (error) {
                console.error('Failed to open workspace:', error);
                return false;
              }
            }}
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

        {/* Recapitulatif de fin de tour : qui a retweete, qui n'a pas, et
            pourquoi. Une instance ouverte n'est pas une instance qui a agi. */}
        {recapTour && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-5"
            style={{ background: 'rgba(0,0,0,0.72)' }}
            onMouseDown={e => { if (e.target === e.currentTarget) setRecapTour(null); }}
          >
            <div
              className="w-full max-w-3xl rounded-2xl p-5 max-h-[86vh] overflow-auto"
              style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}
            >
              <div className="flex items-center justify-between mb-1">
                <div className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                  Tour terminé — {recapTour.resultats.filter(r => r.retweet).length} retweet(s)
                  {' '}sur {recapTour.resultats.length}
                </div>
                <button onClick={() => setRecapTour(null)} style={{ color: 'var(--text-muted)' }}>✕</button>
              </div>
              <a
                href={recapTour.postUrl} target="_blank" rel="noreferrer"
                className="text-xs underline"
                style={{ color: 'var(--text-muted)' }}
              >
                {recapTour.postUrl}
              </a>

              {(() => {
                const rates = recapTour.resultats.filter(r => !r.retweet);
                const reussis = recapTour.resultats.filter(r => r.retweet);
                const bloc = (titre: string, liste: typeof recapTour.resultats, couleur: string) => (
                  liste.length === 0 ? null : (
                    <div className="mt-4">
                      <div className="text-xs font-semibold mb-1.5" style={{ color: couleur }}>
                        {titre} — {liste.length}
                      </div>
                      <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border-subtle)' }}>
                        {liste.map(r => (
                          <div
                            key={r.profileId}
                            className="flex items-center gap-3 px-3 py-1.5 text-[12px]"
                            style={{ borderTop: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
                          >
                            <span className="flex-1 truncate" style={{ color: 'var(--text-primary)' }}>{r.nom}</span>
                            <span style={{ color: r.retweet ? 'var(--success)' : '#f87171' }}>
                              {r.retweet ? 'RT ✓' : 'RT ✕'}
                            </span>
                            <span style={{ color: r.like ? 'var(--success)' : 'var(--text-muted)' }}>
                              {r.like ? 'Like ✓' : 'Like ✕'}
                            </span>
                            <span className="w-64 truncate text-right" style={{ color: 'var(--text-muted)' }}>
                              {r.panne}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                );
                return (
                  <>
                    {/* Les echecs d'abord : c'est la liste sur laquelle on agit. */}
                    {bloc('N’ont pas retweeté', rates, '#f87171')}
                    {bloc('Ont retweeté', reussis, 'var(--success, #22c55e)')}
                  </>
                );
              })()}
            </div>
          </div>
        )}
      </div>
    </AuthProvider>
  );
}

export default App;
