import { signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged as firebaseOnAuthStateChanged, User } from 'firebase/auth';
import { doc, getDoc, collection, runTransaction } from 'firebase/firestore';
import { auth, db } from './firebase';
import { AppUser, UserRole } from '../../types';

class UserConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserConfigurationError';
  }
}

async function resolveUser(user: User): Promise<{ role: UserRole; teamId: string; assignedFolderId: string | null }> {
  const userRef = doc(db, 'users', user.uid);
  const userDoc = await getDoc(userRef);

  if (userDoc.exists()) {
    const data = userDoc.data();
    const role: UserRole = (data.role as UserRole) || 'va';
    const teamId = data.teamId;

    if (!teamId) {
      throw new UserConfigurationError('Ce compte doit être rattaché à une équipe par un administrateur');
    }

    return { role, teamId, assignedFolderId: data.assignedFolderId || null };
  }

  throw new UserConfigurationError('Compte non configuré. Utilisez un code d’invitation valide.');
}

function toAppUser(
  user: User,
  resolved: { role: UserRole; teamId: string; assignedFolderId: string | null }
): AppUser {
  return {
    uid: user.uid,
    email: user.email || '',
    displayName: user.displayName,
    role: resolved.role,
    teamId: resolved.teamId,
    assignedFolderId: resolved.assignedFolderId,
  };
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
  let cancelled = false;
  let generation = 0;
  let lastResolvedUser: AppUser | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const waitForRetry = (delay: number) => new Promise<void>(resolve => {
    retryTimer = setTimeout(() => {
      retryTimer = null;
      resolve();
    }, delay);
  });

  const unsubscribe = firebaseOnAuthStateChanged(auth, (firebaseUser) => {
    const currentGeneration = ++generation;
    if (!firebaseUser) {
      lastResolvedUser = null;
      callback(null);
      return;
    }

    void (async () => {
      let attempt = 0;
      while (!cancelled && currentGeneration === generation && auth.currentUser?.uid === firebaseUser.uid) {
        try {
          const resolved = await resolveUser(firebaseUser);
          if (cancelled || currentGeneration !== generation) return;
          lastResolvedUser = toAppUser(firebaseUser, resolved);
          callback(lastResolvedUser);
          return;
        } catch (error) {
          if (error instanceof UserConfigurationError) {
            console.error('Authenticated account is not configured:', error);
            await signOut(auth).catch(() => {});
            if (!cancelled && currentGeneration === generation) callback(null);
            return;
          }

          // A temporary network or Firestore failure must not destroy a valid
          // Firebase session. Keep the previous user and retry in the background.
          console.warn('Temporary user resolution failure; session retained:', error);
          if (lastResolvedUser?.uid === firebaseUser.uid && attempt === 0) {
            callback(lastResolvedUser);
          }
          const delays = [1000, 3000, 5000, 10000, 30000];
          await waitForRetry(delays[Math.min(attempt, delays.length - 1)]);
          attempt++;
        }
      }
    })();
  });

  return () => {
    cancelled = true;
    generation++;
    if (retryTimer) clearTimeout(retryTimer);
    unsubscribe();
  };
}
