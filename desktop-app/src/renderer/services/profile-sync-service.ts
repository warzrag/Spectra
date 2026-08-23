import { ref, uploadBytes, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { doc, runTransaction, serverTimestamp } from 'firebase/firestore';
import { auth, storage, db } from './firebase';
import { Profile } from '../../types';

const STALE_LOCK_MS = 2 * 60 * 60 * 1000; // 2 hours

function getLockTimeMillis(value: unknown): number | null {
  if (!value) return null;
  if (typeof value === 'object' && typeof (value as { toMillis?: unknown }).toMillis === 'function') {
    return (value as { toMillis: () => number }).toMillis();
  }
  const parsed = new Date(value as string | number | Date).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const bytes = Uint8Array.from(data);
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer);
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Upload a Chrome profile to Firebase Storage after the browser closes.
 */
export async function uploadProfileToCloud(
  profileId: string,
  currentUser: {
    uid: string;
    email: string;
    deviceName?: string | null;
    installationId?: string | null;
  },
  onProgress?: (percent: number) => void
): Promise<void> {
  const baseVersion = Number(
    await (window as any).electronAPI.profileSync.getLocalSyncVersion(profileId) || 0
  );
  const baseRevision = await (window as any).electronAPI.profileSync.getLocalSyncRevision(profileId);

  // 1. Zip profile via main process
  console.log(`[ProfileSync] Starting upload for ${profileId}`);
  const result = await (window as any).electronAPI.profileSync.zipForSync(profileId);
  const zipData = new Uint8Array(result.buffer);
  const checksum = await sha256Hex(zipData);
  console.log(`[ProfileSync] Zip ready: ${(result.size / 1024 / 1024).toFixed(2)} MB`);

  // Upload an immutable revision so concurrent PCs cannot overwrite the bytes
  // behind a version that another machine already considers current.
  const revisionId = `${Date.now()}-${crypto.randomUUID()}`;
  const storageRef = ref(storage, `profiles/${profileId}/revisions/${revisionId}.zip`);
  const uploadTask = uploadBytesResumable(storageRef, zipData);

  await new Promise<void>((resolve, reject) => {
    uploadTask.on('state_changed',
      (snapshot) => {
        const percent = Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100);
        onProgress?.(percent);
      },
      (error) => reject(error),
      () => resolve()
    );
  });

  // 3. Get download URL
  const downloadUrl = await getDownloadURL(storageRef);

  // Allocate the next cloud version atomically from the server value.
  const profileRef = doc(db, 'profiles', profileId);
  let newVersion = 0;
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(profileRef);
    if (!snapshot.exists()) throw new Error('Profile no longer exists');

    const cloudProfile = snapshot.data() as Profile;
    const cloudVersion = Number(cloudProfile.cloudSyncVersion || 0);
    const cloudRevision = cloudProfile.cloudSyncRevision || null;
    const revisionConflict = Boolean(
      baseRevision &&
      !baseRevision.startsWith('legacy:') &&
      cloudRevision &&
      cloudRevision !== baseRevision
    );
    if (cloudVersion !== baseVersion || revisionConflict) {
      const conflictError = new Error(
        'Cloud profile changed on another device; local upload was cancelled'
      ) as Error & { code?: string };
      conflictError.code = 'profile-sync/conflict';
      throw conflictError;
    }
    if (cloudProfile.lockedBy !== currentUser.uid) {
      throw new Error('Profile lock is no longer owned by this account');
    }
    if (
      currentUser.installationId &&
      cloudProfile.lockedByInstallationId &&
      cloudProfile.lockedByInstallationId !== currentUser.installationId
    ) {
      throw new Error('Profile lock moved to another installation');
    }
    if (
      currentUser.deviceName &&
      cloudProfile.lockedByDevice &&
      cloudProfile.lockedByDevice !== currentUser.deviceName
    ) {
      throw new Error('Profile lock moved to another device');
    }

    newVersion = cloudVersion + 1;
    transaction.update(profileRef, {
      cloudStorageUrl: downloadUrl,
      cloudSyncedAt: new Date().toISOString(),
      cloudSyncSize: result.size,
      cloudSyncVersion: newVersion,
      cloudSyncRevision: revisionId,
      cloudSyncProtocolVersion: 2,
      cloudSyncChecksum: checksum,
      cloudSyncChecksumRevision: revisionId,
      cloudSyncedBy: currentUser.uid,
    });
  });

  // Compatibility mirror for older Spectra clients. It is updated only after
  // the revision transaction succeeds, so a rejected stale client cannot
  // overwrite the shared mutable object.
  await uploadBytes(ref(storage, `profiles/${profileId}/profile.zip`), zipData);

  // 5. Update local sync version
  await (window as any).electronAPI.profileSync.setLocalSyncVersion(profileId, newVersion);
  await (window as any).electronAPI.profileSync.setLocalSyncRevision(profileId, revisionId);
  console.log(`[ProfileSync] Upload complete, version=${newVersion}, revision=${revisionId}`);
}

