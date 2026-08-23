export type AppPage = 'profiles' | 'va-manager' | 'proxies' | 'extensions' | 'settings' | 'diagnostics' | 'activity' | 'recycle-bin' | 'billing' | 'members' | 'admin-panel';

export type UserRole = 'super_admin' | 'owner' | 'admin' | 'va';

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
  assignedFolderId?: string | null;
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
  assignedFolderId?: string | null;
  displayName?: string;
  createdAt: string;
}

export type Platform = 'twitter' | 'instagram' | 'tiktok' | 'reddit' | 'onlyfans' | 'telegram' | 'other';

export type ProfileStatus =
  | 'active'
  | 'shadowBanned'
  | 'banned'
  | 'loggedIn'
  | 'toLogIn'
  | 'none';

// Etat du bot dans le profil, choisi a la main comme le statut du compte.
// Spectra sait detecter VenusBot au lancement, mais un profil ferme n'a aucun
// etat observable : une valeur posee a la main reste lisible tout le temps.
export type BotStatus = 'botConnected' | 'botDisconnected' | 'none';

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
    country?: string;
    timezone?: string;
    city?: string;
    region?: string;
    latitude?: number;
    longitude?: number;
    lastExitIp?: string;
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
  botStatus?: BotStatus;
  /**
   * Resultat du dernier tour Open Post pour cette instance.
   *
   * Range sur la fiche, donc visible depuis n'importe quelle machine : le tour
   * se joue sur le VPS et se regarde depuis le PC. Sans cela, savoir qui avait
   * retweete demandait d'ouvrir une session distante et de lire des journaux
   * a la main.
   */
  lastOpenPost?: {
    quand: string;
    postUrl: string;
    retweet: boolean;
    like: boolean;
    /** Vide si tout s'est bien passe ; sinon, ce qui a manque. */
    panne: string;
  };
  /**
   * Instance de reference pour le robot : ses reglages et ses contenus servent
   * de modele aux autres instances du meme dossier. Un dossier n'en a qu'une.
   *
   * La cle de licence et le compte X ne sont jamais recopies -- il y en a un par
   * compte, et les partager ferait tourner deux instances sous la meme identite.
   */
  botTemplate?: boolean;
  /** Empreinte du modele deja applique, pour ne pas ecraser a chaque ouverture. */
  botTemplateApplied?: string;
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
  vaManagerAccountId?: string | null;
  vaManagerOrganizationId?: string | null;
  vaManagerLoginStatus?: 'pending' | 'connected' | 'manual' | 'failed';
  vaManagerLoginMessage?: string;
  vaManagerLastLoginAt?: string;

  // Cloud sync
  cloudStorageUrl?: string;
  cloudSyncedAt?: string;
  cloudSyncSize?: number;
  cloudSyncVersion?: number;
  cloudSyncRevision?: string;
  cloudSyncProtocolVersion?: number;
  cloudSyncChecksum?: string;
  cloudSyncChecksumRevision?: string;
  cloudSyncedBy?: string;

  // Profile lock
  lockedBy?: string | null;
  lockedByEmail?: string | null;
  lockedByDevice?: string | null;
  lockedByInstallationId?: string | null;
  lockedAt?: string | null;

  // Custom sort order
  sortIndex?: number;
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
  updatedAt?: string;
}

export interface AppSettings {
  theme: 'dark' | 'light';
  language: string;
  defaultOS: 'windows' | 'macos' | 'linux';
  defaultBrowser: 'chrome' | 'firefox' | 'edge';
  sortBy: 'name' | 'created' | 'lastUsed' | 'custom';
  sortOrder: 'asc' | 'desc';
  activeWorkspaceEmail?: string;
  autoPostEnabled?: boolean;
  autoPostFolderId?: string;
  /* Mass post automatique : un lot toutes les N heures sur un dossier.
     Distinct de autoPost, qui declenche Open Post apres une publication du
     bot ; celui-ci publie de lui-meme, sans rien attendre. */
  massPostAutoEnabled?: boolean;
  massPostAutoFolderId?: string;
  massPostAutoHours?: number;
  massPostAutoLastRun?: number;
}

export interface VaManagerOrganization {
  id: string;
  name: string;
}

export interface VaManagerConnectionStatus {
  connected: boolean;
  email?: string;
  primaryOrganizationId?: string;
  /**
   * Faux quand le coffre du systeme est indisponible : la connexion tient le
   * temps de la session mais rien n'est ecrit sur le disque, il faudra la
   * refaire au prochain demarrage. Arrive sur un Mac dont le trousseau refuse
   * l'application (lancee depuis l'image disque, ou encore en quarantaine).
   */
  memorisee?: boolean;
}

export interface VaManagerAccount {
  id: string;
  organizationId?: string;
  username: string;
  /**
   * L'assistant qui tient ce compte. VA Manager stocke deux colonnes,
   * `assigned_va_id` (multi-VA) et `va_id` ; la premiere l'emporte, comme dans
   * son propre code. `vaName` est vide si l'assistant a ete supprime depuis.
   */
  vaId?: string;
  vaName?: string;
  status: 'active' | 'shadowban' | 'banned' | 'error' | string;
  followers: number | null;
  followersUpdatedAt?: string;
  lastScannedAt?: string;
  lastScanError?: string;
  hasPassword: boolean;
  passwordUsable: boolean;
  hasTwoFa: boolean;
  hasAuthToken: boolean;
  hasCookies: boolean;
  hasEmail: boolean;
  hasEmailPassword: boolean;
  emailPasswordUsable: boolean;
}

export interface StoreData {
  profiles: Profile[];
  folders: Folder[];
  settings: AppSettings;
}
