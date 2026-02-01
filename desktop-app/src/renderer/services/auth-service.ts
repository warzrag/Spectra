import { signInWithEmailAndPassword, signOut, onAuthStateChanged as firebaseOnAuthStateChanged, User } from 'firebase/auth';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { auth, db } from './firebase';
import { AppUser, UserRole } from '../../types';

// Admin UIDs - these users always get admin role
const ADMIN_UIDS = [
  'EsZbVc0qtNYwTsUmXm9drmF5hu53',
];

async function resolveUserRole(user: User): Promise<UserRole> {
  // Check hardcoded admin list first
  if (ADMIN_UIDS.includes(user.uid)) {
    // Auto-create Firestore doc if missing
    try {
      const userRef = doc(db, 'users', user.uid);
      const userDoc = await getDoc(userRef);
      if (!userDoc.exists()) {
        await setDoc(userRef, {
          uid: user.uid,
          email: user.email,
          role: 'admin',
          createdAt: new Date().toISOString(),
        });
      }
    } catch {}
    return 'admin';
  }

  // Try custom claims
  try {
    const tokenResult = await user.getIdTokenResult();
    if (tokenResult.claims.role === 'admin' || tokenResult.claims.role === 'va') {
      return tokenResult.claims.role as UserRole;
    }
  } catch {}

  // Fallback: check Firestore users collection
  try {
    const userRef = doc(db, 'users', user.uid);
    const userDoc = await getDoc(userRef);
    if (userDoc.exists()) {
      const data = userDoc.data();
      if (data.role === 'admin' || data.role === 'va') {
        return data.role as UserRole;
      }
    } else {
      // Auto-create as VA if no document exists
      await setDoc(userRef, {
        uid: user.uid,
        email: user.email,
        role: 'va',
        createdAt: new Date().toISOString(),
      });
    }
  } catch {}

  // Default to VA (least privilege)
  return 'va';
}

export async function loginWithEmail(email: string, password: string): Promise<AppUser> {
  const credential = await signInWithEmailAndPassword(auth, email, password);
  const role = await resolveUserRole(credential.user);
  return {
    uid: credential.user.uid,
    email: credential.user.email || email,
    displayName: credential.user.displayName,
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
      callback({
        uid: firebaseUser.uid,
        email: firebaseUser.email || '',
        displayName: firebaseUser.displayName,
        role,
      });
    } else {
      callback(null);
    }
  });
}
