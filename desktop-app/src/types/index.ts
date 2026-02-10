export type AppPage = 'profiles' | 'proxies' | 'extensions' | 'settings' | 'activity' | 'recycle-bin' | 'billing' | 'members' | 'admin-panel';

export type UserRole = 'owner' | 'admin' | 'va';

export interface Team {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
}

export interface AppUser {
  uid: string;
  email: string;
  displayName: string | null;
  role: UserRole;
  teamId: string;
}

export interface ActivityLogEntry {
  id?: string;
  teamId?: string;
  userId: string;
  userName: string;
  action: 'profile_launched' | 'profile_closed' | 'profile_created' | 'profile_deleted' | 'profile_restored' | 'profile_permanently_deleted' | 'user_login' | 'user_logout' | 'cookies_imported' | 'cookies_exported';
  targetProfileId?: string;
  targetProfileName?: string;
  timestamp: string;
  metadata?: Record<string, any>;
}

export interface UserProfile {
  uid: string;
  email: string;
  role: UserRole;
  teamId?: string;
  displayName?: string;
  createdAt: string;
}

export type Platform = 'twitter' | 'instagram' | 'tiktok' | 'reddit' | 'onlyfans' | 'telegram' | 'other';

export type ProfileStatus = 'active' | 'banned' | 'warming' | 'limited' | 'review' | 'none';

export interface Profile {
  id: string;
  teamId?: string;
  name: string;
  platform?: Platform;
  folderId?: string;
  userAgent: string;
  timezone: string;
  language: string;
  screenResolution: string;
  proxy?: {
    type: string;
    host: string;
    port: number;
    username?: string;
    password?: string;
  };
  fingerprint?: any;
  hardwareConcurrency?: number;
  deviceMemory?: number;
  webglVendor?: string;
  webglRenderer?: string;
  preset?: string;
  os?: 'windows' | 'macos' | 'linux';
  browserType?: 'chrome' | 'firefox' | 'edge';
  status?: ProfileStatus;
  tags?: string[];
  notes?: string;
  assignedTo?: string;
  assignedToEmail?: string;
  deleted?: boolean;
  deletedAt?: string;
  deletedBy?: string;
  connectionType?: string;
  connectionConfig?: any;
  createdAt: string;
  createdBy?: string;
  updatedAt?: string;
  lastUsed?: string;
  lastUrl?: string;

  // Cloud sync
  cloudStorageUrl?: string;
  cloudSyncedAt?: string;
  cloudSyncSize?: number;
  cloudSyncVersion?: number;

  // Profile lock
  lockedBy?: string | null;
  lockedByEmail?: string | null;
  lockedByDevice?: string | null;
  lockedAt?: string | null;
}

export interface Folder {
  id: string;
  teamId?: string;
  name: string;
  parentId?: string;
  icon?: string;
  color?: string;
  createdAt: string;
  createdBy?: string;
  updatedAt?: string;
  profileCount?: number;
}

export interface Extension {
  id: string;
  teamId?: string;
  name: string;
  version?: string;
  description?: string;
  enabled: boolean;
  localPath?: string;
  storageUrl?: string;
  createdAt: string;
}

export interface AppSettings {
  theme: 'dark' | 'light';
  language: string;
  defaultOS: 'windows' | 'macos' | 'linux';
  defaultBrowser: 'chrome' | 'firefox' | 'edge';
  sortBy: 'name' | 'created' | 'lastUsed';
  sortOrder: 'asc' | 'desc';
}

export interface StoreData {
  profiles: Profile[];
  folders: Folder[];
  settings: AppSettings;
}