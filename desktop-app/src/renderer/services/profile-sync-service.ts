import { ref, uploadBytesResumable, getDownloadURL, getBlob } from 'firebase/storage';
import { storage } from './firebase';
import { updateProfile } from './firestore-service';
import { Profile } from '../../types';

const STALE_LOCK_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Upload a Chrome profile to Firebase Storage after the browser closes.
 */
export async function uploadProfileToCloud(
  profileId: string,
  currentUser: { uid: string; email: string },
  onProgress?: (percent: number) => void
): Promise<void> {
  // 1. Zip profile via main process
  console.log(`[ProfileSync] Starting upload for ${profileId}`);
  const result = await (window as any).electronAPI.profileSync.zipForSync(profileId);
  const zipData = new Uint8Array(result.buffer);
  console.log(`[ProfileSync] Zip ready: ${(result.size / 1024 / 1024).toFixed(2)} MB`);

  // 2. Upload to Firebase Storage with progress
  const storageRef = ref(storage, `profiles/${profileId}/profile.zip`);
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

  // 4. Update Firestore metadata
  const localVersion = await (window as any).electronAPI.profileSync.getLocalSyncVersion(profileId);
  const newVersion = (localVersion || 0) + 1;

  await updateProfile(profileId, {
    cloudStorageUrl: downloadUrl,
    cloudSyncedAt: new Date().toISOString(),
    cloudSyncSize: result.size,
    cloudSyncVersion: newVersion,
  } as any);

  // 5. Update local sync version
  await (window as any).electronAPI.profileSync.setLocalSyncVersion(profileId, newVersion);
  console.log(`[ProfileSync] Upload complete, version=${newVersion}`);
}

/**
 * Download a Chrome profile from Firebase Storage before launching.
 */
export async function downloadProfileFromCloud(
  profileId: string,
  cloudSyncVersion: number,
  onProgress?: (percent: number) => void
): Promise<void> {
  console.log(`[ProfileSync] Starting download for ${profileId}`);
  onProgress?.(10);

  // 1. Download zip from Firebase Storage
  const storageRef = ref(storage, `profiles/${profileId}/profile.zip`);
  const blob = await getBlob(storageRef);
  const arrayBuffer = await blob.arrayBuffer();
  const zipData = new Uint8Array(arrayBuffer);
  console.log(`[ProfileSync] Downloaded: ${(arrayBuffer.byteLength / 1024 / 1024).toFixed(2)} MB`);
  onProgress?.(60);

  // 2. Extract via main process
  await (window as any).electronAPI.profileSync.unzipFromSync(profileId, zipData);
  onProgress?.(90);

  // 3. Update local sync version
  await (window as any).electronAPI.profileSync.setLocalSyncVersion(profileId, cloudSyncVersion);
  onProgress?.(100);
  console.log(`[ProfileSync] Download complete, version=${cloudSyncVersion}`);
}

/**
 * Check if cloud data needs to be downloaded before launching.
 */
export async function needsCloudDownload(profile: Profile): Promise<boolean> {
  if (!profile.cloudStorageUrl || !profile.cloudSyncVersion) return false;

  const hasLocal = await (window as any).electronAPI.profileSync.hasLocalData(profile.id);
  if (!hasLocal) return true;

  const localVersion = await (window as any).electronAPI.profileSync.getLocalSyncVersion(profile.id);
  return profile.cloudSyncVersion > localVersion;
}

/**
 * Check if a profile is locked by another user.
 */
export function isLockedByOther(profile: Profile, currentUserId: string): boolean {
  if (!profile.lockedBy || profile.lockedBy === currentUserId) return false;

  // Check if lock is stale
  if (profile.lockedAt) {
    const lockAge = Date.now() - new Date(profile.lockedAt).getTime();
    if (lockAge > STALE_LOCK_MS) return false; // Stale lock, can override
  }

  return true;
}

/**
 * Acquire a lock on a profile before launching.
 */
export async function acquireProfileLock(
  profileId: string,
  user: { uid: string; email: string }
): Promise<void> {
  let deviceName = 'PC';
  try {
    deviceName = await (window as any).electronAPI.profileSync.getHostname();
  } catch {}

  await updateProfile(profileId, {
    lockedBy: user.uid,
    lockedByEmail: user.email,
    lockedByDevice: deviceName,
    lockedAt: new Date().toISOString(),
  } as any);
}

/**
 * Release the lock on a profile after closing.
 */
export async function releaseProfileLock(profileId: string): Promise<void> {
  await updateProfile(profileId, {
    lockedBy: null,
    lockedByEmail: null,
    lockedByDevice: null,
    lockedAt: null,
  } as any);
}
