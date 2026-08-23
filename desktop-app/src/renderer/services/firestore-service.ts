import { collection, addDoc, getDocs, query, orderBy, limit, where, startAfter, doc, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, writeBatch, Unsubscribe } from 'firebase/firestore';
import { db } from './firebase';
import { ActivityLogEntry, UserProfile, Profile, Folder, Extension, Team } from '../../types';
import { proxyDocumentId } from '../../shared/proxy-identity';

const ACTIVITY_COLLECTION = 'activityLogs';
const USERS_COLLECTION = 'users';
const TEAMS_COLLECTION = 'teams';
const PROFILES_COLLECTION = 'profiles';
const FOLDERS_COLLECTION = 'folders';
const EXTENSIONS_COLLECTION = 'extensions';
const PROXIES_COLLECTION = 'proxies';

// ── Activity Logs ──────────────────────────────────────────────

export async function logActivity(entry: Omit<ActivityLogEntry, 'id'>): Promise<void> {
  try {
    await addDoc(collection(db, ACTIVITY_COLLECTION), {
      ...entry,
      timestamp: entry.timestamp || new Date().toISOString(),
    });
  } catch (error) {
    console.error('Failed to log activity:', error);
  }
}

export interface ActivityLogFilters {
  teamId?: string;
  userId?: string;
  action?: string;
  limitCount?: number;
  lastDoc?: any;
}

export async function getActivityLogs(filters: ActivityLogFilters = {}): Promise<{ entries: ActivityLogEntry[]; lastDoc: any }> {
  try {
    const constraints: any[] = [orderBy('timestamp', 'desc')];

    if (filters.teamId) {
      constraints.unshift(where('teamId', '==', filters.teamId));
    }
    if (filters.userId) {
      constraints.unshift(where('userId', '==', filters.userId));
    }
    if (filters.action) {
      constraints.unshift(where('action', '==', filters.action));
    }
    if (filters.lastDoc) {
      constraints.push(startAfter(filters.lastDoc));
    }
    constraints.push(limit(filters.limitCount || 50));

    const q = query(collection(db, ACTIVITY_COLLECTION), ...constraints);
    const snapshot = await getDocs(q);

    const entries: ActivityLogEntry[] = snapshot.docs.map(d => ({
      id: d.id,
      ...d.data(),
    })) as ActivityLogEntry[];

    const lastVisible = snapshot.docs[snapshot.docs.length - 1] || null;

    return { entries, lastDoc: lastVisible };
  } catch (error) {
    console.error('Failed to get activity logs:', error);
    return { entries: [], lastDoc: null };
  }
}

// ── Users ──────────────────────────────────────────────────────

export async function getUserProfile(uid: string): Promise<UserProfile | null> {
  try {
    const userDoc = await getDoc(doc(db, USERS_COLLECTION, uid));
    if (userDoc.exists()) {
      return userDoc.data() as UserProfile;
    }
    return null;
  } catch (error) {
    console.error('Failed to get user profile:', error);
    return null;
  }
}

export async function getAllUsers(teamId?: string): Promise<UserProfile[]> {
  try {
    const q = teamId
      ? query(collection(db, USERS_COLLECTION), where('teamId', '==', teamId))
      : query(collection(db, USERS_COLLECTION));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(d => ({ uid: d.id, ...d.data() })) as UserProfile[];
  } catch (error) {
    console.error('Failed to get users:', error);
    return [];
  }
}

export async function findUserByEmail(email: string): Promise<UserProfile | null> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) return null;
  const q = query(
    collection(db, USERS_COLLECTION),
    where('email', '==', normalizedEmail),
    limit(1)
  );
  const snapshot = await getDocs(q);
  if (snapshot.empty) return null;
  const result = snapshot.docs[0];
  return { uid: result.id, ...result.data() } as UserProfile;
}

export async function getTeamById(teamId: string): Promise<Team | null> {
  if (!teamId) return null;
  const teamDoc = await getDoc(doc(db, TEAMS_COLLECTION, teamId));
  return teamDoc.exists() ? ({ id: teamDoc.id, ...teamDoc.data() } as Team) : null;
}