/**
 * Download a Chrome profile from Firebase Storage before launching.
 */
export async function downloadProfileFromCloud(
  profile: Profile,
  onProgress?: (percent: number) => void
): Promise<void> {
  const profileId = profile.id;
  const cloudSyncVersion = Number(profile.cloudSyncVersion || 0);
  console.log(`[ProfileSync] Starting download for ${profileId}`);
  onProgress?.(10);

  // 1. Download zip from Firebase Storage
  const downloadUrl = profile.cloudStorageUrl ||
    await getDownloadURL(ref(storage, `profiles/${profileId}/profile.zip`));
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error('Firebase session expired');

  const unsubscribeProgress = (window as any).electronAPI.profileSync.onDownloadProgress(
    (progressProfileId: string, percent: number) => {
      if (progressProfileId === profileId) onProgress?.(percent);
    }
  );
  let zipData: Uint8Array;
  try {
    const downloaded = await (window as any).electronAPI.profileSync.downloadFromCloud(
      profileId,
      downloadUrl,
      idToken
    );
    zipData = new Uint8Array(downloaded);
  } finally {
    unsubscribeProgress();
  }
  const arrayBuffer = zipData.buffer;
  const expectedRevision = getExpectedCloudRevision(profile);
  const checksumMatchesRevision = Boolean(
    profile.cloudSyncChecksum &&
    profile.cloudSyncChecksumRevision &&
    profile.cloudSyncChecksumRevision === expectedRevision
  );
  if (checksumMatchesRevision) {
    const actualChecksum = await sha256Hex(zipData);
    if (actualChecksum !== profile.cloudSyncChecksum) {
      throw new Error('Cloud profile integrity check failed');
    }
  } else if (profile.cloudSyncChecksum) {
    console.warn(
      `[ProfileSync] Ignoring stale checksum for ${profileId}: ` +
      `${profile.cloudSyncChecksumRevision || 'unversioned'} != ${expectedRevision || 'legacy'}`
    );
  }
  console.log(`[ProfileSync] Downloaded: ${(arrayBuffer.byteLength / 1024 / 1024).toFixed(2)} MB`);
  onProgress?.(60);

  // 2. Extract via main process
  await (window as any).electronAPI.profileSync.unzipFromSync(profileId, zipData);
  onProgress?.(90);

  // 3. Update local sync version
  await (window as any).electronAPI.profileSync.setLocalSyncVersion(profileId, cloudSyncVersion);
  if (expectedRevision) {
    await (window as any).electronAPI.profileSync.setLocalSyncRevision(profileId, expectedRevision);
  }
  onProgress?.(100);
  console.log(`[ProfileSync] Download complete, version=${cloudSyncVersion}, revision=${profile.cloudSyncRevision || 'legacy'}`);
}

/**
 * Check if cloud data needs to be downloaded before launching.
 */
export async function needsCloudDownload(profile: Profile): Promise<boolean> {
  if (!profile.cloudStorageUrl || !profile.cloudSyncVersion) return false;

  const hasLocal = await (window as any).electronAPI.profileSync.hasLocalData(profile.id);
  if (!hasLocal) return true;

  if (profile.cloudSyncRevision) {
    const localRevision = await (window as any).electronAPI.profileSync.getLocalSyncRevision(profile.id);
    return localRevision !== getExpectedCloudRevision(profile);
  }

  const localVersion = await (window as any).electronAPI.profileSync.getLocalSyncVersion(profile.id);
  return Number(profile.cloudSyncVersion) > Number(localVersion || 0);
}

