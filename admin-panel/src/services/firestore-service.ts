import { collection, addDoc, getDocs, getCountFromServer, query, orderBy, limit, where, startAfter, doc, getDoc, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import { db } from './firebase';

export type UserRole = 'admin' | 'va';

export interface UserProfile {
  uid: string;
  email: string;
  role: UserRole;
  displayName?: string;
  createdAt: string;
}

export interface ActivityLogEntry {
  id?: string;
  userId: string;
  userName: string;
  action: string;
  targetProfileId?: string;
  targetProfileName?: string;
  timestamp: string;
  metadata?: Record<string, any>;
}

export interface ActivityLogFilters {
  userId?: string;
  action?: string;
  limitCount?: number;
  lastDoc?: any;
}

// --- Users ---

export async function getAllUsers(): Promise<UserProfile[]> {
  try {
    const snapshot = await getDocs(collection(db, 'users'));
    return snapshot.docs.map(d => ({ uid: d.id, ...d.data() })) as UserProfile[];
  } catch (error) {
    console.error('Failed to get users:', error);
    return [];
  }
}

export async function getUserProfile(uid: string): Promise<UserProfile | null> {
  try {
    const userDoc = await getDoc(doc(db, 'users', uid));
    if (userDoc.exists()) {
      return { uid: userDoc.id, ...userDoc.data() } as UserProfile;
    }
    return null;
  } catch (error) {
    console.error('Failed to get user:', error);
    return null;
  }
}

export async function createUserDoc(uid: string, email: string, role: UserRole): Promise<void> {
  await setDoc(doc(db, 'users', uid), {
    uid,
    email,
    role,
    createdAt: new Date().toISOString(),
  });
}

export async function updateUserRole(uid: string, role: UserRole): Promise<void> {
  await updateDoc(doc(db, 'users', uid), { role });
}

export async function deleteUserDoc(uid: string): Promise<void> {
  await deleteDoc(doc(db, 'users', uid));
}

// --- Activity Logs ---

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

    const q = query(collection(db, 'activityLogs'), ...constraints);
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

// --- Profiles ---

export interface BrowserProfile {
  id: string;
  name: string;
  os?: string;
  browserType?: string;
  tags?: string[];
  assignedTo?: string;
  assignedToEmail?: string;
  deleted?: boolean;
  deletedAt?: string;
  createdAt: string;
  createdBy?: string;
  lastUsed?: string;
  lastUrl?: string;
}

export async function getAllProfiles(): Promise<BrowserProfile[]> {
  try {
    const snapshot = await getDocs(query(collection(db, 'profiles'), orderBy('createdAt', 'desc')));
    return snapshot.docs.map(d => ({ id: d.id, ...d.data() })) as BrowserProfile[];
  } catch (error) {
    console.error('Failed to get profiles:', error);
    return [];
  }
}

// --- Stats ---

export async function getStats(): Promise<{ totalUsers: number; admins: number; vas: number; recentActions: number; totalProfiles: number }> {
  try {
    const [users, profiles, { entries }] = await Promise.all([
      getAllUsers(),
      getAllProfiles(),
      getActivityLogs({ limitCount: 100 }),
    ]);

    const admins = users.filter(u => u.role === 'admin').length;
    const vas = users.filter(u => u.role === 'va').length;
    const activeProfiles = profiles.filter(p => !p.deleted).length;

    return {
      totalUsers: users.length,
      admins,
      vas,
      recentActions: entries.length,
      totalProfiles: activeProfiles,
    };
  } catch {
    return { totalUsers: 0, admins: 0, vas: 0, recentActions: 0, totalProfiles: 0 };
  }
}