export async function getTeamsByOwnerId(ownerId: string): Promise<Team[]> {
  if (!ownerId) return [];
  const q = query(collection(db, TEAMS_COLLECTION), where('ownerId', '==', ownerId));
  const snapshot = await getDocs(q);
  return snapshot.docs.map(teamDoc => ({
    id: teamDoc.id,
    ...teamDoc.data(),
  })) as Team[];
}

export function subscribeToTeams(callback: (teams: Team[]) => void): Unsubscribe {
  const q = query(collection(db, TEAMS_COLLECTION), orderBy('createdAt', 'desc'));
  return onSnapshot(q, (snapshot) => {
    const teams: Team[] = snapshot.docs.map(d => ({
      id: d.id,
      ...d.data(),
    })) as Team[];
    callback(teams);
  }, (error) => {
    console.error('Teams subscription error:', error);
  });
}

// ── Profiles (Cloud Sync) ──────────────────────────────────────

export function subscribeToProfiles(
  teamId: string | string[] | null | undefined,
  callback: (profiles: Profile[]) => void,
  assignedFolderId?: string | null
): Unsubscribe {
  const teamIds = Array.isArray(teamId) ? teamId.filter(Boolean) : teamId ? [teamId] : [];
  const q = teamIds.length
    ? assignedFolderId
      ? query(
          collection(db, PROFILES_COLLECTION),
          where('teamId', teamIds.length === 1 ? '==' : 'in', teamIds.length === 1 ? teamIds[0] : teamIds.slice(0, 30)),
          where('folderId', '==', assignedFolderId)
        )
      : teamIds.length === 1
        ? query(collection(db, PROFILES_COLLECTION), where('teamId', '==', teamIds[0]), orderBy('createdAt', 'desc'))
        : query(collection(db, PROFILES_COLLECTION), where('teamId', 'in', teamIds.slice(0, 30)))
    : query(collection(db, PROFILES_COLLECTION), orderBy('createdAt', 'desc'));
  return onSnapshot(q, (snapshot) => {
    const profiles: Profile[] = snapshot.docs.map(d => ({
      id: d.id,
      ...d.data(),
    })).sort((a: any, b: any) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))) as Profile[];
    callback(profiles);
  }, (error) => {
    console.error('Profiles subscription error:', error);
  });
}

export function subscribeToFolders(
  teamId: string | string[] | null | undefined,
  callback: (folders: Folder[]) => void,
  assignedFolderId?: string | null
): Unsubscribe {
  const teamIds = Array.isArray(teamId) ? teamId.filter(Boolean) : teamId ? [teamId] : [];
  if (teamIds.length && assignedFolderId) {
    return onSnapshot(doc(db, FOLDERS_COLLECTION, assignedFolderId), (snapshot) => {
      callback(snapshot.exists() ? [{ id: snapshot.id, ...snapshot.data() } as Folder] : []);
    }, (error) => {
      console.error('Folder subscription error:', error);
    });
  }
  const q = teamIds.length
    ? teamIds.length === 1
      ? query(collection(db, FOLDERS_COLLECTION), where('teamId', '==', teamIds[0]), orderBy('createdAt', 'desc'))
      : query(collection(db, FOLDERS_COLLECTION), where('teamId', 'in', teamIds.slice(0, 30)))
    : query(collection(db, FOLDERS_COLLECTION), orderBy('createdAt', 'desc'));
  return onSnapshot(q, (snapshot) => {
    const folders: Folder[] = snapshot.docs.map(d => ({
      id: d.id,
      ...d.data(),
    })).sort((a: any, b: any) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))) as Folder[];
    callback(folders);
  }, (error) => {
    console.error('Folders subscription error:', error);
  });
}

// Recursively remove undefined values (Firestore rejects them)
function removeUndefined(obj: any): any {
  if (obj === null || obj === undefined) return null;
  if (Array.isArray(obj)) return obj.map(removeUndefined);
  if (typeof obj === 'object') {
    const clean: any = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v !== undefined) clean[k] = removeUndefined(v);
    }
    return clean;
  }
  return obj;
}