function getExpectedCloudRevision(profile: Profile): string | null {
  if (!profile.cloudSyncRevision) return null;

  // Older Spectra clients overwrite cloudStorageUrl with the mutable legacy
  // profile.zip without clearing cloudSyncRevision. Treat that write as its own
  // revision so updated clients download it instead of incorrectly skipping.
  const urlPointsToRevision = Boolean(
    profile.cloudStorageUrl &&
    profile.cloudStorageUrl.includes(profile.cloudSyncRevision)
  );
  if (urlPointsToRevision) return profile.cloudSyncRevision;

  return `legacy:${profile.cloudSyncedAt || 'unknown'}:${Number(profile.cloudSyncVersion || 0)}`;
}

/**
 * Check if a profile is locked by another user.
 */
export function isLockedByOther(
  profile: Profile,
  currentUserId: string,
  currentDeviceName?: string | null,
  currentInstallationId?: string | null
): boolean {
  if (!profile.lockedBy) return false;

  // Check if lock is stale
  if (profile.lockedAt) {
    const lockTime = getLockTimeMillis(profile.lockedAt);
    if (lockTime !== null && Date.now() - lockTime > STALE_LOCK_MS) return false;
  }

  if (profile.lockedBy !== currentUserId) return true;

  if (currentInstallationId && profile.lockedByInstallationId) {
    return profile.lockedByInstallationId !== currentInstallationId;
  }

  return !!(
    currentDeviceName &&
    profile.lockedByDevice &&
    profile.lockedByDevice !== currentDeviceName
  );
}

/**
 * Acquire a lock on a profile before launching.
 */
export async function acquireProfileLock(
  profileId: string,
  user: { uid: string; email: string },
  installationId?: string | null
): Promise<string> {
  let deviceName = 'PC';
  try {
    deviceName = await (window as any).electronAPI.profileSync.getHostname();
  } catch {}

  const profileRef = doc(db, 'profiles', profileId);
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(profileRef);
    if (!snapshot.exists()) throw new Error('Profile no longer exists');

    const profile = snapshot.data() as Profile;
    const lockTime = getLockTimeMillis(profile.lockedAt);
    const lockIsFresh = Boolean(
      profile.lockedBy &&
      (lockTime === null || Date.now() - lockTime <= STALE_LOCK_MS)
    );
    const belongsToThisDevice = profile.lockedBy === user.uid && (
      profile.lockedByInstallationId
        ? Boolean(installationId && profile.lockedByInstallationId === installationId)
        : (!profile.lockedByDevice || profile.lockedByDevice === deviceName)
    );

    if (lockIsFresh && !belongsToThisDevice) {
      throw new Error(`Profile in use by ${profile.lockedByEmail || 'another user'} on ${profile.lockedByDevice || 'another PC'}`);
    }

    transaction.update(profileRef, {
      lockedBy: user.uid,
      lockedByEmail: user.email,
      lockedByDevice: deviceName,
      lockedByInstallationId: installationId || null,
      lockedAt: serverTimestamp(),
    });
  });

  return deviceName;
}

/**
 * Refresh the lock while a profile is still running locally.
 */
export async function refreshProfileLock(
  profileId: string,
  owner?: { uid: string; deviceName?: string | null; installationId?: string | null }
): Promise<void> {
  const profileRef = doc(db, 'profiles', profileId);
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(profileRef);
    const data = snapshot.data() as Profile | undefined;
    if (!data) return;
    if (owner && data.lockedBy !== owner.uid) return;
    if (owner?.installationId && data.lockedByInstallationId && data.lockedByInstallationId !== owner.installationId) return;
    if (owner?.deviceName && data.lockedByDevice && data.lockedByDevice !== owner.deviceName) return;

    transaction.update(profileRef, {
      lockedAt: serverTimestamp(),
    });
  });
}

/**
 * Release the lock on a profile after closing, but only if it still belongs to this device/user.
 */
export async function releaseProfileLock(
  profileId: string,
  owner?: { uid: string; deviceName?: string | null; installationId?: string | null }
): Promise<void> {
  const profileRef = doc(db, 'profiles', profileId);
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(profileRef);
    const data = snapshot.data() as Profile | undefined;
    if (!data) return;
    if (owner && data.lockedBy !== owner.uid) return;
    if (owner?.installationId && data.lockedByInstallationId && data.lockedByInstallationId !== owner.installationId) return;
    if (owner?.deviceName && data.lockedByDevice && data.lockedByDevice !== owner.deviceName) return;

    transaction.update(profileRef, {
      lockedBy: null,
      lockedByEmail: null,
      lockedByDevice: null,
      lockedByInstallationId: null,
      lockedAt: null,
    });
  });
}
