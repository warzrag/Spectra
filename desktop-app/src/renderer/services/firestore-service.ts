import { collection, addDoc, getDocs, query, orderBy, limit, where, startAfter, doc, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, writeBatch, Unsubscribe } from 'firebase/firestore';
import { db } from './firebase';
import { ActivityLogEntry, UserProfile, Profile, Folder, Extension } from '../../types';

const ACTIVITY_COLLECTION = 'activityLogs';
const USERS_COLLECTION = 'users';
const PROFILES_COLLECTION = 'profiles';
const FOLDERS_COLLECTION = 'folders';
const EXTENSIONS_COLLECTION = 'extensions';

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
  userId?: string;
  action?: string;
  limitCount?: number;
  lastDoc?: any;
}

export async function getActivityLogs(filters: ActivityLogFilters = {}): Promise<{ entries: ActivityLogEntry[]; lastDoc: any }> {
  try {
    const constraints: any[] = [orderBy('timestamp', 'desc')];

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

export async function getAllUsers(): Promise<UserProfile[]> {
  try {
    const snapshot = await getDocs(collection(db, USERS_COLLECTION));
    return snapshot.docs.map(d => ({ uid: d.id, ...d.data() })) as UserProfile[];
  } catch (error) {
    console.error('Failed to get users:', error);
    return [];
  }
}

// ── Profiles (Cloud Sync) ──────────────────────────────────────

export function subscribeToProfiles(callback: (profiles: Profile[]) => void): Unsubscribe {
  const q = query(collection(db, PROFILES_COLLECTION), orderBy('createdAt', 'desc'));
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

export function subscribeToFolders(callback: (folders: Folder[]) => void): Unsubscribe {
  const q = query(collection(db, FOLDERS_COLLECTION), orderBy('createdAt', 'desc'));
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

export async function createProfile(profileData: Omit<Profile, 'id'>, userId: string): Promise<Profile> {
  const now = new Date().toISOString();
  const data = {
    ...profileData,
    createdBy: userId,
    createdAt: profileData.createdAt || now,
    updatedAt: now,
  };
  const docRef = await addDoc(collection(db, PROFILES_COLLECTION), data);
  return { id: docRef.id, ...data } as Profile;
}

export async function updateProfile(profileId: string, data: Partial<Profile>): Promise<void> {
  const { id, ...updateData } = data as any;
  await updateDoc(doc(db, PROFILES_COLLECTION, profileId), {
    ...updateData,
    updatedAt: new Date().toISOString(),
  });
}

export async function deleteProfile(profileId: string): Promise<void> {
  await deleteDoc(doc(db, PROFILES_COLLECTION, profileId));
}

export async function getAllProfilesOnce(): Promise<Profile[]> {
  try {
    const snapshot = await getDocs(collection(db, PROFILES_COLLECTION));
    return snapshot.docs.map(d => ({ id: d.id, ...d.data() })) as Profile[];
  } catch (error) {
    console.error('Failed to get profiles:', error);
    return [];
  }
}

// ── Folders (Cloud Sync) ───────────────────────────────────────

export async function createFolder(folderData: Omit<Folder, 'id'>, userId: string): Promise<Folder> {
  const now = new Date().toISOString();
  const data = {
    ...folderData,
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
  // Batch: remove folderId from all profiles in this folder + delete the folder
  const batch = writeBatch(db);

  const profilesInFolder = await getDocs(
    query(collection(db, PROFILES_COLLECTION), where('folderId', '==', folderId))
  );
  profilesInFolder.docs.forEach(d => {
    batch.update(d.ref, { folderId: null, updatedAt: new Date().toISOString() });
  });

  batch.delete(doc(db, FOLDERS_COLLECTION, folderId));
  await batch.commit();
}

// ── Migration: local electron-store → Firestore ───────────────

export async function migrateLocalProfiles(localProfiles: Profile[], localFolders: Folder[], userId: string): Promise<void> {
  // Check if Firestore already has data (another device migrated)
  const existing = await getAllProfilesOnce();
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
    await setDoc(doc(db, FOLDERS_COLLECTION, id), { ...folderData, createdBy: userId });
  }

  for (const profile of localProfiles) {
    const { id, ...profileData } = profile;
    await setDoc(doc(db, PROFILES_COLLECTION, id), { ...profileData, createdBy: userId, updatedAt: new Date().toISOString() });
  }

  console.log('Migration complete');
}

// ── Extensions (Cloud Sync) ────────────────────────────────────

export function subscribeToExtensions(callback: (extensions: Extension[]) => void): Unsubscribe {
  const q = query(collection(db, EXTENSIONS_COLLECTION), orderBy('createdAt', 'desc'));
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

export async function registerExtension(ext: Omit<Extension, 'id'> & { id: string }): Promise<void> {
  const { id, ...data } = ext;
  await setDoc(doc(db, EXTENSIONS_COLLECTION, id), data);
}

export async function setExtensionEnabled(extensionId: string, enabled: boolean): Promise<void> {
  await updateDoc(doc(db, EXTENSIONS_COLLECTION, extensionId), { enabled });
}

export async function unregisterExtension(extensionId: string): Promise<void> {
  await deleteDoc(doc(db, EXTENSIONS_COLLECTION, extensionId));
}