export async function createProfile(profileData: Omit<Profile, 'id'>, userId: string, teamId: string): Promise<Profile> {
  const now = new Date().toISOString();
  const data = removeUndefined({
    ...profileData,
    teamId,
    createdBy: userId,
    createdAt: profileData.createdAt || now,
    updatedAt: now,
  });
  const docRef = await addDoc(collection(db, PROFILES_COLLECTION), data);
  return { id: docRef.id, ...data } as Profile;
}

export async function updateProfile(profileId: string, data: Partial<Profile>): Promise<void> {
  const { id, ...updateData } = data as any;
  await updateDoc(doc(db, PROFILES_COLLECTION, profileId), removeUndefined({
    ...updateData,
    updatedAt: new Date().toISOString(),
  }));
}

export async function deleteProfile(profileId: string): Promise<void> {
  await deleteDoc(doc(db, PROFILES_COLLECTION, profileId));
}

export async function getAllProfilesOnce(teamId?: string): Promise<Profile[]> {
  try {
    const q = teamId
      ? query(collection(db, PROFILES_COLLECTION), where('teamId', '==', teamId))
      : query(collection(db, PROFILES_COLLECTION));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(d => ({ id: d.id, ...d.data() })) as Profile[];
  } catch (error) {
    console.error('Failed to get profiles:', error);
    return [];
  }
}

// ── Folders (Cloud Sync) ───────────────────────────────────────

export async function createFolder(folderData: Omit<Folder, 'id'>, userId: string, teamId: string): Promise<Folder> {
  const now = new Date().toISOString();
  const data = {
    ...folderData,
    teamId,
    createdBy: userId,
    createdAt: folderData.createdAt || now,
  };
  const docRef = await addDoc(collection(db, FOLDERS_COLLECTION), data);
  return { id: docRef.id, ...data } as Folder;
}

export async function updateFolder(folderId: string, data: Partial<Folder>): Promise<void> {
  const { id, ...updateData } = data as any;
  await updateDoc(doc(db, FOLDERS_COLLECTION, folderId), {
    ...updateData,
    updatedAt: new Date().toISOString(),
  });
}

export async function deleteFolder(folderId: string): Promise<void> {
  // Batch: delete folder + child folders + unassign profiles and proxies
  const batch = writeBatch(db);
  const now = new Date().toISOString();

  // Find child folders
  const childFolders = await getDocs(
    query(collection(db, FOLDERS_COLLECTION), where('parentId', '==', folderId))
  );

  // For each child folder: unassign its profiles and proxies, then delete it
  for (const child of childFolders.docs) {
    const childProfiles = await getDocs(
      query(collection(db, PROFILES_COLLECTION), where('folderId', '==', child.id))
    );
    childProfiles.docs.forEach(d => {
      batch.update(d.ref, { folderId: null, updatedAt: now });
    });

    const childProxies = await getDocs(
      query(collection(db, PROXIES_COLLECTION), where('folderId', '==', child.id))
    );
    childProxies.docs.forEach(d => {
      batch.update(d.ref, { folderId: null, updatedAt: now });
    });

    batch.delete(child.ref);
  }

  // Unassign profiles in the parent folder
  const profilesInFolder = await getDocs(
    query(collection(db, PROFILES_COLLECTION), where('folderId', '==', folderId))
  );
  profilesInFolder.docs.forEach(d => {
    batch.update(d.ref, { folderId: null, updatedAt: now });
  });

  // Unassign proxies in the parent folder
  const proxiesInFolder = await getDocs(
    query(collection(db, PROXIES_COLLECTION), where('folderId', '==', folderId))
  );
  proxiesInFolder.docs.forEach(d => {
    batch.update(d.ref, { folderId: null, updatedAt: now });
  });

  batch.delete(doc(db, FOLDERS_COLLECTION, folderId));
  await batch.commit();
}

// ── Migration: local electron-store → Firestore ───────────────

