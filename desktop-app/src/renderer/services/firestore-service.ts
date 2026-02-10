import { collection, addDoc, getDocs, query, orderBy, limit, where, startAfter, doc, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, writeBatch, Unsubscribe } from 'firebase/firestore';
import { db } from './firebase';
import { ActivityLogEntry, UserProfile, Profile, Folder, Extension } from '../../types';

const ACTIVITY_COLLECTION = 'activityLogs';
const USERS_COLLECTION = 'users';
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

// ── Profiles (Cloud Sync) ──────────────────────────────────────

export function subscribeToProfiles(teamId: string, callback: (profiles: Profile[]) => void): Unsubscribe {
  const q = query(
    collection(db, PROFILES_COLLECTION),
    where('teamId', '==', teamId),
    orderBy('createdAt', 'desc')
  );
  return onSnapshot(q, (snapshot) => {
    const profiles: Profile[] = snapshot.docs.map(d => ({
      id: d.id,
      ...d.data(),
    })) as Profile[];
    callback(profiles);
  }, (error) => {
    console.error('Profiles subscription error:', error);
  });
}

export function subscribeToFolders(teamId: string, callback: (folders: Folder[]) => void): Unsubscribe {
  const q = query(
    collection(db, FOLDERS_COLLECTION),
    where('teamId', '==', teamId),
    orderBy('createdAt', 'desc')
  );
  return onSnapshot(q, (snapshot) => {
    const folders: Folder[] = snapshot.docs.map(d => ({
      id: d.id,
      ...d.data(),
    })) as Folder[];
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

export function subscribeToExtensions(teamId: string, callback: (extensions: Extension[]) => void): Unsubscribe {
  const q = query(
    collection(db, EXTENSIONS_COLLECTION),
    where('teamId', '==', teamId),
    orderBy('createdAt', 'desc')
  );
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
  const { id, ...data } = ext;
  await setDoc(doc(db, EXTENSIONS_COLLECTION, id), { ...data, teamId });
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
  folderId?: string | null;
  isHealthy?: boolean;
  lastCheck?: string;
  responseTime?: number;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export function subscribeToProxies(teamId: string, callback: (proxies: FirestoreProxy[]) => void): Unsubscribe {
  const q = query(
    collection(db, PROXIES_COLLECTION),
    where('teamId', '==', teamId),
    orderBy('createdAt', 'desc')
  );
  return onSnapshot(q, (snapshot) => {
    const proxies: FirestoreProxy[] = snapshot.docs.map(d => ({
      id: d.id,
      ...d.data(),
    })) as FirestoreProxy[];
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
  const docRef = await addDoc(collection(db, PROXIES_COLLECTION), data);
  return { id: docRef.id, ...data } as FirestoreProxy;
}

export async function createProxiesBulk(proxies: Omit<FirestoreProxy, 'id'>[], userId: string, teamId: string): Promise<{ added: number; failed: number }> {
  const now = new Date().toISOString();
  let added = 0;
  let failed = 0;
  const batch = writeBatch(db);

  for (const proxy of proxies) {
    try {
      const docRef = doc(collection(db, PROXIES_COLLECTION));
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

export async function deleteProxy(proxyId: string): Promise<void> {
  await deleteDoc(doc(db, PROXIES_COLLECTION, proxyId));
}

export async function deleteProxiesBulk(proxyIds: string[]): Promise<void> {
  const batch = writeBatch(db);
  for (const id of proxyIds) {
    batch.delete(doc(db, PROXIES_COLLECTION, id));
  }
  await batch.commit();
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
