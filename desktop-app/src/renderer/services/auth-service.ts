import { signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged as firebaseOnAuthStateChanged, User } from 'firebase/auth';
import { doc, getDoc, collection, runTransaction } from 'firebase/firestore';
import { auth, db } from './firebase';
import { AppUser, UserRole } from '../../types';

async function resolveUser(user: User): Promise<{ role: UserRole; teamId: string; assignedFolderId: string | null }> {
  const userRef = doc(db, 'users', user.uid);
  const userDoc = await getDoc(userRef);

  if (userDoc.exists()) {
    const data = userDoc.data();
    const role: UserRole = (data.role as UserRole) || 'va';
    const teamId = data.teamId;

    if (!teamId) {
      throw new Error('Ce compte doit être rattaché à une équipe par un administrateur');
    }

    return { role, teamId, assignedFolderId: data.assignedFolderId || null };
  }

  throw new Error('Compte non configuré. Utilisez un code d’invitation valide.');
}

export async function loginWithEmail(email: string, password: string): Promise<AppUser> {
  const credential = await signInWithEmailAndPassword(auth, email, password);
  const { role, teamId, assignedFolderId } = await resolveUser(credential.user);
  return {
    uid: credential.user.uid,
    email: credential.user.email || email,
    displayName: credential.user.displayName,
    role,
    teamId,
    assignedFolderId,
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
    let personalTeamRef: ReturnType<typeof doc> | null = null;

    if (codeData.codeType === 'team' && codeData.teamId) {
      teamId = codeData.teamId;
      role = 'va';
    } else {
      personalTeamRef = doc(collection(db, 'teams'));
      teamId = personalTeamRef.id;
      role = 'owner';
    }

    // 4. Claim the invite and create the membership atomically.
    await runTransaction(db, async (transaction) => {
      const latestCodeSnap = await transaction.get(codeRef);
      if (!latestCodeSnap.exists() || latestCodeSnap.data().used) {
        throw new Error('Ce code a déjà été utilisé');
      }
      const latestCode = latestCodeSnap.data();
      if (
        (role === 'va' && (latestCode.codeType !== 'team' || latestCode.teamId !== teamId)) ||
        (role === 'owner' && latestCode.codeType !== 'personal')
      ) {
        throw new Error('Ce code d\'invitation ne correspond pas à ce compte');
      }

      const now = new Date().toISOString();
      if (personalTeamRef) {
        transaction.set(personalTeamRef, {
          name: email,
          ownerId: user.uid,
          inviteCode,
          createdAt: now,
        });
      }
      transaction.set(doc(db, 'users', user.uid), {
        uid: user.uid,
        email: user.email,
        role,
        teamId,
        inviteCode,
        createdAt: now,
      });
      transaction.update(codeRef, {
        used: true,
        usedBy: user.uid,
        usedByEmail: email,
        usedAt: now,
      });
    });

    return {
      uid: user.uid,
      email: user.email || email,
      displayName: user.displayName,
      role,
      teamId,
      assignedFolderId: null,
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
      try {
        const { role, teamId, assignedFolderId } = await resolveUser(firebaseUser);
        callback({
          uid: firebaseUser.uid,
          email: firebaseUser.email || '',
          displayName: firebaseUser.displayName,
          role,
          teamId,
          assignedFolderId,
        });
      } catch (error) {
        console.error('Unable to resolve authenticated user:', error);
        await signOut(auth).catch(() => {});
        callback(null);
      }
    } else {
      callback(null);
    }
  });
}