export async function migrateLocalProfiles(localProfiles: Profile[], localFolders: Folder[], userId: string, teamId: string): Promise<void> {
  // Check if Firestore already has data (another device migrated)
  const existing = await getAllProfilesOnce(teamId);
  if (existing.length > 0) {
    console.log('Firestore already has profiles, skipping migration');
    return;
  }

  if (localProfiles.length === 0 && localFolders.length === 0) {
    return;
  }

  console.log(`Migrating ${localProfiles.length} profiles and ${localFolders.length} folders to Firestore...`);

  // Use setDoc with existing IDs to preserve profile directory mapping
  for (const folder of localFolders) {
    const { id, ...folderData } = folder;
    await setDoc(doc(db, FOLDERS_COLLECTION, id), { ...folderData, teamId, createdBy: userId });
  }

  for (const profile of localProfiles) {
    const { id, ...profileData } = profile;
    await setDoc(doc(db, PROFILES_COLLECTION, id), { ...profileData, teamId, createdBy: userId, updatedAt: new Date().toISOString() });
  }

  console.log('Migration complete');
}

// ── Extensions (Cloud Sync) ────────────────────────────────────

export function subscribeToExtensions(teamId: string | null | undefined, callback: (extensions: Extension[]) => void): Unsubscribe {
  const q = teamId
    ? query(collection(db, EXTENSIONS_COLLECTION), where('teamId', '==', teamId), orderBy('createdAt', 'desc'))
    : query(collection(db, EXTENSIONS_COLLECTION), orderBy('createdAt', 'desc'));
  return onSnapshot(q, (snapshot) => {
    const extensions: Extension[] = snapshot.docs.map(d => ({
      id: d.id,
      ...d.data(),
    })) as Extension[];
    callback(extensions);
  }, (error) => {
    console.error('Extensions subscription error:', error);
  });
}

export async function registerExtension(ext: Omit<Extension, 'id'> & { id: string }, teamId: string): Promise<void> {
  if (!teamId) {
    throw new Error('Cannot register extension without a teamId');
  }

  const { id, ...data } = ext;
  const teamExtensionId = id.startsWith(`${teamId}_`) ? id : `${teamId}_${id}`;
  await setDoc(doc(db, EXTENSIONS_COLLECTION, teamExtensionId), { ...data, teamId });

  if (teamExtensionId !== id) {
    await deleteDoc(doc(db, EXTENSIONS_COLLECTION, id)).catch(() => {});
  }
}

export async function setExtensionEnabled(extensionId: string, enabled: boolean): Promise<void> {
  await updateDoc(doc(db, EXTENSIONS_COLLECTION, extensionId), { enabled });
}

export async function unregisterExtension(extensionId: string): Promise<void> {
  await deleteDoc(doc(db, EXTENSIONS_COLLECTION, extensionId));
}

// ── Proxies (Cloud Sync) ──────────────────────────────────────

export interface FirestoreProxy {
  id: string;
  teamId?: string;
  name?: string;
  type: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  provider?: string;
  country?: string;
  timezone?: string;
  city?: string;
  region?: string;
  latitude?: number;
  longitude?: number;
  lastExitIp?: string;
  folderId?: string | null;
  isHealthy?: boolean;
  lastCheck?: string;
  responseTime?: number;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export function subscribeToProxies(teamId: string | string[] | null | undefined, callback: (proxies: FirestoreProxy[]) => void): Unsubscribe {
  const teamIds = Array.isArray(teamId) ? teamId.filter(Boolean) : teamId ? [teamId] : [];
  const q = teamIds.length
    ? teamIds.length === 1
      ? query(collection(db, PROXIES_COLLECTION), where('teamId', '==', teamIds[0]), orderBy('createdAt', 'desc'))
      : query(collection(db, PROXIES_COLLECTION), where('teamId', 'in', teamIds.slice(0, 30)))
    : query(collection(db, PROXIES_COLLECTION), orderBy('createdAt', 'desc'));
  return onSnapshot(q, (snapshot) => {
    const proxies: FirestoreProxy[] = snapshot.docs.map(d => ({
      id: d.id,
      ...d.data(),
    })).sort((a: any, b: any) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))) as FirestoreProxy[];
    callback(proxies);
  }, (error) => {
    console.error('Proxies subscription error:', error);
  });
}

