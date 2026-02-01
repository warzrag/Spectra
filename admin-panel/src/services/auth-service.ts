import { signInWithEmailAndPassword, signOut, onAuthStateChanged as firebaseOnAuthStateChanged, sendPasswordResetEmail, User } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db, FIREBASE_API_KEY } from './firebase';

export type UserRole = 'admin' | 'va';

export interface AppUser {
  uid: string;
  email: string;
  role: UserRole;
}

const ADMIN_UIDS = [
  'EsZbVc0qtNYwTsUmXm9drmF5hu53',
];

async function resolveUserRole(user: User): Promise<UserRole> {
  if (ADMIN_UIDS.includes(user.uid)) return 'admin';

  try {
    const userDoc = await getDoc(doc(db, 'users', user.uid));
    if (userDoc.exists()) {
      const data = userDoc.data();
      if (data.role === 'admin' || data.role === 'va') {
        return data.role as UserRole;
      }
    }
  } catch {}

  return 'va';
}

export async function loginAdmin(email: string, password: string): Promise<AppUser> {
  const credential = await signInWithEmailAndPassword(auth, email, password);
  const role = await resolveUserRole(credential.user);
  if (role !== 'admin') {
    await signOut(auth);
    throw new Error('Access denied. Admin only.');
  }
  return {
    uid: credential.user.uid,
    email: credential.user.email || email,
    role,
  };
}

export async function logout(): Promise<void> {
  await signOut(auth);
}

export function onAuthStateChanged(callback: (user: AppUser | null) => void): () => void {
  return firebaseOnAuthStateChanged(auth, async (firebaseUser) => {
    if (firebaseUser) {
      const role = await resolveUserRole(firebaseUser);
      if (role === 'admin') {
        callback({ uid: firebaseUser.uid, email: firebaseUser.email || '', role });
      } else {
        await signOut(auth);
        callback(null);
      }
    } else {
      callback(null);
    }
  });
}

// Create a new Firebase Auth user via REST API (doesn't affect current session)
export async function createUserAccount(email: string, password: string): Promise<string> {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: false }),
    }
  );

  const data = await response.json();
  if (data.error) {
    throw new Error(data.error.message);
  }
  return data.localId; // This is the UID
}

// Send password reset email
export async function resetPassword(email: string): Promise<void> {
  await sendPasswordResetEmail(auth, email);
}
