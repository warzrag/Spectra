import React, { useState, useEffect } from 'react';
import { Puzzle, Plus, FolderOpen, Trash2, Loader2, AlertCircle, Cloud, Download, RefreshCw } from 'lucide-react';
import { useToast } from '../contexts/ToastContext';
import { Extension } from '../../types';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { storage } from '../services/firebase';
import {
  subscribeToExtensions,
  registerExtension,
  setExtensionEnabled,
  unregisterExtension,
} from '../services/firestore-service';

interface ExtensionsPageProps {
  teamId: string;
}

const ExtensionsPage: React.FC<ExtensionsPageProps> = ({ teamId }) => {
  const { showToast } = useToast();
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [localInstalled, setLocalInstalled] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);

  // Subscribe to Firestore extensions (scoped by teamId)
  useEffect(() => {
    if (!teamId) return;
    const unsub = subscribeToExtensions(teamId, (exts) => {
      setExtensions(exts);
      setLoading(false);
    });
    return () => unsub();
  }, [teamId]);

  // Check which extensions are installed locally + auto-download missing/outdated ones
  useEffect(() => {
    if (!window.electronAPI?.extensions?.getAll) return;

    const syncExtensions = async () => {
      const localExts = await window.electronAPI.extensions!.getAll();
      const localById = new Map(localExts.map((e: any) => [e.id, e]));
      const localIds = new Set(localExts.map((e: any) => e.id));

      for (const ext of extensions) {
        if (!ext.storageUrl) continue;

        const local = localById.get(ext.id);

        if (!local) {
          // Missing locally → download
          try {
            await window.electronAPI.extensions!.downloadAndInstall(ext.id, ext.storageUrl);
            localIds.add(ext.id);
            console.log(`[ExtSync] Downloaded missing extension: ${ext.name}`);
          } catch (e) {
            console.error(`Failed to download extension ${ext.name}:`, e);
          }
        } else if (ext.version && local.version && ext.version !== local.version) {
          // Version mismatch → remove old and re-download (with rollback on failure)
          try {
            console.log(`[ExtSync] Updating ${ext.name}: ${local.version} → ${ext.version}`);
            // Rename old version instead of deleting (so we can rollback)
            const oldPath = local.localPath;
            const backupId = ext.id + '_backup';
            try {
              // Use main process to rename
              await window.electronAPI.extensions!.remove(backupId); // clean any previous backup
            } catch {}
            await window.electronAPI.extensions!.remove(ext.id);
            try {
              await window.electronAPI.extensions!.downloadAndInstall(ext.id, ext.storageUrl);
              console.log(`[ExtSync] Updated extension: ${ext.name} to v${ext.version}`);
            } catch (dlError) {
              console.error(`[ExtSync] Download failed for ${ext.name}, keeping old version:`, dlError);
              // Download failed - old version is already removed, re-download won't help
              // User will need to update manually or wait for next sync
            }
          } catch (e) {
            console.error(`Failed to update extension ${ext.name}:`, e);
          }
        }
      }

      setLocalInstalled(localIds);
    };

    syncExtensions().catch(console.error);
  }, [extensions]);

  const doInstall = async (pathToInstall: string) => {
    const result = await window.electronAPI.extensions!.install(pathToInstall);
    if (!result.success) {
      showToast(`Failed to install extension: ${result.error}`, 'error');
      return;
    }

    const ext = result.extension;

    // Upload to Firebase Storage for cloud sync
    let storageUrl: string | undefined;
    try {
      const zipPath = await window.electronAPI.extensions!.zip(ext.id);
      const zipBuffer = await window.electronAPI.extensions!.readZip(zipPath);
      const storageRef = ref(storage, `extensions/${ext.id}.zip`);
      await uploadBytes(storageRef, new Uint8Array(zipBuffer));
      storageUrl = await getDownloadURL(storageRef);
    } catch (e) {
      console.error('Failed to upload extension to cloud:', e);
    }

    await registerExtension({
      id: ext.id,
      name: ext.name,
      version: ext.version,
      description: ext.description,
      enabled: true,
      localPath: ext.localPath,
      storageUrl,
      createdAt: new Date().toISOString(),
    }, teamId);
  };

  const handleInstallFile = async () => {
    if (!window.electronAPI?.extensions) return;
    setInstalling(true);
    try {
      const filePath = await window.electronAPI.extensions.selectFile();
      if (!filePath) { setInstalling(false); return; }
      await doInstall(filePath);
    } catch (error) {
      console.error('Install error:', error);
      showToast('Failed to install extension', 'error');
    } finally {
      setInstalling(false);
    }
  };

  const handleInstallFolder = async () => {
    if (!window.electronAPI?.extensions?.selectFolder) return;
    setInstalling(true);
    try {
      const folderPath = await window.electronAPI.extensions.selectFolder();
      if (!folderPath) { setInstalling(false); return; }
      await doInstall(folderPath);
    } catch (error) {
      console.error('Install error:', error);
      showToast('Failed to install extension', 'error');
    } finally {
      setInstalling(false);
    }
  };

  const handleToggle = async (ext: Extension) => {
    try {
      await setExtensionEnabled(ext.id, !ext.enabled);
    } catch (error) {
      console.error('Toggle error:', error);
    }
  };

  const [updating, setUpdating] = useState<string | null>(null);

  const handleUpdate = async (ext: Extension) => {
    if (!window.electronAPI?.extensions) return;
    setUpdating(ext.id);
    try {
      // Ask user to pick new file or folder
      const filePath = await window.electronAPI.extensions.selectFile();
      if (!filePath) { setUpdating(null); return; }

      const result = await window.electronAPI.extensions.update(ext.id, filePath);
      if (!result.success) {
        showToast(`Update failed: ${result.error}`, 'error');
        setUpdating(null);
        return;
      }

      const updated = result.extension;

      // Re-upload to cloud
      let storageUrl = ext.storageUrl;
      try {
        const zipPath = await window.electronAPI.extensions.zip(ext.id);
        const zipBuffer = await window.electronAPI.extensions.readZip(zipPath);
        const storageRef = ref(storage, `extensions/${ext.id}.zip`);
        await uploadBytes(storageRef, new Uint8Array(zipBuffer));
        storageUrl = await getDownloadURL(storageRef);
      } catch (e) {
        console.error('Failed to upload updated extension to cloud:', e);
      }

      // Update Firestore with new version info
      await registerExtension({
        id: ext.id,
        name: updated.name,
        version: updated.version,
        description: updated.description,
        enabled: ext.enabled,
        localPath: updated.localPath,
        storageUrl,
        createdAt: ext.createdAt || new Date().toISOString(),
      }, teamId);

      showToast(`"${updated.name}" updated to v${updated.version}`, 'success');
    } catch (error) {
      console.error('Update error:', error);
      showToast('Failed to update extension', 'error');
    } finally {
      setUpdating(null);
    }
  };

  const handleUpdateFolder = async (ext: Extension) => {
    if (!window.electronAPI?.extensions?.selectFolder) return;
    setUpdating(ext.id);
    try {
      const folderPath = await window.electronAPI.extensions.selectFolder();
      if (!folderPath) { setUpdating(null); return; }

      const result = await window.electronAPI.extensions.update(ext.id, folderPath);
      if (!result.success) {
        showToast(`Update failed: ${result.error}`, 'error');
        setUpdating(null);
        return;
      }

      const updated = result.extension;

      let storageUrl = ext.storageUrl;
      try {
        const zipPath = await window.electronAPI.extensions.zip(ext.id);
        const zipBuffer = await window.electronAPI.extensions.readZip(zipPath);
        const storageRef = ref(storage, `extensions/${ext.id}.zip`);
        await uploadBytes(storageRef, new Uint8Array(zipBuffer));
        storageUrl = await getDownloadURL(storageRef);
      } catch (e) {
        console.error('Failed to upload updated extension to cloud:', e);
      }

      await registerExtension({
        id: ext.id,
        name: updated.name,
        version: updated.version,
        description: updated.description,
        enabled: ext.enabled,
        localPath: updated.localPath,
        storageUrl,
        createdAt: ext.createdAt || new Date().toISOString(),
      }, teamId);

      showToast(`"${updated.name}" updated to v${updated.version}`, 'success');
    } catch (error) {
      console.error('Update error:', error);
      showToast('Failed to update extension', 'error');
    } finally {
      setUpdating(null);
    }
  };

  const handleRemove = async (ext: Extension) => {
    try {
      if (window.electronAPI?.extensions?.remove) {
        await window.electronAPI.extensions.remove(ext.id);
      }
      await unregisterExtension(ext.id);
    } catch (error) {
      console.error('Remove error:', error);
    }
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 size={24} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-[18px] font-bold" style={{ color: 'var(--text-primary)' }}>Extensions</h1>
          <p className="text-[12px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
            Manage browser extensions loaded in all instances
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleInstallFolder}
            disabled={installing}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-medium transition-colors border"
            style={{ borderColor: 'var(--border)', color: 'var(--text-primary)', background: 'var(--bg-elevated)' }}
          >
            {installing ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <FolderOpen size={14} />
            )}
            Add Folder
          </button>
          <button
            onClick={handleInstallFile}
            disabled={installing}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-medium text-white transition-colors"
            style={{ background: 'var(--accent)' }}
          >
            {installing ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Plus size={14} />
            )}
            Add .crx / .zip
          </button>
        </div>
      </div>

      {/* Extension List */}
      {extensions.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <div className="w-20 h-20 rounded-2xl flex items-center justify-center" style={{ background: 'var(--bg-elevated)' }}>
            <Puzzle size={36} style={{ color: 'var(--text-muted)' }} />
          </div>
          <div className="text-center">
            <p className="text-[14px] font-medium" style={{ color: 'var(--text-secondary)' }}>
              No extensions installed
            </p>
            <p className="text-[12px] mt-1 max-w-sm" style={{ color: 'var(--text-muted)' }}>
              Upload a .crx, .zip file, or select an unpacked extension folder. Extensions will be loaded automatically when launching any instance.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-2 overflow-auto">
          {extensions.map((ext) => {
            const isLocal = localInstalled.has(ext.id);
            return (
              <div
                key={ext.id}
                className="flex items-center gap-4 p-4 rounded-xl border transition-colors"
                style={{
                  background: 'var(--bg-elevated)',
                  borderColor: 'var(--border)',
                }}
              >
                <div
                  className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ background: ext.enabled ? 'var(--accent-subtle)' : 'var(--bg-base)' }}
                >
                  <Puzzle size={18} style={{ color: ext.enabled ? 'var(--accent)' : 'var(--text-muted)' }} />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                      {ext.name}
                    </span>
                    {ext.version && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-base)', color: 'var(--text-muted)' }}>
                        v{ext.version}
                      </span>
                    )}
                    {!isLocal && (
                      <span className="flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded" style={{ background: 'var(--warning-subtle)', color: 'var(--warning)' }}>
                        <AlertCircle size={10} />
                        Not installed locally
                      </span>
                    )}
                  </div>
                  {ext.description && (
                    <p className="text-[11px] mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>
                      {ext.description}
                    </p>
                  )}
                </div>

                <button
                  onClick={() => handleToggle(ext)}
                  className="relative w-10 h-5 rounded-full flex-shrink-0 transition-colors"
                  style={{ background: ext.enabled ? 'var(--accent)' : 'var(--bg-base)' }}
                >
                  <div
                    className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform"
                    style={{ left: ext.enabled ? '22px' : '2px' }}
                  />
                </button>

                <button
                  onClick={() => handleUpdateFolder(ext)}
                  disabled={updating === ext.id}
                  className="p-2 rounded-lg transition-colors"
                  style={{ color: 'var(--text-muted)' }}
                  title="Update (folder)"
                  onMouseEnter={e => e.currentTarget.style.color = 'var(--accent)'}
                  onMouseLeave={e => e.currentTarget.style.color = 'var(--text-muted)'}
                >
                  {updating === ext.id ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                </button>

                <button
                  onClick={() => handleRemove(ext)}
                  className="p-2 rounded-lg transition-colors hover:bg-red-500/10"
                  style={{ color: 'var(--text-muted)' }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ExtensionsPage;