export async function createProxy(proxyData: Omit<FirestoreProxy, 'id'>, userId: string, teamId: string): Promise<FirestoreProxy> {
  const now = new Date().toISOString();
  const data = {
    ...proxyData,
    teamId,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  };
  const deterministicId = await proxyDocumentId(teamId, proxyData);
  const docRef = doc(db, PROXIES_COLLECTION, deterministicId);
  await setDoc(docRef, data, { merge: true });
  return { id: docRef.id, ...data } as FirestoreProxy;
}

export async function createProxiesBulk(proxies: Omit<FirestoreProxy, 'id'>[], userId: string, teamId: string): Promise<{ added: number; failed: number }> {
  const now = new Date().toISOString();
  let added = 0;
  let failed = 0;
  const batch = writeBatch(db);

  for (const proxy of proxies) {
    try {
      const deterministicId = await proxyDocumentId(teamId, proxy);
      const docRef = doc(db, PROXIES_COLLECTION, deterministicId);
      batch.set(docRef, {
        ...proxy,
        teamId,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      });
      added++;
    } catch {
      failed++;
    }
  }

  if (added > 0) {
    await batch.commit();
  }
  return { added, failed };
}

export async function updateProxy(proxyId: string, data: Partial<FirestoreProxy>): Promise<void> {
  const { id, ...updateData } = data as any;
  await updateDoc(doc(db, PROXIES_COLLECTION, proxyId), {
    ...updateData,
    updatedAt: new Date().toISOString(),
  });
}

const PROXY_DELETE_BATCH_SIZE = 450;

export async function deleteProxy(
  proxyId: string,
  assignedProfileIds: string[] = []
): Promise<void> {
  await deleteProxiesBulk([proxyId], assignedProfileIds);
}

export async function deleteProxiesBulk(
  proxyIds: string[],
  assignedProfileIds: string[] = []
): Promise<void> {
  const operations = [
    ...Array.from(new Set(assignedProfileIds)).map(id => ({ type: 'profile' as const, id })),
    ...Array.from(new Set(proxyIds)).map(id => ({ type: 'proxy' as const, id })),
  ];

  for (let offset = 0; offset < operations.length; offset += PROXY_DELETE_BATCH_SIZE) {
    const batch = writeBatch(db);
    for (const operation of operations.slice(offset, offset + PROXY_DELETE_BATCH_SIZE)) {
      if (operation.type === 'profile') {
        batch.update(doc(db, PROFILES_COLLECTION, operation.id), {
          proxy: null,
          connectionType: 'system',
          connectionConfig: { type: 'system' },
          updatedAt: new Date().toISOString(),
        });
      } else {
        batch.delete(doc(db, PROXIES_COLLECTION, operation.id));
      }
    }
    await batch.commit();
  }
}

// ── Migration: assign teamId to existing data ──────────────────

export async function migrateExistingDataToTeam(teamId: string): Promise<void> {
  const collections = ['profiles', 'folders', 'proxies', 'extensions', 'activityLogs'];

  for (const col of collections) {
    try {
      // Get ALL docs and filter those without teamId (Firestore can't query for missing fields)
      const snapshot = await getDocs(collection(db, col));
      const docsWithoutTeam = snapshot.docs.filter(d => !d.data().teamId);

      if (docsWithoutTeam.length === 0) continue;

      console.log(`[Migration] Assigning teamId to ${docsWithoutTeam.length} docs in ${col}`);

      // Firestore batch limit is 500
      for (let i = 0; i < docsWithoutTeam.length; i += 500) {
        const batch = writeBatch(db);
        docsWithoutTeam.slice(i, i + 500).forEach(d => {
          batch.update(d.ref, { teamId });
        });
        await batch.commit();
      }
    } catch (error) {
      console.error(`[Migration] Failed for collection ${col}:`, error);
    }
  }
}
