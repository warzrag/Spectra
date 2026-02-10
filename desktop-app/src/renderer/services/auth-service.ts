import { signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged as firebaseOnAuthStateChanged, User } from 'firebase/auth';
import { doc, getDoc, setDoc, addDoc, collection, updateDoc } from 'firebase/firestore';
import { auth, db } from './firebase';
import { AppUser, UserRole } from '../../types';

// Admin UIDs - these users always get admin role
const ADMIN_UIDS = [
  'EsZbVc0qtNYwTsUmXm9drmF5hu53',
];

async function resolveUser(user: User): Promise<{ role: UserRole; teamId: string }> {
  const userRef = doc(db, 'users', user.uid);
  const userDoc = await getDoc(userRef);

  if (userDoc.exists()) {
    const data = userDoc.data();
    const role: UserRole = ADMIN_UIDS.includes(user.uid)
      ? 'owner'
      : (data.role as UserRole) || 'va';
    const teamId = data.teamId;

    // Safety: if existing user has no teamId (legacy), create a team for them
    if (!teamId) {
      const teamRef = await addDoc(collection(db, 'teams'), {
        name: user.email || 'My Team',
        ownerId: user.uid,
        createdAt: new Date().toISOString(),
      });
      await setDoc(userRef, { ...data, teamId: teamRef.id, role }, { merge: true });
      return { role, teamId: teamRef.id };
    }

    return { role, teamId };
  }

  // First login ever → create team + user document
  const isAdmin = ADMIN_UIDS.includes(user.uid);
  const role: UserRole = isAdmin ? 'owner' : 'owner'; // New users are always owner of their own team

  const teamRef = await addDoc(collection(db, 'teams'), {
    name: user.email || 'My Team',
    ownerId: user.uid,
    createdAt: new Date().toISOString(),
  });

  await setDoc(userRef, {
    uid: user.uid,
    email: user.email,
    role,
    teamId: teamRef.id,
    createdAt: new Date().toISOString(),
  });

  return { role, teamId: teamRef.id };
}

export async function loginWithEmail(email: string, password: string): Promise<AppUser> {
  const credential = await signInWithEmailAndPassword(auth, email, password);
  const { role, teamId } = await resolveUser(credential.user);
  return {
    uid: credential.user.uid,
    email: credential.user.email || email,
    displayName: credential.user.displayName,
    role,
    teamId,
  };
}

export async function registerWithInviteCode(email: string, password: string, inviteCode: string): Promise<AppUser> {
  // 1. Create Firebase Auth account FIRST (so we're authenticated for Firestore)
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  const user = credential.user;

  try {
    // 2. Validate invite code (now authenticated)
    const codeRef = doc(db, 'inviteCodes', inviteCode);
    const codeSnap = await getDoc(codeRef);
    if (!codeSnap.exists()) {
      await user.delete();
      throw new Error('Code d\'invitation invalide');
    }
    const codeData = codeSnap.data();
    if (codeData.used) {
      await user.delete();
      throw new Error('Ce code a déjà été utilisé');
    }

    // 3. Determine team based on code type
    let teamId: string;
    let role: UserRole;

    if (codeData.codeType === 'team' && codeData.teamId) {
      teamId = codeData.teamId;
      role = 'va';
    } else {
      const teamRef = await addDoc(collection(db, 'teams'), {
        name: email,
        ownerId: user.uid,
        createdAt: new Date().toISOString(),
      });
      teamId = teamRef.id;
      role = 'owner';
    }

    // 4. Create user document
    await setDoc(doc(db, 'users', user.uid), {
      uid: user.uid,
      email: user.email,
      role,
      teamId,
      createdAt: new Date().toISOString(),
    });

    // 5. Mark invite code as used
    await updateDoc(codeRef, {
      used: true,
      usedBy: user.uid,
      usedByEmail: email,
      usedAt: new Date().toISOString(),
    });

    return {
      uid: user.uid,
      email: user.email || email,
      displayName: user.displayName,
      role,
      teamId,
    };
  } catch (error) {
    await signOut(auth).catch(() => {});
    throw error;
  }
}

export async function logout(): Promise<void> {
  await signOut(auth);
}

export function onAuthStateChanged(callback: (user: AppUser | null) => void): () => void {
  return firebaseOnAuthStateChanged(auth, async (firebaseUser) => {
    if (firebaseUser) {
      const { role, teamId } = await resolveUser(firebaseUser);
      callback({
        uid: firebaseUser.uid,
        email: firebaseUser.email || '',
        displayName: firebaseUser.displayName,
        role,
        teamId,
      });
    } else {
      callback(null);
    }
  });
}
